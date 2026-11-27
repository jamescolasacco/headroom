using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text.Json;
using Headroom.Host.Config;
using Headroom.Host.Security;
using Headroom.Host.Util;

namespace Headroom.Host.Services;

/// <summary>
/// Keeps this PC reachable through the Headroom relay (docs/RELAY.md), always: signed in to an account, your devices
/// reach it from anywhere; signed in or not, a guest code finds it. No port forwarding, no setup.
///
/// A control WebSocket stays open to the relay. When a viewer arrives, the relay sends {"t":"open","id":…} (with the
/// viewer's address, country, and whether they came with a guest code); this PC opens a tunnel WebSocket and pipes
/// its binary messages to and from a private loopback-only Kestrel port (<see cref="LocalPort"/>). The web host
/// treats connections on that port as relayed: never local, only session paths, with the viewer's address, country
/// and guest flag from the relay's X-Headroom-* headers and the "open" message (<see cref="Tunnel"/>). Same protocol
/// as the Mac host.
/// </summary>
public sealed class RelayService
{
    public static RelayService Shared { get; } = new();

    /// <summary>The loopback port where tunnels are delivered (0 until the web host has started).</summary>
    public static int LocalPort { get; private set; }

    /// <summary>A guest code's first 4 digits, from the relay, and until when they route here.</summary>
    public sealed record Slot(string Digits, DateTime Expires);

    /// <summary>
    /// Who a tunnel is for, as the relay's "open" message described them. Loopback: the tunnel's end of the loopback hop
    /// (a session with audio priority keeps its receive buffer small).
    /// </summary>
    public sealed record TunnelInfo(string? Ip, string? Country, bool Guest, Socket? Loopback = null);

    /// <summary>Open tunnels by the local port of their loopback connection (= the relay listener's remote port).</summary>
    private static readonly ConcurrentDictionary<int, TunnelInfo> Tunnels = new();

    private readonly object _gate = new();
    private int _generation;
    private string? _target;          // relay + credential of the current control connection
    private ClientWebSocket? _control;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly Dictionary<string, TaskCompletionSource<(Slot?, string?)>> _slotWaiters = new();
    private string _state = "off";    // off | connecting | online | retrying
    private string? _relayId;
    /// <summary>Not signed in, this PC gets a fresh relay id each time it connects, and a key to keep it with: presented
    /// when it connects again (a network change, a moment asleep), the relay gives the same id back, so a guest it
    /// accepted (whose session continues at that id) can come back. Relays that don't do this ignore it.</summary>
    private (string Id, string Key)? _keep;
    private string? _lastError;
    private TimeSpan _backoff = TimeSpan.FromSeconds(1);
    private DateTime _nextAttempt = DateTime.MinValue;
    /// <summary>
    /// What the last attempt was for (relay and credential): a wait after a refusal applies to that credential only.
    /// Signed out because the account removed this PC, or signed in again, it connects at once.
    /// </summary>
    private string? _attemptKey;
    private Timer? _timer;

