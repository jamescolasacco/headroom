using System.Net.Http.Json;
using System.Text.Json;

namespace Headroom.Server;

public sealed record ViewerInfo(string Id, string Device, string Address, DateTimeOffset ConnectedAt);

/// <summary>Someone with a support code, waiting for Accept / Decline.</summary>
public sealed record SupportRequest(string Id, string Name, string Address);

public sealed record ServerStatus(
    string HostName, string Version, bool Elevated, bool ServiceInstalled, bool HasPassword,
    int DeviceCount, IReadOnlyList<ViewerInfo> Viewers, IReadOnlyList<string> Urls, string? Tailscale,
    IReadOnlyList<SupportRequest> SupportRequests, string? RelayId);

/// <summary>Talks to the running engine's loopback-only admin API.</summary>
public sealed class AdminClient
{
    public static int Port { get; } = int.TryParse(Environment.GetEnvironmentVariable("HEADROOM_ADMIN_PORT"), out var p) ? p : 7080;
    public static string BaseUrl => $"http://127.0.0.1:{Port}";

    private readonly HttpClient _http = new() { BaseAddress = new Uri(BaseUrl), Timeout = TimeSpan.FromSeconds(3) };

    public async Task<ServerStatus?> GetStatusAsync()
    {
        try
        {
            using var doc = JsonDocument.Parse(await _http.GetStringAsync("/api/admin/status"));
            var r = doc.RootElement;
            var viewers = r.GetProperty("sessions").EnumerateArray().Select(s => new ViewerInfo(
                s.GetProperty("id").GetString() ?? "",
                s.TryGetProperty("device", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString()! : "Viewer",
                s.GetProperty("remoteAddress").GetString() ?? "",
                s.GetProperty("connectedAt").GetDateTimeOffset())).ToList();
            return new ServerStatus(
                r.GetProperty("host").GetProperty("name").GetString() ?? Environment.MachineName,
                r.GetProperty("host").GetProperty("version").GetString() ?? "",
                r.GetProperty("elevated").GetBoolean(),
                r.TryGetProperty("serviceInstalled", out var si) && si.GetBoolean(),
                r.GetProperty("hasPassword").GetBoolean(),
                r.GetProperty("devices").GetArrayLength(),
                viewers,
                r.GetProperty("urls").EnumerateArray().Select(u => u.GetString() ?? "").ToList(),
                r.TryGetProperty("tailscale", out var ts) && ts.ValueKind == JsonValueKind.String ? ts.GetString() : null,
                r.TryGetProperty("support", out var sup) && sup.TryGetProperty("requests", out var reqs) && reqs.ValueKind == JsonValueKind.Array
                    ? reqs.EnumerateArray().Select(q => new SupportRequest(
                        q.GetProperty("id").GetString() ?? "",
                        q.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString()! : "Someone",
                        q.TryGetProperty("address", out var a) && a.ValueKind == JsonValueKind.String ? a.GetString()! : "")).ToList()
                    : new List<SupportRequest>(),
                r.TryGetProperty("relay", out var rel) && rel.TryGetProperty("state", out var rs) && rs.GetString() == "online"
                    && rel.TryGetProperty("id", out var rid) && rid.ValueKind == JsonValueKind.String ? rid.GetString() : null);
        }
        catch
        {
            return null;
        }
    }

    public async Task AnswerSupportAsync(string id, bool accept, bool viewOnly)
    {
        try { await _http.PostAsJsonAsync($"/api/admin/support/requests/{id}", new { accept, viewOnly }); } catch { }
    }

    public async Task DisconnectAllAsync()
    {
        try { await _http.PostAsync("/api/admin/sessions/disconnect-all", null); } catch { }
    }

    public async Task<string?> CreatePairCodeAsync()
    {
        try
        {
            var r = await _http.PostAsync("/api/admin/paircode", null);
            var j = await r.Content.ReadFromJsonAsync<JsonElement>();
            return j.GetProperty("code").GetString();
        }
        catch { return null; }
    }
}
