using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Headroom.Host.Config;
using Headroom.Host.Security;
using Headroom.Host.Util;
using Headroom.Host.Web;

namespace Headroom.Host.Services;

/// <summary>
/// Membership in a Headroom account (account-server/, docs/ACCOUNTS.md). When joined, this computer checks in
/// every ~20 s with how to reach it (addresses, certificate pin, CA) and receives the account's devices as
/// (id, name, token hash, view-only). Those devices then connect exactly like paired ones — the token each
/// presents was derived for this computer alone — without any pairing here.
///
/// The device list is cached in the config, so a short account-server outage doesn't lock anyone out; a device
/// removed from the account disappears at the next successful check-in and its sessions are closed.
/// Same protocol and config schema as the Mac host's AccountService.
/// </summary>
public sealed class AccountService
{
    public static AccountService Shared { get; } = new();

    private readonly object _gate = new();
    private readonly object _syncGate = new();
    private List<AccountDevice> _devices = new();
    private DateTimeOffset? _lastSync;
    private DateTime _lastAttempt = DateTime.MinValue;
    private string? _lastError;
    private TimeSpan _interval = TimeSpan.FromSeconds(20);
    private Timer? _timer;
    private CertificateManager? _certs;

    private static readonly HttpClient Http = new(new SocketsHttpHandler { ConnectTimeout = TimeSpan.FromSeconds(8) })
    {
        Timeout = TimeSpan.FromSeconds(12),
    };

    public bool Linked => ConfigStore.Current.Account != null;

    public void Start(CertificateManager certs)
    {
        _certs = certs;
        lock (_gate) _devices = ConfigStore.Current.Account?.Devices.ToList() ?? new();
        _timer = new Timer(_ => TickIfDue(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    }

    private void TickIfDue()
    {
        try
        {
            if (!Linked) return;
            bool due;
            lock (_gate) due = DateTime.UtcNow - _lastAttempt >= _interval;
            if (due) Sync();
        }
        catch (Exception ex)
        {
            // Never let a timer callback throw: that would end the process.
            Log.Error("account", "check-in failed", ex);
        }
    }

    /// <summary>The account device presenting this token hash, if any.</summary>
    public AccountDevice? DeviceForHash(string hash)
    {
        var h = Encoding.ASCII.GetBytes(hash);
        AccountDevice? match = null;
        lock (_gate)
            foreach (var d in _devices)
                if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(d.TokenHash), h)) match = d;
        return match;
    }

    public AccountDevice? Device(string id)
    {
        lock (_gate) return _devices.FirstOrDefault(d => d.Id == id);
    }

    /// <summary>
    /// For an unknown token: maybe it belongs to a device that signed in to the account seconds ago, so check in
    /// now rather than at the next scheduled time. Unknown tokens cause at most one check-in every 3 s: a request
    /// waits for that window instead of failing, and shares a check-in that started after it asked.
    /// </summary>
    public bool RefreshForUnknownToken()
    {
        if (!Linked) return false;
        var asked = DateTime.UtcNow;
        TimeSpan wait;
        lock (_gate) wait = TimeSpan.FromSeconds(3) - (asked - _lastAttempt);
        if (wait > TimeSpan.Zero) Thread.Sleep(wait < TimeSpan.FromSeconds(3) ? wait : TimeSpan.FromSeconds(3));
        return Sync(asked);
    }

    // ---------------------------------------------------------------- check-in

    /// <summary>One check-in (blocking, ≤ ~12 s). Returns true if the device list was refreshed.</summary>
    public bool Sync() => Sync(null);

