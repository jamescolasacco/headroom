using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Headroom.Host.Config;
using Headroom.Host.Diagnostics;
using Headroom.Host.Security;
using Headroom.Host.Services;
using Headroom.Host.Util;
using Headroom.Host.Web;

namespace Headroom.Host;

public static class Program
{
    public static int Main(string[] args)
    {
        // --data=<dir> / --webroot=<dir> override the data directory and client files (development).
        foreach (var a in args)
        {
            if (a.StartsWith("--data=", StringComparison.OrdinalIgnoreCase)) Environment.SetEnvironmentVariable("HEADROOM_DATA", Path.GetFullPath(a[7..]));
            else if (a.StartsWith("--webroot=", StringComparison.OrdinalIgnoreCase)) Environment.SetEnvironmentVariable("HEADROOM_WEBROOT", Path.GetFullPath(a[10..]));
        }
        args = args.Where(a => !a.StartsWith("--data=", StringComparison.OrdinalIgnoreCase) && !a.StartsWith("--webroot=", StringComparison.OrdinalIgnoreCase)).ToArray();
        var command = args.Length > 0 && !args[0].StartsWith('-') ? args[0].ToLowerInvariant() : "run";
        var rest = args.Length > 0 && !args[0].StartsWith('-') ? args.Skip(1).ToArray() : args;
        if (Environment.GetEnvironmentVariable("HEADROOM_DEBUG") == "1") Log.MinLevel = Log.Level.Debug;
        if (command is "agent" or "service-run") Log.ConsoleEnabled = false;
        Log.Init(command is "run" or "agent" or "service-run" ? Paths.LogDir : null);
        try
        {
            return command switch
            {
                "run" => Run(rest),
                "agent" => Run(rest, banner: false),
                "service-run" => RunService(rest),
                "service" => Service.ServiceInstaller.Run(rest),
                "selftest" => SelfTest.Run(rest),
                "help" or "--help" or "-h" or "/?" => Usage(0),
                _ => Usage(1),
            };
        }
        catch (Exception ex)
        {
            Log.Error("main", "fatal", ex);
            return 1;
        }
        finally
        {
            Log.Flush();
        }
    }

    private static int Usage(int code)
    {
        Console.WriteLine("""
            Headroom remote desktop host

              headroom [run]              start the host (default)
              headroom selftest [secs]    capture + encode test, writes an .h264 file
              headroom service install    run as a Windows service (lock screen, UAC, Ctrl+Alt+Del) [admin]
              headroom service uninstall  remove the service (--purge also deletes settings/certs)  [admin]
              headroom service status|start|stop

            Sign in to your Headroom account and let someone connect with a code from the settings:
            Headroom Server, or http://localhost:7080/ on this PC.

            Environment: HEADROOM_DATA (data dir), HEADROOM_WEBROOT (client dir), HEADROOM_DEBUG=1
            """);
        return code;
    }

    private static int RunService(string[] args)
    {
        var builder = Microsoft.Extensions.Hosting.Host.CreateApplicationBuilder(args);
        builder.Logging.ClearProviders();
        builder.Services.AddWindowsService(o => o.ServiceName = Service.ServiceInstaller.ServiceName);
        builder.Services.AddHostedService<Service.HeadroomService>();
        builder.Build().Run();
        return 0;
    }

    private static int Run(string[] args, bool banner = true)
    {
        if (banner && Service.ServiceInstaller.Exists())
        {
            Console.WriteLine("Note: the Headroom service is installed and normally runs the host for you.");
            Console.WriteLine("      If it's running, this instance will fail to bind its ports. Use `headroom service stop` first.");
        }
        Directory.CreateDirectory(Paths.DataDir);
        var cfg = ConfigStore.Current;
        _ = HostInfo.HostId;
        var certs = new CertificateManager();
        certs.Initialize();

        var app = WebHost.Build(certs, args);
        try
        {
            app.Start();
        }
        catch (IOException ex) when (ex.InnerException is System.Net.Sockets.SocketException)
        {
            Log.Error("main", $"Port {cfg.Port} or {cfg.HttpHelperPort} is already in use. Is Headroom already running?");
            return 2;
        }

        AccountService.Shared.Start(certs);
        // The relay's tunnels arrive on the loopback listener Kestrel bound to a free port.
        var bound = app.Services.GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>()
            .Features.Get<Microsoft.AspNetCore.Hosting.Server.Features.IServerAddressesFeature>()?.Addresses ?? Array.Empty<string>();
        var relayPort = bound.Select(a => Uri.TryCreate(a.Replace("://+", "://x").Replace("://*", "://x"), UriKind.Absolute, out var u) ? u.Port : 0)
            .FirstOrDefault(p => p > 0 && p != cfg.Port && p != cfg.HttpHelperPort);
        if (relayPort > 0) RelayService.Shared.Start(relayPort);
        else Log.Warn("relay", "no loopback port for relay tunnels; the relay is unavailable");
        if (banner) PrintBanner();
        else Log.Info("main", $"agent running in session {Process.GetCurrentProcess().SessionId} as {(Input.InputInjector.IsSystem ? "SYSTEM" : Environment.UserName)}");
        app.WaitForShutdown();
        return 0;
    }

    private static void PrintBanner()
    {
        var cfg = ConfigStore.Current;
        var sb = new StringBuilder();
        sb.AppendLine();
        sb.AppendLine($"  Headroom {HostInfo.Version} — {HostInfo.Name}{(Input.InputInjector.IsSystem ? " (service mode)" : "")}");
        sb.AppendLine();
        if (cfg.Account is { } a)
            sb.AppendLine($"  Signed in as {a.Email}: open {a.Server} on any device and sign in to connect.");
        else if (cfg.HttpHelperPort > 0)
            sb.AppendLine($"  Not signed in to a Headroom account. Sign in from the settings: http://localhost:{cfg.HttpHelperPort}/");
        else
            sb.AppendLine("  Not signed in to a Headroom account. Sign in from Headroom Server's settings.");
        sb.AppendLine("  To let someone connect with a code, use the settings (Let someone connect).");
        sb.AppendLine();
        Console.Write(sb.ToString());
    }
}
