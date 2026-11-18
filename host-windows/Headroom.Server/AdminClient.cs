using System.Net.Http.Json;
using System.Text.Json;

namespace Headroom.Server;

/// <summary>Someone connected: one of your devices, or a guest you accepted.</summary>
public sealed record ViewerInfo(string Id, string Device, string Address, bool Guest, DateTimeOffset ConnectedAt);

/// <summary>Someone with a guest code, waiting for Accept / Decline.</summary>
public sealed record SupportRequest(string Id, string Name, string Address, string? Country);

public sealed record ServerStatus(
    string HostName, string Version, bool Elevated, bool ServiceInstalled, bool NotifyOnConnect,
    IReadOnlyList<ViewerInfo> Viewers, IReadOnlyList<SupportRequest> SupportRequests, bool SignedIn, bool Online);

/// <summary>Talks to the running engine's loopback-only admin API (the same one the settings window uses).</summary>
public sealed class AdminClient
{
    /// <summary>The engine's settings port (HEADROOM_ADMIN_PORT overrides the default 7080).</summary>
    public static int Port { get; } = int.TryParse(Environment.GetEnvironmentVariable("HEADROOM_ADMIN_PORT"), out var p) ? p : 7080;
    public static string BaseUrl => $"http://127.0.0.1:{Port}";

    private readonly HttpClient _http = new() { BaseAddress = new Uri(BaseUrl), Timeout = TimeSpan.FromSeconds(3) };

    public async Task<ServerStatus?> GetStatusAsync()
    {
        try
        {
            using var doc = JsonDocument.Parse(await _http.GetStringAsync("/api/admin/status"));
            var r = doc.RootElement;
            static string? Str(JsonElement e, string name) =>
                e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            static bool Flag(JsonElement e, string name) =>
                e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

            var viewers = r.GetProperty("sessions").EnumerateArray().Select(s => new ViewerInfo(
                Str(s, "id") ?? "",
                Str(s, "device") ?? "Someone",
                (Str(s, "remoteAddress") ?? "").Replace(" (via relay)", ""),
                Flag(s, "guest"),
                s.TryGetProperty("connectedAt", out var at) && at.TryGetDateTimeOffset(out var since) ? since : DateTimeOffset.UtcNow)).ToList();
            var requests = r.TryGetProperty("support", out var sup) && sup.ValueKind == JsonValueKind.Object
                && sup.TryGetProperty("requests", out var reqs) && reqs.ValueKind == JsonValueKind.Array
                ? reqs.EnumerateArray().Select(q => new SupportRequest(Str(q, "id") ?? "", Str(q, "name") ?? "Someone", Str(q, "address") ?? "", Str(q, "country"))).ToList()
                : new List<SupportRequest>();
            var host = r.GetProperty("host");
            var settings = r.TryGetProperty("settings", out var st) ? st : default;
            return new ServerStatus(
                Str(host, "name") ?? Environment.MachineName,
                Str(host, "version") ?? "",
                Flag(r, "elevated"),
                Flag(r, "serviceInstalled"),
                !(settings.ValueKind == JsonValueKind.Object && settings.TryGetProperty("notifyOnConnect", out var n) && n.ValueKind == JsonValueKind.False),
                viewers,
                requests,
                r.TryGetProperty("account", out var acct) && acct.ValueKind == JsonValueKind.Object,
                r.TryGetProperty("relay", out var rel) && Str(rel, "state") == "online");
        }
        catch
        {
            return null;
        }
    }

    public async Task AnswerSupportAsync(string id, bool accept, bool viewOnly, bool files, bool clipboard)
    {
        try { await _http.PostAsJsonAsync($"/api/admin/support/requests/{id}", new { accept, viewOnly, files, clipboard }); } catch { }
    }

    /// <summary>Ends one session (a guest's for good).</summary>
    public async Task StopAsync(string sessionId)
    {
        try { await _http.PostAsync($"/api/admin/sessions/{Uri.EscapeDataString(sessionId)}/disconnect", null); } catch { }
    }

    public async Task DisconnectAllAsync()
    {
        try { await _http.PostAsync("/api/admin/sessions/disconnect-all", null); } catch { }
    }
}