    /// <summary>With <paramref name="asked"/>: if a check-in started after that moment (and so has finished, once
    /// we hold the lock), its result is as fresh as a new one would be.</summary>
    private bool Sync(DateTime? asked)
    {
        lock (_syncGate)
        {
            if (asked != null)
            {
                DateTime started;
                bool succeeded;
                lock (_gate) { started = _lastAttempt; succeeded = _lastSync != null && _lastSync.Value.UtcDateTime >= _lastAttempt; }
                if (started > asked.Value) return succeeded;
            }
            var link = ConfigStore.Current.Account;
            if (link == null) return false;
            lock (_gate) _lastAttempt = DateTime.UtcNow;
            var (status, body, err) = Send(HttpMethod.Post, link.Server + "/api/computer/heartbeat", CheckInBody(), link.Token);
            if (status == 401)
            {
                // This computer was removed from the account (or the account deleted).
                Log.Warn("account", $"this computer was removed from the account '{link.Username}'; leaving it");
                Unlink("removed from the account");
                return false;
            }
            if (status != 200 || body == null || body["devices"] is not JsonArray list)
            {
                var msg = err ?? $"account server answered {status}";
                bool first;
                lock (_gate) { first = _lastError != msg; _lastError = msg; }
                if (first) Log.Warn("account", $"check-in failed: {msg}");
                return false;
            }
            var fresh = new List<AccountDevice>();
            foreach (var n in list)
            {
                if (n is not JsonObject d || Str(d["id"]) is not { } id || Str(d["tokenHash"]) is not { } hash) continue;
                fresh.Add(new AccountDevice { Id = id, Name = Str(d["name"]) ?? "Device", TokenHash = hash, ViewOnly = Bool(d["viewOnly"]) });
            }
            if (body["interval"] is JsonValue iv && iv.TryGetValue<int>(out var secs) && secs >= 5)
                _interval = TimeSpan.FromSeconds(Math.Min(secs, 300));
            List<AccountDevice> old;
            bool hadError;
            lock (_gate)
            {
                old = _devices;
                _devices = fresh;
                _lastSync = DateTimeOffset.UtcNow;
                hadError = _lastError != null;
                _lastError = null;
            }
            if (hadError) Log.Info("account", "check-in works again");
            if (!old.SequenceEqual(fresh))
            {
                ConfigStore.Update(c => { if (c.Account != null) c.Account.Devices = fresh.ToList(); });
                // Removed devices, and devices that just became view-only, are disconnected (they reconnect view-only).
                var byId = fresh.ToDictionary(d => d.Id);
                foreach (var d in old)
                {
                    if (!byId.TryGetValue(d.Id, out var now) || (now.ViewOnly && !d.ViewOnly) || now.TokenHash != d.TokenHash)
                        SessionManager.DisconnectDevice(LocalId(d.Id));
                }
            }
            return true;
        }
    }

    private JsonObject CheckInBody()
    {
        var o = new JsonObject
        {
            ["hostId"] = HostInfo.HostId,
            ["name"] = HostInfo.Name,
            ["os"] = "windows",
            ["osVersion"] = Environment.OSVersion.Version.ToString(),
            ["version"] = HostInfo.Version,
        };
        if (_certs != null)
        {
            o["urls"] = new JsonArray(WebHost.ServerUrls(_certs).Select(u => (JsonNode?)JsonValue.Create(u)).ToArray());
            o["tailscale"] = _certs.TailscaleName;
            o["spki"] = _certs.ServerSpkiPin;
            o["fingerprint"] = _certs.ServerKeyFingerprint;
            o["ca"] = Convert.ToBase64String(_certs.CaCertificate.RawData);
        }
        return o;
    }

    // ---------------------------------------------------------------- join / leave

    public static string? NormalizeServer(string? s)
    {
        var t = (s ?? "").Trim();
        if (t.Length == 0) return null;
        if (!t.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !t.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) t = "https://" + t;
        if (!Uri.TryCreate(t, UriKind.Absolute, out var u) || u.Scheme is not ("http" or "https") || u.Host.Length == 0) return null;
        var path = u.AbsolutePath.TrimEnd('/');
        return $"{u.Scheme}://{(u.HostNameType == UriHostNameType.IPv6 ? $"[{u.DnsSafeHost}]" : u.Host)}{(u.IsDefaultPort ? "" : $":{u.Port}")}{path}";
    }

