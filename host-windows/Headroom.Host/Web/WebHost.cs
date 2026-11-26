using System.Net;
using System.Text.Json;
using Headroom.Host.Config;
using Headroom.Host.Security;
using Headroom.Host.Services;
using Headroom.Host.Session;
using Headroom.Host.Util;
using Microsoft.AspNetCore.Connections.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.AspNetCore.Server.Kestrel.Https;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

namespace Headroom.Host.Web;

public static class WebHost
{
    public static WebApplication Build(CertificateManager certs, string[] args)
    {
        var cfg = ConfigStore.Current;
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
        {
            Args = args,
            ContentRootPath = Paths.AppDir,
            WebRootPath = Paths.WebRoot,
        });
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(new LogBridgeProvider());
        builder.Logging.SetMinimumLevel(LogLevel.Warning);

        builder.WebHost.UseKestrelHttpsConfiguration();
        builder.WebHost.ConfigureKestrel(k =>
        {
            k.AddServerHeader = false;
            k.Limits.MaxRequestBodySize = null; // uploads are streamed to disk
            // HEADROOM_BIND=loopback: development only — no LAN exposure (and no firewall prompt).
            bool loopbackOnly = Environment.GetEnvironmentVariable("HEADROOM_BIND") == "loopback";
            void Listen(int port, Action<Microsoft.AspNetCore.Server.Kestrel.Core.ListenOptions> configure)
            {
                if (loopbackOnly) k.ListenLocalhost(port, configure); else k.ListenAnyIP(port, configure);
            }
            // Headroom Viewer on the same network: sessions and file transfer only.
            Listen(cfg.Port, lo =>
            {
                // HTTP/1.1 only: WebSockets ride on it, and the handshake callback below owns ALPN.
                lo.Protocols = HttpProtocols.Http1;
                lo.UseHttps(new TlsHandshakeCallbackOptions
                {
                    // Present the full chain (leaf + issuer), not just the leaf: clients can then build the
                    // chain themselves, and Headroom Viewer can pin the local CA's key (Chromium only matches
                    // pinned keys against certificates the server actually sends).
                    OnConnection = ctx => ValueTask.FromResult(new System.Net.Security.SslServerAuthenticationOptions
                    {
                        ServerCertificateContext = certs.SelectContext(ctx.ClientHelloInfo.ServerName),
                        EnabledSslProtocols = System.Security.Authentication.SslProtocols.Tls12 | System.Security.Authentication.SslProtocols.Tls13,
                        ApplicationProtocols = new() { System.Net.Security.SslApplicationProtocol.Http11 },
                    }),
                });
            });
            // The settings window: this PC only, always.
            if (cfg.HttpHelperPort > 0) k.ListenLocalhost(cfg.HttpHelperPort, lo => lo.Protocols = HttpProtocols.Http1);
            // Where RelayService delivers tunnels from the relay: loopback only, any free port.
            k.Listen(IPAddress.Loopback, 0, lo => lo.Protocols = HttpProtocols.Http1);
        });
        builder.Services.AddRouting();

        var app = builder.Build();
        var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();

