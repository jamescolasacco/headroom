using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Headroom.Host.Config;
using Headroom.Host.Util;

namespace Headroom.Host.Services;

/// <summary>
/// Keeps this PC reachable through its account server's relay (docs/RELAY.md): browsers anywhere open
/// https://&lt;account server&gt;/r/&lt;Headroom ID&gt;/… without port forwarding, Tailscale or a certificate install.
///
/// A control WebSocket stays open to the relay. When a viewer arrives, the relay sends {"t":"open","id":…}; this PC
/// opens a tunnel WebSocket and pipes its binary messages to and from a private loopback-only Kestrel port
/// (<see cref="LocalPort"/>). The web host treats connections on that port as relayed: never local, only session
/// paths, the viewer's address taken from the relay's X-Headroom-Client header. Same protocol as the Mac host.
/// </summary>
public sealed class RelayService
{
    public static RelayService Shared { get; } = new();

    /// <summary>The loopback port where tunnels are delivered (0 until the web host has started).</summary>
    public static int LocalPort { get; private set; }

    private readonly object _gate = new();
    private int _generation;
    private string? _target;          // account server + credential of the current control connection
    private ClientWebSocket? _control;
    private string _state = "off";    // off | connecting | online | retrying
    private string? _relayId;
    private string? _lastError;
    private TimeSpan _backoff = TimeSpan.FromSeconds(1);
    private DateTime _nextAttempt = DateTime.MinValue;
    private Timer? _timer;

    public void Start(int localPort)
    {
        LocalPort = localPort;
        _timer = new Timer(_ => Tick(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    }

    private sealed record Target(Uri Base, string Token)
    {
        public string Key => Base.AbsoluteUri + "|" + Token;
    }

    private static Target? Wanted()
    {
        var c = ConfigStore.Current;
        if (!c.RelayEnabled || c.Account is not { } link) return null;
        if (!Uri.TryCreate(link.Server, UriKind.Absolute, out var u) || u.Scheme is not ("http" or "https")) return null;
        return new Target(u, link.Token);
    }

    private void Tick()
    {
        try
        {
            if (LocalPort == 0) return;
            var want = Wanted();
            ClientWebSocket? toClose = null;
            bool connectNow = false;
            int gen = 0;
            lock (_gate)
            {
                if (_target != null && _target != want?.Key)
                {
                    // Left the account, joined another, or turned the relay off.
                    _generation++;
                    toClose = _control;
                    _target = null; _control = null; _relayId = null; _lastError = null;
                    _backoff = TimeSpan.FromSeconds(1); _nextAttempt = DateTime.MinValue;
                    _state = want == null ? "off" : "connecting";
                }
                else if (want == null) _state = "off";
                else if (_target == null && DateTime.UtcNow >= _nextAttempt)
                {
                    gen = ++_generation;
                    _target = want.Key;
                    if (_state != "retrying") _state = "connecting";
                    connectNow = true;
                }
            }
            toClose?.Abort();
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
        ws.Options.SetRequestHeader("Authorization", "Bearer " + t.Token);
        ws.Options.SetRequestHeader("X-Headroom-Host-Id", HostInfo.HostId);
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
                        _state = "online";
                        _lastError = null;
                        _backoff = TimeSpan.FromSeconds(1);
                    }
                    if (first) Log.Info("relay", $"reachable through the relay at {b.AbsoluteUri} as Headroom ID {Pretty(_relayId)}");
                    break;
                case "open":
                    var nonce = Str("id");
                    if (nonce is { Length: > 0 and <= 64 } && nonce.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_'))
                        _ = TunnelAsync(b, nonce);
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
        lock (_gate)
        {
            if (gen != _generation) return;
            var wasOnline = _state == "online";
            _target = null;
            _control = null;
            wait = _backoff;
            if (status is >= 400 and < 600)
            {
                // Rejected: removed from the account (it notices at its next check-in) or no relay on that server.
                wait = TimeSpan.FromSeconds(status == 404 ? 300 : 60);
                _lastError = status == 404 ? "This account server doesn't run a relay." : $"The relay refused this PC (HTTP {status}).";
            }
            else _lastError = error != null ? $"Can't reach the relay ({error})." : "Connection to the relay closed.";
            _state = "retrying";
            _nextAttempt = DateTime.UtcNow + wait;
            _backoff = TimeSpan.FromSeconds(Math.Min(_backoff.TotalSeconds * 2, 30));
            message = _lastError;
            log = wasOnline || _backoff.TotalSeconds <= 2;
        }
        if (log) Log.Warn("relay", $"{message} Retrying in {wait.TotalSeconds:0} s.");
    }

    // ---------------------------------------------------------------- tunnels

    /// <summary>One viewer connection: the relay's tunnel WebSocket, piped to the private loopback port.</summary>
    private static async Task TunnelAsync(Uri b, string nonce)
    {
        using var ws = new ClientWebSocket();
        using var tcp = new TcpClient { NoDelay = true };
        using var cts = new CancellationTokenSource();
        try
        {
            using (var connect = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
            {
                await ws.ConnectAsync(Endpoint(b, "/api/relay/tunnel/" + nonce), connect.Token);
                await tcp.ConnectAsync(IPAddress.Loopback, LocalPort, connect.Token);
            }
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
        }
    }

    // ---------------------------------------------------------------- status

    public object Status
    {
        get
        {
            var c = ConfigStore.Current;
            lock (_gate)
            {
                var server = c.Account?.Server;
                return new
                {
                    enabled = c.RelayEnabled,
                    state = _state,
                    server,
                    id = _relayId,
                    url = server != null && _relayId != null ? server.TrimEnd('/') + "/#id=" + _relayId : null,
                    error = _state == "online" ? null : _lastError,
                };
            }
        }
    }

    public string? CurrentId
    {
        get { lock (_gate) return _state == "online" ? _relayId : null; }
    }

    public string? CurrentUrl
    {
        get
        {
            var server = ConfigStore.Current.Account?.Server;
            lock (_gate) return server != null && _relayId != null ? server.TrimEnd('/') + "/#id=" + _relayId : null;
        }
    }

    private static string Pretty(string? id) => id is { Length: 9 } ? $"{id[..3]} {id[3..6]} {id[6..]}" : id ?? "?";
}