    /// <summary>Signs this computer in to an account (it gets its own credential there; the password isn't stored).</summary>
    public (bool ok, string? username, string? error, string? message) Join(string? server, string? username, string? password, string? totp)
    {
        var baseUrl = NormalizeServer(server);
        if (baseUrl == null) return (false, null, "bad-server", "Enter the account server's address.");
        var (status, body, err) = Send(HttpMethod.Post, baseUrl + "/api/account/login", new JsonObject
        {
            ["username"] = username ?? "",
            ["password"] = password ?? "",
            ["totp"] = string.IsNullOrWhiteSpace(totp) ? null : totp.Trim(),
            ["deviceName"] = HostInfo.Name,
            ["platform"] = "windows",
            ["kind"] = "computer",
        }, null);
        if (err != null) return (false, null, "unreachable", $"Can't reach the account server ({err}).");
        if (status != 200 || Str(body?["token"]) is not { } token || body?["account"] is not JsonObject account || body["device"] is not JsonObject device)
            return (false, null, Str(body?["error"]) ?? $"HTTP {status}", Str(body?["message"]));
        // Leaving a previous account first keeps it tidy (best effort).
        if (ConfigStore.Current.Account != null) Leave();
        var name = Str(account["username"]) ?? username ?? "";
        ConfigStore.Update(c => c.Account = new AccountLink
        {
            Server = baseUrl,
            Username = name,
            AccountId = Str(account["id"]) ?? "",
            DeviceId = Str(device["id"]) ?? "",
            Token = token,
        });
        lock (_gate) { _devices = new(); _lastError = null; _lastAttempt = DateTime.MinValue; }
        Log.Info("account", $"joined account '{name}' at {baseUrl}");
        Sync();
        return (true, name, null, null);
    }

    public void Leave()
    {
        var link = ConfigStore.Current.Account;
        if (link == null) return;
        Send(HttpMethod.Post, link.Server + "/api/account/logout", null, link.Token);
        Unlink("left the account");
    }

    private void Unlink(string reason)
    {
        List<AccountDevice> old;
        lock (_gate)
        {
            old = _devices;
            _devices = new();
            _lastSync = null;
            _lastError = null;
        }
        ConfigStore.Update(c => c.Account = null);
        foreach (var d in old) SessionManager.DisconnectDevice(LocalId(d.Id));
        Log.Info("account", $"account link removed ({reason})");
    }

    /// <summary>How account devices are named among this computer's devices and sessions.</summary>
    public static string LocalId(string id) => "account:" + id;

    // ---------------------------------------------------------------- status

    public object? Status
    {
        get
        {
            var link = ConfigStore.Current.Account;
            if (link == null) return null;
            lock (_gate)
                return new
                {
                    server = link.Server,
                    username = link.Username,
                    lastSync = _lastSync,
                    error = _lastError,
                    devices = _devices.Select(d => new { id = LocalId(d.Id), name = d.Name, viewOnly = d.ViewOnly }).ToList(),
                };
        }
    }

    // ---------------------------------------------------------------- http

    private static string? Str(JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
    private static bool Bool(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    private static (int status, JsonObject? body, string? error) Send(HttpMethod method, string url, JsonObject? body, string? bearer)
    {
        try
        {
            using var req = new HttpRequestMessage(method, url);
            if (bearer != null) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
            if (body != null) req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            using var resp = Http.Send(req);
            using var stream = resp.Content.ReadAsStream();
            JsonObject? json = null;
            try { json = JsonNode.Parse(stream) as JsonObject; } catch (JsonException) { }
            return ((int)resp.StatusCode, json, null);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException or IOException)
        {
            return (0, null, ex is HttpRequestException h && h.InnerException != null ? h.InnerException.Message : ex.Message);
        }
    }
}