    public void Start(int localPort)
    {
        LocalPort = localPort;
        _timer = new Timer(_ => Tick(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    }

    /// <param name="Token">This PC's sign-in to its account; null when it isn't signed in (then only guest codes reach it).</param>
    private sealed record Target(Uri Base, string? Token)
    {
        public string Key => Base.AbsoluteUri + "|" + (Token ?? "-");
    }

    private static Target? Wanted()
    {
        if (ServerSwitch.Shared.Stopped) return null; // "Stop server": offline until it's started again
        var c = ConfigStore.Current;
        var server = c.Account?.Server ?? c.Server;
        if (!Uri.TryCreate(server, UriKind.Absolute, out var u) || u.Scheme is not ("http" or "https") || u.Host.Length == 0) return null;
        return new Target(u, c.Account?.Token);
    }

    private void Tick()
    {
        try
        {
            if (LocalPort == 0) return;
            var want = Wanted();
            ClientWebSocket? toClose = null;
            bool connectNow = false, switched = false;
            int gen = 0;
            List<TaskCompletionSource<(Slot?, string?)>> waiters = new();
            lock (_gate)
            {
                if (_target != null && _target != want?.Key)
                {
                    // Signed in, signed out, or another server in the settings.
                    _generation++;
                    toClose = _control;
                    _target = null; _control = null; _relayId = null; _lastError = null;
                    _backoff = TimeSpan.FromSeconds(1); _nextAttempt = DateTime.MinValue;
                    _state = want == null ? "off" : "connecting";
                    waiters = TakeWaiters();
                    switched = true;
                }
                else if (want == null) _state = "off";
                else if (_target == null && (DateTime.UtcNow >= _nextAttempt || want.Key != _attemptKey))
                {
                    gen = ++_generation;
                    _target = want.Key;
                    _attemptKey = want.Key;
                    if (_state != "retrying") _state = "connecting";
                    connectNow = true;
                }
            }
            toClose?.Abort();
            if (switched)
            {
                SupportService.Shared.RelayDropped();
                foreach (var w in waiters) w.TrySetResult((null, Offline(null)));
            }
            if (connectNow) _ = RunControlAsync(want!, gen);
        }
        catch (Exception ex)
        {
            Log.Error("relay", "relay tick failed", ex); // a timer callback must never throw
        }
    }

    private static Uri Endpoint(Uri b, string path)
    {
        var ub = new UriBuilder(b) { Scheme = b.Scheme == "https" ? "wss" : "ws", Port = b.IsDefaultPort ? -1 : b.Port };
        ub.Path = b.AbsolutePath.TrimEnd('/') + path;
        return ub.Uri;
    }

    // ---------------------------------------------------------------- control connection

    private async Task RunControlAsync(Target t, int gen)
    {
        var ws = new ClientWebSocket();
        (string Id, string Key)? keep;
        lock (_gate) keep = _keep;
        if (t.Token != null) ws.Options.SetRequestHeader("Authorization", "Bearer " + t.Token);
        else if (keep is { } k)
        {
            ws.Options.SetRequestHeader("X-Headroom-Relay-Id", k.Id);
            ws.Options.SetRequestHeader("X-Headroom-Relay-Key", k.Key);
        }
        ws.Options.SetRequestHeader("X-Headroom-Host-Id", HostInfo.HostId);
        ws.Options.SetRequestHeader("X-Headroom-Name", HeaderSafe(HostInfo.Name));
        ws.Options.CollectHttpResponseDetails = true;
        // The relay pings every 25 s too; this side's pings notice a dead path (sleep, network change) on their own.
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(25);
        ws.Options.KeepAliveTimeout = TimeSpan.FromSeconds(30);
        string? error = null;
        int status = 0;
        try
        {
            using (var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15)))
                await ws.ConnectAsync(Endpoint(t.Base, "/api/relay/control"), cts.Token);
            lock (_gate)
            {
                if (gen != _generation) { ws.Abort(); return; }
                _control = ws;
            }
            var buf = new byte[64 * 1024];
            using var msg = new MemoryStream();
            while (ws.State == WebSocketState.Open)
            {
                var r = await ws.ReceiveAsync(buf, CancellationToken.None);
                if (r.MessageType == WebSocketMessageType.Close) break;
                msg.Write(buf, 0, r.Count);
                if (!r.EndOfMessage) continue;
                if (r.MessageType == WebSocketMessageType.Text) OnControl(msg.ToArray(), t.Base, gen);
                msg.SetLength(0);
            }
        }
        catch (WebSocketException ex)
        {
            status = (int)ws.HttpStatusCode;
            error = status is >= 400 and < 600 ? null : ex.Message;
        }
        catch (Exception ex) when (ex is OperationCanceledException or IOException or HttpRequestException or SocketException)
        {
            error = ex.Message;
        }
        finally
        {
            ws.Dispose();
        }
        Dropped(gen, status, error);
    }

    private void OnControl(byte[] json, Uri b, int gen)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            string? Str(string n) => root.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            switch (Str("t"))
            {
                case "hello":
                    bool first;
                    lock (_gate)
                    {
                        if (gen != _generation) return;
                        first = _relayId != Str("relayId") || _state != "online";
                        _relayId = Str("relayId");
                        if (_relayId is { } kid && Str("key") is { } key && RelayToken(kid, 9, 24) && RelayToken(key, 16, 64)) _keep = (kid, key);
                        _state = "online";
                        _lastError = null;
                        _backoff = TimeSpan.FromSeconds(1);
                    }
                    if (first) Log.Info("relay", $"connected to {b.Host}{(ConfigStore.Current.Account == null ? " (not signed in: reachable with guest codes)" : "")}");
                    break;
                case "open":
                    var nonce = Str("id");
                    if (nonce is { Length: > 0 and <= 64 } && nonce.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_'))
                    {
                        var ip = Str("client") is { Length: <= 64 } client && IPAddress.TryParse(client, out var parsed) ? parsed.ToString() : null;
                        var guest = root.TryGetProperty("guest", out var g) && g.ValueKind == JsonValueKind.True;
                        _ = TunnelAsync(b, nonce, new TunnelInfo(ip, CountryCode(Str("country")), guest));
                    }
                    break;
                case "slot":
                    var id = Str("id");
                    if (id == null) break;
                    TaskCompletionSource<(Slot?, string?)>? waiter;
                    lock (_gate) _slotWaiters.Remove(id, out waiter);
                    if (Str("slot") is { Length: 4 } digits && digits.All(char.IsAsciiDigit))
                    {
                        var expires = DateTimeOffset.TryParse(Str("expires"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var e)
                            ? e.UtcDateTime : DateTime.UtcNow + TimeSpan.FromMinutes(10);
                        waiter?.TrySetResult((new Slot(digits, expires), null));
                    }
                    else waiter?.TrySetResult((null, "Headroom is busy right now. Try again in a minute."));
                    break;
            }
        }
        catch (JsonException) { }
    }