        // ------------------------------------------------------------------ middleware
        app.Use(async (ctx, next) =>
        {
            var h = ctx.Response.Headers;
            h["X-Content-Type-Options"] = "nosniff";
            h["Referrer-Policy"] = "no-referrer";
            h["X-Frame-Options"] = "DENY";

            if (IsRelayed(ctx))
            {
                // Through the relay: who the viewer is comes from the relay (a client can't set it: the relay drops
                // any X-Headroom-* header the viewer sent, and only the relay reaches this listener).
                var tunnel = RelayService.Tunnel(ctx.Connection.RemotePort);
                ctx.Connection.RemoteIpAddress =
                    IPAddress.TryParse(ctx.Request.Headers["X-Headroom-Client"].ToString(), out var viewer) ? viewer
                    : IPAddress.TryParse(tunnel?.Ip, out var fromOpen) ? fromOpen
                    : IPAddress.None;
                var info = new RelayedViewer(
                    Guest: ctx.Request.Headers["X-Headroom-Guest"].ToString() == "1" || tunnel?.Guest == true,
                    Country: RelayService.CountryCode(ctx.Request.Headers["X-Headroom-Country"].ToString()) ?? tunnel?.Country);
                ctx.Features.Set(info);
            }

            var path = ctx.Request.Path.Value ?? "/";
            bool api = ctx.Request.Path.StartsWithSegments("/api");
            if (ctx.Request.Path.StartsWithSegments("/api/admin"))
            {
                // Never CORS here (and no successful preflight): see AdminAllowed.
                h["Cache-Control"] = "no-store";
            }
            else if (api)
            {
                h["Cache-Control"] = "no-store";
                h["Access-Control-Allow-Origin"] = "*";
                h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
                h["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
                h["Access-Control-Max-Age"] = "600";
                if (ctx.Request.Headers.ContainsKey("Access-Control-Request-Private-Network"))
                    h["Access-Control-Allow-Private-Network"] = "true";
                if (HttpMethods.IsOptions(ctx.Request.Method))
                {
                    ctx.Response.StatusCode = 204;
                    return;
                }
            }

            // Stopped (ServerSwitch): nothing for the network, and no sessions here either; the settings window works.
            if (ServerSwitch.Shared.Stopped && (!IsLoopback(ctx) || path == "/ws"))
            {
                ctx.Response.StatusCode = 503;
                await ctx.Response.WriteAsJsonAsync(new { error = "stopped", message = "Headroom Server is stopped on this computer." });
                return;
            }
            if (!IsLoopback(ctx))
            {
                // To the network (Headroom Viewer over TLS, and the relay): sessions and their file transfers, nothing
                // else (the relay forwards nothing else either; this is the second lock).
                if (!NetworkAllows(path, IsGuest(ctx)) || !(ctx.Request.IsHttps || IsRelayed(ctx)))
                {
                    ctx.Response.StatusCode = 403;
                    await ctx.Response.WriteAsJsonAsync(new { error = "not-available" });
                    return;
                }
            }
            else if (path == "/")
            {
                ctx.Request.Path = "/admin.html"; // the settings window
            }
            await next();
        });

        app.UseWebSockets(new WebSocketOptions
        {
            KeepAliveInterval = TimeSpan.FromSeconds(15),
            KeepAliveTimeout = TimeSpan.FromSeconds(20),
        });

        // The settings window's files (this PC only: the network never gets past the middleware above). no-cache =
        // always revalidate (ETag), so updates land immediately.
        var contentTypes = new FileExtensionContentTypeProvider();
        contentTypes.Mappings[".webmanifest"] = "application/manifest+json";
        contentTypes.Mappings[".wasm"] = "application/wasm";
        contentTypes.Mappings[".mjs"] = "text/javascript";
        var files = new PhysicalFileProvider(Paths.WebRoot);
        app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = files,
            ContentTypeProvider = contentTypes,
            OnPrepareResponse = sf =>
            {
                sf.Context.Response.Headers["Cache-Control"] = "no-cache";
                if (sf.File.Name == "sw.js") sf.Context.Response.Headers["Service-Worker-Allowed"] = "/";
            },
        });

        // ------------------------------------------------------------------ public
        app.MapGet("/api/info", () => Results.Json(new { host = HostInfo.Describe() }));

        // Verify a stored token still works.
        app.MapGet("/api/me", (HttpContext ctx) =>
        {
            var dev = Authenticate(ctx);
            return dev == null ? Results.Json(new { error = "unauthorized" }, statusCode: 401)
                               : Results.Json(new { device = new { id = dev.Id, name = dev.Name }, host = HostInfo.Describe() });
        });

        // ------------------------------------------------------------------ files
        FileApi.Map(app);

        // ------------------------------------------------------------------ admin (loopback only)
        var admin = app.MapGroup("/api/admin").AddEndpointFilter(async (efc, next) =>
            AdminAllowed(efc.HttpContext) ? await next(efc) : Results.Json(new { error = "admin API is only available on the host itself" }, statusCode: 403));

        admin.MapGet("/status", () => Results.Json(Status(), ConfigStore.JsonOptions));
        admin.MapPost("/server/stop", () =>
        {
            ServerSwitch.Shared.Stop();
            return Results.Json(new { ok = true });
        });
        admin.MapPost("/server/start", () =>
        {
            ServerSwitch.Shared.Start();
            return Results.Json(new { ok = true });
        });
        admin.MapPost("/sessions/disconnect-all", () =>
        {
            SupportService.Shared.RevokeAll();
            foreach (var s in SessionManager.Active) s.Disconnect("stopped by the person at the computer");
            return Results.Json(new { ok = true });
        });
        admin.MapPost("/sessions/{id}/disconnect", (string id) =>
        {
            var s = SessionManager.Active.FirstOrDefault(x => x.Id == id);
            if (s == null) return Results.NotFound();
            // A guest's access ends for good: it may not come back with its resume key.
            if (s.Device?.Id is { } did && did.StartsWith("guest:", StringComparison.Ordinal)) SupportService.Shared.Revoke(did);
            s.Disconnect("stopped by the person at the computer");
            return Results.Json(new { ok = true });
        });
        admin.MapPost("/sessions/{id}/rights", async (string id, HttpContext ctx) =>
        {
            // A guest's control, files and clipboard, changed while connected.
            var body = await ReadJson(ctx);
            var s = SessionManager.Active.FirstOrDefault(x => x.Id == id);
            if (s?.Device?.Id is not { } did || !did.StartsWith("guest:", StringComparison.Ordinal)) return Results.NotFound();
            SupportService.Shared.SetRights(did, Bool(body, "input"), Bool(body, "files"), Bool(body, "clipboard"));
            return Results.Json(new { ok = true });
        });
        // "Let someone connect": a 9-digit code, and a link with it.
        admin.MapPost("/support/code", async () =>
        {
            if (ServerSwitch.Shared.Stopped)
                return Results.Json(new { error = "stopped", message = "Headroom Server is stopped. Start it, then create a code." }, statusCode: 409);
            var (code, error) = await SupportService.Shared.CreateCodeAsync();
            return code != null
                ? Results.Json(new { code = code.Code, expiresAt = new DateTimeOffset(code.Expires, TimeSpan.Zero), link = code.Link })
                : Results.Json(new { error = "unavailable", message = error }, statusCode: 503);
        });
        admin.MapDelete("/support/code", () =>
        {
            SupportService.Shared.CancelCode();
            return Results.Json(new { ok = true });
        });
        admin.MapPost("/support/requests/{id}", async (string id, HttpContext ctx) =>
        {
            var body = await ReadJson(ctx);
            bool Flag(string n) => Bool(body, n) == true;
            return SupportService.Shared.Decide(id, Flag("accept"), Flag("viewOnly"), Flag("files"), Flag("clipboard"))
                ? Results.Json(new { ok = true })
                : Results.Json(new { error = "That request is no longer waiting." }, statusCode: 404);
        });
        // Signing in: the password goes to Headroom only; this PC keeps its own sign-in there.
        admin.MapPost("/account/join", async (HttpContext ctx) =>
        {
            var body = await ReadJson(ctx);
            var (ok, email, error, message) = await Task.Run(() =>
                AccountService.Shared.Join(Str(body, "email"), Str(body, "password"), Str(body, "totp")));
            if (ok) return Results.Json(new { ok = true, email });
            int status = error is "bad-credentials" or "totp-required" or "bad-totp" ? 401 : 400;
            return Results.Json(new { error, message = message ?? error }, statusCode: status);
        });
        admin.MapPost("/account/leave", async () =>
        {
            await Task.Run(() => AccountService.Shared.Leave());
            return Results.Json(new { ok = true });
        });
        admin.MapPost("/account/sync", async () => Results.Json(new { ok = await Task.Run(() => AccountService.Shared.Sync()) }));
        admin.MapPost("/settings", async (HttpContext ctx) =>
        {
            var body = await ReadJson(ctx);
            bool rightsChanged = false, renamed = false;
            ConfigStore.Update(c =>
            {
                if (Bool(body, "lockOnDisconnect") is { } l) c.LockOnDisconnect = l;
                if (Bool(body, "notifyOnConnect") is { } nc) c.NotifyOnConnect = nc;
                if (Int(body, "maxFps") is { } f) c.Video.MaxFps = Math.Clamp(f, 10, 240);
                if (Int(body, "maxBitrateKbps") is { } b) c.Video.MaxBitrateKbps = Math.Clamp(b, 1000, 200000);
                if (Str(body, "encoder") is "auto" or "hardware" or "software") c.Video.Encoder = Str(body, "encoder")!;
                if (Bool(body, "audio") is { } a) { c.Audio.Enabled = a; rightsChanged = true; } // sound stops for running sessions too
                if (Bool(body, "clipboard") is { } cb) { c.Permissions.Clipboard = cb; rightsChanged = true; }
                if (Bool(body, "fileTransfer") is { } ft) { c.Permissions.FileTransfer = ft; rightsChanged = true; }
                if (Bool(body, "input") is { } inp) { c.Permissions.Input = inp; rightsChanged = true; }
                if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("displayName", out _))
                {
                    var n = (Str(body, "displayName") ?? "").Trim();
                    c.DisplayName = n.Length == 0 ? null : n[..Math.Min(64, n.Length)];
                    renamed = true;
                }
                // Another Headroom server (self-hosting, testing); takes effect for the next sign-in and the relay.
                if (Str(body, "server") is { } server) c.Server = AccountService.NormalizeServer(server) ?? HostConfig.DefaultServer;
            });
            if (rightsChanged) SessionManager.RightsChanged();
            if (renamed) _ = Task.Run(() => AccountService.Shared.Sync()); // the new name, in the account now
            return Results.Json(new { ok = true });
        });

        // ------------------------------------------------------------------ websocket
        app.Map("/ws", async (HttpContext ctx) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = 400;
                return;
            }
            // Disable Nagle on the underlying socket: input acks and cursor updates must not be delayed.
            var socket = ctx.Features.Get<IConnectionSocketFeature>()?.Socket;
            if (socket != null) socket.NoDelay = true;
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync(new WebSocketAcceptContext { DangerousEnableCompression = false });
            // With audio priority a relayed session keeps its loopback hop small: this socket and the tunnel's end of it.
            var tunnel = IsRelayed(ctx) ? RelayService.Tunnel(ctx.Connection.RemotePort)?.Loopback : null;
            var session = new ClientSession(ws, ctx.Connection.RemoteIpAddress, IsRelayed(ctx), IsGuest(ctx), ctx.Features.Get<RelayedViewer>()?.Country,
                socket, tunnel);
            await session.RunAsync(lifetime.ApplicationStopping);
        });

        return app;
    }

    /// <summary>The settings window's view of this PC (GET /api/admin/status): the same fields as the Mac host's, plus Windows' own.</summary>
    private static object Status()
    {
        var c = ConfigStore.Current;
        return new
        {
            host = HostInfo.Describe(),
            port = c.Port,
            sessions = SessionManager.Active.Where(s => s.Device != null).Select(s => new
            {
                id = s.Id, device = s.Device?.Name, deviceId = s.Device?.Id, guest = s.Rights.Guest,
                remoteAddress = s.RemoteAddress, country = s.Country, connectedAt = s.ConnectedAt, rights = s.Rights.Json,
            }).ToList(),
            elevated = Input.InputInjector.IsSystem,
            serviceInstalled = Service.ServiceInstaller.Exists(),
            pid = Environment.ProcessId,
            stopped = ServerSwitch.Shared.Stopped, // "Stop server": nobody can connect (ServerSwitch)
            lanAddresses = CertificateManager.GetLocalAddresses()
                .Where(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork).Select(a => a.ToString()).ToList(),
            dataDir = Paths.DataDir,
            logDir = Paths.LogDir,
            account = AccountService.Shared.Status,
            relay = RelayService.Shared.Status,
            support = SupportService.Shared.Status,
            settings = new
            {
                video = c.Video, audio = c.Audio, permissions = c.Permissions,
                lockOnDisconnect = c.LockOnDisconnect, displayName = c.DisplayName, notifyOnConnect = c.NotifyOnConnect, server = c.Server,
            },
        };
    }

    // ---------------------------------------------------------------------- helpers

    /// <summary>
    /// Never true through the relay: the relay may run on this very PC, so a relayed connection's address says nothing
    /// about where the viewer is.
    /// </summary>
    public static bool IsLoopback(HttpContext ctx) => !IsRelayed(ctx) && ctx.Connection.RemoteIpAddress is { } ip && IPAddress.IsLoopback(ip);

    /// <summary>Arrived on the private port where RelayService delivers the relay's tunnels.</summary>
    public static bool IsRelayed(HttpContext ctx) => RelayService.LocalPort != 0 && ctx.Connection.LocalPort == RelayService.LocalPort;

    /// <summary>What the relay said about a relayed viewer (set by the first middleware, only on the relay listener).</summary>
    private sealed record RelayedViewer(bool Guest, string? Country);

    /// <summary>Came with a guest code (the relay's /c/&lt;code&gt;/): only this PC's name and the session are available.</summary>
    public static bool IsGuest(HttpContext ctx) => IsRelayed(ctx) && ctx.Features.Get<RelayedViewer>()?.Guest == true;

    /// <summary>
    /// What the network may reach: sessions and their file transfers. With a guest code, before being accepted: only
    /// this PC's name and the session. Never the settings window or its API.
    /// </summary>
    public static bool NetworkAllows(string path, bool guest) => guest
        ? path is "/ws" or "/api/info"
        : path is "/ws" or "/api/info" or "/api/me" or "/api/files/list" or "/api/files/download" or "/api/files/upload" or "/api/files/mkdir";

    /// <summary>
    /// The admin API is for this PC's own settings window, CLI and browser — not for web pages. A loopback peer
    /// isn't enough: any page open in a local browser can send requests to 127.0.0.1. So also require a loopback
    /// Host header (defeats DNS rebinding) and no foreign Origin / cross-site Sec-Fetch-Site (defeats cross-site
    /// requests, including "simple" text/plain POSTs that need no CORS preflight). /api/admin never sends CORS headers.
    /// </summary>
    public static bool AdminAllowed(HttpContext ctx)
    {
        if (!IsLoopback(ctx)) return false;
        static bool IsLoopbackName(string h) => h.Trim('[', ']').ToLowerInvariant() is "localhost" or "127.0.0.1" or "::1";
        if (!IsLoopbackName(ctx.Request.Host.Host)) return false;
        var origin = ctx.Request.Headers.Origin.ToString();
        if (origin.Length > 0 && !(Uri.TryCreate(origin, UriKind.Absolute, out var o) && IsLoopbackName(o.Host))) return false;
        var site = ctx.Request.Headers["Sec-Fetch-Site"].ToString();
        if (site.Length > 0 && site is not ("same-origin" or "none")) return false;
        return true;
    }

    public static PairedDevice? Authenticate(HttpContext ctx)
    {
        var auth = ctx.Request.Headers.Authorization.ToString();
        if (!auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return null;
        return AuthService.ValidateToken(auth[7..].Trim(), ctx.Connection.RemoteIpAddress);
    }

    public static async Task<JsonElement> ReadJson(HttpContext ctx)
    {
        try
        {
            using var doc = await JsonDocument.ParseAsync(ctx.Request.Body);
            return doc.RootElement.Clone();
        }
        catch
        {
            return JsonDocument.Parse("{}").RootElement.Clone();
        }
    }

    public static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool? Bool(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;

    private static int? Int(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

    /// <summary>How Headroom Viewer on the same network reaches this PC directly (reported to the account).</summary>
    public static List<string> ServerUrls(CertificateManager certs)
    {
        int port = ConfigStore.Current.Port;
        var urls = new List<string>();
        if (certs.TailscaleName != null) urls.Add($"https://{certs.TailscaleName}:{port}/");
        urls.Add($"https://{Environment.MachineName.ToLowerInvariant()}.local:{port}/");
        foreach (var ip in CertificateManager.GetLocalAddresses().Where(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork))
            urls.Add($"https://{ip}:{port}/");
        return urls;
    }

    private sealed class LogBridgeProvider : ILoggerProvider
    {
        public ILogger CreateLogger(string categoryName) => new Bridge(categoryName);
        public void Dispose() { }

        private sealed class Bridge(string category) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
            public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning;
            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            {
                if (!IsEnabled(logLevel)) return;
                var msg = formatter(state, exception) + (exception != null ? $" :: {exception.Message}" : "");
                var tag = category.Split('.').Last();
                if (logLevel >= LogLevel.Error) Util.Log.Error(tag, msg); else Util.Log.Warn(tag, msg);
            }
        }
    }
}
