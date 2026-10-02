using System.Net;
using System.Text.Json;
using Headroom.Host.Config;
using Headroom.Host.Security;
using Headroom.Host.Services;
using Headroom.Host.Session;
using Headroom.Host.Util;
using Microsoft.AspNetCore.Connections.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;
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
            k.ListenAnyIP(cfg.Port, lo =>
            {
                lo.Protocols = HttpProtocols.Http1AndHttp2;
                lo.UseHttps(h =>
                {
                    h.ServerCertificateSelector = (_, sni) => certs.Select(sni);
                    h.SslProtocols = System.Security.Authentication.SslProtocols.Tls12 | System.Security.Authentication.SslProtocols.Tls13;
                });
            });
            if (cfg.HttpHelperPort > 0) k.ListenAnyIP(cfg.HttpHelperPort);
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

            bool isHttps = ctx.Request.IsHttps;
            bool loopback = IsLoopback(ctx);
            if (!isHttps && !loopback)
            {
                // Plain-HTTP helper port, remote caller: only the CA bootstrap is available.
                var p = ctx.Request.Path.Value ?? "/";
                if (!(p is "/" or "/trust" or "/headroom-ca.crt" or "/headroom-ca.mobileconfig" or "/trust.css"))
                {
                    var host = ctx.Request.Host.Host;
                    ctx.Response.Redirect($"https://{FormatHost(host)}:{cfg.Port}{ctx.Request.Path}{ctx.Request.QueryString}");
                    return;
                }
                if (p == "/") { ctx.Request.Path = "/trust"; }
            }

            if (ctx.Request.Path.StartsWithSegments("/api"))
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
            await next();
        });

        app.UseWebSockets(new WebSocketOptions
        {
            KeepAliveInterval = TimeSpan.FromSeconds(15),
            KeepAliveTimeout = TimeSpan.FromSeconds(20),
        });

        // Static client. no-cache = always revalidate (ETag), so updates land immediately; the
        // service worker provides offline start.
        var contentTypes = new FileExtensionContentTypeProvider();
        contentTypes.Mappings[".webmanifest"] = "application/manifest+json";
        contentTypes.Mappings[".mobileconfig"] = "application/x-apple-aspen-config";
        contentTypes.Mappings[".wasm"] = "application/wasm";
        contentTypes.Mappings[".mjs"] = "text/javascript";
        var files = new PhysicalFileProvider(Paths.WebRoot);
        app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
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
        app.MapGet("/api/info", (HttpContext ctx) => Results.Json(new
        {
            host = HostInfo.Describe(),
            paired = AuthService.HasPassword,
            totp = ConfigStore.Current.TotpEnabled,
            port = ConfigStore.Current.Port,
            tailscale = certs.TailscaleName,
            loopback = IsLoopback(ctx),
        }));

        app.MapPost("/api/pair", async (HttpContext ctx) =>
        {
            var body = await ReadJson(ctx);
            var ip = ctx.Connection.RemoteIpAddress;
            var (result, token, device) = AuthService.Pair(ip, Str(body, "password"), Str(body, "totp"), Str(body, "code"), Str(body, "deviceName") ?? "Device");
            return result switch
            {
                PairResult.Ok => Results.Json(new { token, device = new { id = device!.Id, name = device.Name }, host = HostInfo.Describe() }),
                PairResult.TotpRequired => Results.Json(new { error = "totp-required" }, statusCode: 401),
                PairResult.RateLimited => Results.Json(new { error = "rate-limited", retryAfter = (int)(AuthService.RetryAfter(ip)?.TotalSeconds ?? 60) }, statusCode: 429),
                PairResult.NotConfigured => Results.Json(new { error = "not-configured", message = "No password is set on this host yet. Use a pairing code, or set a password on the host." }, statusCode: 409),
                _ => Results.Json(new { error = "bad-credentials" }, statusCode: 401),
            };
        });

        // Verify a stored token still works (address book health check).
        app.MapGet("/api/me", (HttpContext ctx) =>
        {
            var dev = Authenticate(ctx);
            return dev == null ? Results.Json(new { error = "unauthorized" }, statusCode: 401)
                               : Results.Json(new { device = new { id = dev.Id, name = dev.Name }, host = HostInfo.Describe() });
        });

        app.MapGet("/headroom-ca.crt", () => Results.File(certs.CaCertificate.Export(System.Security.Cryptography.X509Certificates.X509ContentType.Cert),
            "application/x-x509-ca-cert", "headroom-ca.crt"));
        app.MapGet("/headroom-ca.mobileconfig", () => Results.File(certs.BuildMobileConfig(), "application/x-apple-aspen-config", $"Headroom-{Environment.MachineName}.mobileconfig"));
        app.MapGet("/trust", (HttpContext ctx) => Results.Content(TrustPage.Render(ctx, certs), "text/html; charset=utf-8"));

        // ------------------------------------------------------------------ files
        FileApi.Map(app);

        // ------------------------------------------------------------------ admin (loopback only)
        var admin = app.MapGroup("/api/admin").AddEndpointFilter(async (efc, next) =>
            IsLoopback(efc.HttpContext) ? await next(efc) : Results.Json(new { error = "admin API is only available on the host itself" }, statusCode: 403));

        admin.MapGet("/status", () =>
        {
            var c = ConfigStore.Current;
            return Results.Json(new
            {
                host = HostInfo.Describe(),
                hasPassword = c.Password != null,
                totpEnabled = c.TotpEnabled,
                port = c.Port,
                urls = ServerUrls(certs),
                tailscale = certs.TailscaleName,
                devices = c.Devices.Select(d => new { d.Id, d.Name, d.Created, d.LastSeen, d.LastAddress, d.ViewOnly }),
                sessions = SessionManager.Active.Select(s => new { s.Id, device = s.Device?.Name, deviceId = s.Device?.Id, s.RemoteAddress, s.ConnectedAt }),
                elevated = Input.InputInjector.IsSystem,
                serviceInstalled = Service.ServiceInstaller.Exists(),
                pid = Environment.ProcessId,
                httpPort = c.HttpHelperPort,
                lanAddresses = CertificateManager.GetLocalAddresses()
                    .Where(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork).Select(a => a.ToString()),
                dataDir = Paths.DataDir,
                logDir = Paths.LogDir,
                caThumbprint = certs.CaCertificate.Thumbprint,
                settings = new { c.Video, c.Audio, c.Permissions, c.LockOnDisconnect },
            }, ConfigStore.JsonOptions);
        });
        admin.MapPost("/password", async (HttpContext ctx) =>
        {
            var body = await ReadJson(ctx);
            var pw = Str(body, "password") ?? "";
            if (pw.Length < 8) return Results.Json(new { error = "Password must be at least 8 characters." }, statusCode: 400);
            AuthService.SetPassword(pw);
            Log.Info("admin", "password changed");
            return Results.Json(new { ok = true });
        });
        // Two-factor (TOTP) for pairing: setup returns a secret + otpauth URI; it only takes effect once a
        // code from the authenticator app verifies.
        string? pendingTotp = null;
        admin.MapPost("/totp/setup", () =>
        {
            pendingTotp = Totp.NewSecret();
            return Results.Json(new { secret = pendingTotp, uri = Totp.ProvisioningUri(pendingTotp, HostInfo.Name) });
        });
        admin.MapPost("/totp/enable", async (HttpContext ctx) =>
        {
            var body = await ReadJson(ctx);
            var code = Str(body, "code") ?? "";
            if (pendingTotp == null) return Results.Json(new { error = "Start setup first." }, statusCode: 400);
            if (!Totp.Verify(pendingTotp, code)) return Results.Json(new { error = "That code didn't match. Check the time on your phone and try the next code." }, statusCode: 400);
            var secret = pendingTotp;
            pendingTotp = null;
            ConfigStore.Update(c => { c.TotpSecret = secret; c.TotpEnabled = true; });
            Log.Info("admin", "two-factor pairing enabled");
            return Results.Json(new { ok = true });
        });
        admin.MapPost("/totp/disable", () =>
        {
            ConfigStore.Update(c => { c.TotpEnabled = false; c.TotpSecret = null; });
            Log.Info("admin", "two-factor pairing disabled");
            return Results.Json(new { ok = true });
        });
        admin.MapPost("/paircode", () =>
        {
            var code = AuthService.CreatePairCode(TimeSpan.FromMinutes(10));
            return Results.Json(new { code, expiresInSeconds = 600, urls = ServerUrls(certs).Select(u => $"{u}#pair={code}") });
        });
        admin.MapPost("/sessions/{id}/disconnect", (string id) =>
        {
            var s = SessionManager.Active.FirstOrDefault(x => x.Id == id);
            if (s == null) return Results.NotFound();
            s.Disconnect("disconnected from the host");
            return Results.Json(new { ok = true });
        });
        admin.MapPost("/sessions/disconnect-all", () =>
        {
            foreach (var s in SessionManager.Active) s.Disconnect("disconnected from the host");
            return Results.Json(new { ok = true });
        });
        admin.MapDelete("/devices/{id}", (string id) =>
        {
            bool ok = AuthService.RevokeDevice(id);
            SessionManager.DisconnectDevice(id);
            return ok ? Results.Json(new { ok = true }) : Results.NotFound();
        });
        admin.MapPost("/devices/{id}/viewonly", async (string id, HttpContext ctx) =>
        {
            var body = await ReadJson(ctx);
            bool viewOnly = body.TryGetProperty("viewOnly", out var v) && v.GetBoolean();
            ConfigStore.Update(c => { var d = c.Devices.FirstOrDefault(x => x.Id == id); if (d != null) d.ViewOnly = viewOnly; });
            return Results.Json(new { ok = true });
        });
        admin.MapPost("/settings", async (HttpContext ctx) =>
        {
            var body = await ReadJson(ctx);
            ConfigStore.Update(c =>
            {
                if (body.TryGetProperty("lockOnDisconnect", out var l)) c.LockOnDisconnect = l.GetBoolean();
                if (body.TryGetProperty("maxFps", out var f)) c.Video.MaxFps = Math.Clamp(f.GetInt32(), 10, 240);
                if (body.TryGetProperty("maxBitrateKbps", out var b)) c.Video.MaxBitrateKbps = Math.Clamp(b.GetInt32(), 1000, 200000);
                if (body.TryGetProperty("encoder", out var e) && e.GetString() is "auto" or "hardware" or "software") c.Video.Encoder = e.GetString()!;
                if (body.TryGetProperty("audio", out var a)) c.Audio.Enabled = a.GetBoolean();
                if (body.TryGetProperty("clipboard", out var cb)) c.Permissions.Clipboard = cb.GetBoolean();
                if (body.TryGetProperty("fileTransfer", out var ft)) c.Permissions.FileTransfer = ft.GetBoolean();
            });
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
            ctx.Features.Get<IConnectionSocketFeature>()?.Socket?.NoDelay = true;
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync(new WebSocketAcceptContext { DangerousEnableCompression = false });
            var session = new ClientSession(ws, ctx.Connection.RemoteIpAddress);
            await session.RunAsync(lifetime.ApplicationStopping);
        });

        // SPA fallback: unknown paths serve the client.
        app.MapFallback(async ctx =>
        {
            if (ctx.Request.Path.StartsWithSegments("/api")) { ctx.Response.StatusCode = 404; return; }
            ctx.Response.ContentType = "text/html; charset=utf-8";
            ctx.Response.Headers["Cache-Control"] = "no-cache";
            await ctx.Response.SendFileAsync(Path.Combine(Paths.WebRoot, "index.html"));
        });

        return app;
    }

    // ---------------------------------------------------------------------- helpers

    public static bool IsLoopback(HttpContext ctx) => ctx.Connection.RemoteIpAddress is { } ip && IPAddress.IsLoopback(ip);

    public static PairedDevice? Authenticate(HttpContext ctx)
    {
        var auth = ctx.Request.Headers.Authorization.ToString();
        if (!auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return null;
        return AuthService.ValidateToken(auth[7..].Trim(), ctx.Connection.RemoteIpAddress, touch: false);
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

    private static string FormatHost(string host) => host.Contains(':') && !host.StartsWith('[') ? $"[{host}]" : host;

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