    private void Dropped(int gen, int status, string? error)
    {
        string message;
        TimeSpan wait;
        bool log;
        List<TaskCompletionSource<(Slot?, string?)>> waiters;
        lock (_gate)
        {
            if (gen != _generation) return;
            var wasOnline = _state == "online";
            _target = null;
            _control = null;
            _relayId = null;
            waiters = TakeWaiters();
            wait = _backoff;
            if (status is >= 400 and < 600)
            {
                // Rejected: removed from the account (it notices at its next check-in), too many computers from this
                // network without an account, or no relay on that server.
                wait = TimeSpan.FromSeconds(status == 404 ? 300 : 60);
                _lastError = status switch
                {
                    404 => "This server doesn't run a relay.",
                    429 => "Too many computers from this network are connected without an account.",
                    _ => $"The relay refused this PC (HTTP {status}).",
                };
            }
            else _lastError = error != null ? $"Can't reach the relay ({error})." : "Connection to the relay closed.";
            _state = "retrying";
            _nextAttempt = DateTime.UtcNow + wait;
            _backoff = TimeSpan.FromSeconds(Math.Min(_backoff.TotalSeconds * 2, 30));
            message = _lastError;
            log = wasOnline || _backoff.TotalSeconds <= 2;
        }
        SupportService.Shared.RelayDropped();
        foreach (var w in waiters) w.TrySetResult((null, Offline(message)));
        if (log) Log.Warn("relay", $"{message} Retrying in {wait.TotalSeconds:0} s.");
        // 401: this PC's sign-in is gone (removed from the account, or the account deleted). Check in now to find out,
        // instead of at the next check-in: signed out, it's back on the relay for guest codes at once.
        if (status == 401) _ = Task.Run(() => AccountService.Shared.Sync());
    }

    private List<TaskCompletionSource<(Slot?, string?)>> TakeWaiters() // under lock
    {
        var w = _slotWaiters.Values.ToList();
        _slotWaiters.Clear();
        return w;
    }

    private static string Offline(string? why) =>
        $"This PC isn't connected to Headroom right now{(why != null ? $" ({why.TrimEnd('.')})" : "")}. Check the internet connection and try again.";

    // ---------------------------------------------------------------- guest codes

    /// <summary>Asks the relay for the first 4 digits of a guest code (a "slot" that routes /c/&lt;slot&gt;/ here), or says why not.</summary>
    public async Task<(Slot? Slot, string? Error)> RequestSlotAsync()
    {
        var id = AuthService.Base64Url(RandomNumberGenerator.GetBytes(6));
        var waiter = new TaskCompletionSource<(Slot?, string?)>(TaskCreationOptions.RunContinuationsAsynchronously);
        ClientWebSocket? ws;
        lock (_gate)
        {
            ws = _state == "online" ? _control : null;
            if (ws == null) return (null, Offline(_lastError));
            _slotWaiters[id] = waiter;
        }
        if (!await SendAsync(ws, new { t = "slot", id }))
        {
            lock (_gate) _slotWaiters.Remove(id);
            return (null, Offline(null));
        }
        var done = await Task.WhenAny(waiter.Task, Task.Delay(TimeSpan.FromSeconds(10)));
        lock (_gate) _slotWaiters.Remove(id);
        return done == waiter.Task ? waiter.Task.Result : (null, "Headroom didn't answer. Try again.");
    }

    /// <summary>The code was used, cancelled or withdrawn: the relay stops routing it here.</summary>
    public void ReleaseSlot()
    {
        ClientWebSocket? ws;
        lock (_gate) ws = _control;
        if (ws != null) _ = SendAsync(ws, new { t = "slot-release" });
    }

    /// <summary>One message on the control connection (sends never overlap; a failed send ends the connection).</summary>
    private async Task<bool> SendAsync(ClientWebSocket ws, object message)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        await _sendLock.WaitAsync();
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await ws.SendAsync(bytes, WebSocketMessageType.Text, true, cts.Token);
            return true;
        }
        catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or OperationCanceledException or IOException or InvalidOperationException)
        {
            return false;
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <summary>Where an accepted guest's session continues (its code is used up): this PC's own path on the relay.</summary>
    public string? RelayPath
    {
        get { lock (_gate) return _state == "online" && _relayId != null ? "/r/" + _relayId : null; }
    }

    /// <summary>The Headroom website people open (for guest links), without a trailing slash.</summary>
    public string PublicBase
    {
        get
        {
            var c = ConfigStore.Current;
            return (c.Account?.Server ?? c.Server).TrimEnd('/');
        }
    }

    // ---------------------------------------------------------------- tunnels

    /// <summary>Who the relay said a connection on the relay listener is for (by that connection's remote port).</summary>
    public static TunnelInfo? Tunnel(int remotePort) => Tunnels.TryGetValue(remotePort, out var t) ? t : null;

    /// <summary>One viewer connection: the relay's tunnel WebSocket, piped to the private loopback port.</summary>
    private static async Task TunnelAsync(Uri b, string nonce, TunnelInfo who)
    {
        using var ws = new ClientWebSocket();
        using var tcp = new TcpClient { NoDelay = true };
        using var cts = new CancellationTokenSource();
        int localPort = 0;
        try
        {
            using (var connect = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
            {
                await ws.ConnectAsync(Endpoint(b, "/api/relay/tunnel/" + nonce), connect.Token);
                await tcp.ConnectAsync(IPAddress.Loopback, LocalPort, connect.Token);
            }
            // Registered before any of the viewer's bytes are passed on, so the web host always finds it.
            localPort = (tcp.Client.LocalEndPoint as IPEndPoint)?.Port ?? 0;
            if (localPort != 0) Tunnels[localPort] = who with { Loopback = tcp.Client };
            var stream = tcp.GetStream();
            var fromRelay = Task.Run(async () =>
            {
                var buf = new byte[64 * 1024];
                while (true)
                {
                    var r = await ws.ReceiveAsync(buf, cts.Token);
                    if (r.MessageType == WebSocketMessageType.Close) break;
                    if (r.MessageType == WebSocketMessageType.Binary && r.Count > 0) await stream.WriteAsync(buf.AsMemory(0, r.Count), cts.Token);
                }
                tcp.Client.Shutdown(SocketShutdown.Send);
            });
            var toRelay = Task.Run(async () =>
            {
                var buf = new byte[64 * 1024];
                int n;
                while ((n = await stream.ReadAsync(buf, cts.Token)) > 0)
                    await ws.SendAsync(buf.AsMemory(0, n), WebSocketMessageType.Binary, true, cts.Token);
                if (ws.State == WebSocketState.Open) await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
            });
            await Task.WhenAny(fromRelay, toRelay);
            // Let the other direction finish briefly (the last bytes of a response), then tear down.
            await Task.WhenAny(Task.WhenAll(fromRelay, toRelay), Task.Delay(TimeSpan.FromSeconds(5)));
        }
        catch (Exception ex) when (ex is WebSocketException or IOException or SocketException or OperationCanceledException or HttpRequestException)
        {
            Log.Debug("relay", $"tunnel ended: {ex.Message}");
        }
        finally
        {
            cts.Cancel();
            if (localPort != 0) Tunnels.TryRemove(localPort, out _);
        }
    }

    /// <summary>A country code as the relay sends it ("US"), or null.</summary>
    public static string? CountryCode(string? s) =>
        s is { Length: > 0 and <= 8 } && s.All(char.IsAsciiLetter) ? s.ToUpperInvariant() : null;

    /// <summary>A relay id or key as the relay makes them (base64url), safe to send back as a header.</summary>
    private static bool RelayToken(string s, int min, int max) =>
        s.Length >= min && s.Length <= max && s.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_');

    /// <summary>Header values must be plain ASCII (the relay only shows the name in its log).</summary>
    private static string HeaderSafe(string s)
    {
        var t = new string(s.Select(ch => ch is >= ' ' and <= '~' ? ch : '?').ToArray()).Trim();
        return t.Length == 0 ? "PC" : t[..Math.Min(64, t.Length)];
    }

    // ---------------------------------------------------------------- status

    public object Status
    {
        get
        {
            var site = PublicBase;
            lock (_gate) return new { state = _state, site, error = _state == "online" ? null : _lastError };
        }
    }
}
