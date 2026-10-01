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
                "set-password" => SetPassword(rest),
                "pair" => Pair(),
                "devices" => Devices(),
                "revoke" => Revoke(rest),
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
              headroom set-password       set the password used to pair new devices
              headroom pair               show a one-time pairing code (host must be running)
              headroom devices            list paired devices
              headroom revoke <id>        revoke a paired device
              headroom selftest [secs]    capture + encode test, writes an .h264 file
              headroom service install    run as a Windows service (lock screen, UAC, Ctrl+Alt+Del) [admin]
              headroom service uninstall  remove the service (--purge also deletes pairings/certs)  [admin]
              headroom service status|start|stop

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

        if (banner) PrintBanner(certs);
        else Log.Info("main", $"agent running in session {Process.GetCurrentProcess().SessionId} as {(Input.InputInjector.IsSystem ? "SYSTEM" : Environment.UserName)}");
        app.WaitForShutdown();
        return 0;
    }

    private static void PrintBanner(CertificateManager certs)
    {
        var cfg = ConfigStore.Current;
        var sb = new StringBuilder();
        sb.AppendLine();
        sb.AppendLine($"  Headroom {HostInfo.Version} — {HostInfo.Name}{(Input.InputInjector.IsSystem ? " (service mode)" : "")}");
        sb.AppendLine();
        sb.AppendLine("  Open from another device:");
        foreach (var url in WebHost.ServerUrls(certs)) sb.AppendLine($"    {url}");
        if (cfg.HttpHelperPort > 0)
        {
            var ip = CertificateManager.GetLocalAddresses().FirstOrDefault(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork);
            sb.AppendLine();
            sb.AppendLine($"  First time on a device? Trust this host's certificate: http://{ip?.ToString() ?? "localhost"}:{cfg.HttpHelperPort}/");
            sb.AppendLine($"  On this PC: http://localhost:{cfg.HttpHelperPort}/  (settings: http://localhost:{cfg.HttpHelperPort}/admin.html)");
        }
        sb.AppendLine();
        if (!AuthService.HasPassword)
        {
            var code = AuthService.CreatePairCode(TimeSpan.FromMinutes(15));
            sb.AppendLine($"  No password set yet. One-time pairing code (15 min): {code[..5]}-{code[5..]}");
            sb.AppendLine("  Set a permanent one with:  headroom set-password");
        }
        else
        {
            sb.AppendLine($"  {cfg.Devices.Count} paired device(s). New devices pair with the password, or run:  headroom pair");
        }
        sb.AppendLine();
        Console.Write(sb.ToString());
    }

    private static int SetPassword(string[] args)
    {
        string? pw = args.Length > 0 ? args[0] : null;
        if (pw == null)
        {
            pw = ReadSecret("New password (min 8 chars): ");
            var again = ReadSecret("Repeat: ");
            if (pw != again) { Console.WriteLine("Passwords don't match."); return 1; }
        }
        try
        {
            AuthService.SetPassword(pw);
        }
        catch (ArgumentException ex)
        {
            Console.WriteLine(ex.Message);
            return 1;
        }
        Console.WriteLine("Password saved. Use it to pair new devices (paired devices keep working).");
        return 0;
    }

    private static string ReadSecret(string prompt)
    {
        Console.Write(prompt);
        if (Console.IsInputRedirected) return Console.ReadLine() ?? "";
        var sb = new StringBuilder();
        while (true)
        {
            var k = Console.ReadKey(intercept: true);
            if (k.Key == ConsoleKey.Enter) break;
            if (k.Key == ConsoleKey.Backspace) { if (sb.Length > 0) sb.Length--; continue; }
            if (!char.IsControl(k.KeyChar)) sb.Append(k.KeyChar);
        }
        Console.WriteLine();
        return sb.ToString();
    }

    private static int Pair()
    {
        var port = ConfigStore.Current.HttpHelperPort;
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        try
        {
            var resp = http.PostAsync($"http://127.0.0.1:{port}/api/admin/paircode", null).GetAwaiter().GetResult();
            resp.EnsureSuccessStatusCode();
            using var doc = JsonDocument.Parse(resp.Content.ReadAsStringAsync().GetAwaiter().GetResult());
            var code = doc.RootElement.GetProperty("code").GetString()!;
            Console.WriteLine($"Pairing code (valid 10 minutes, single use): {code[..5]}-{code[5..]}");
            Console.WriteLine("Or open one of these on the new device:");
            foreach (var u in doc.RootElement.GetProperty("urls").EnumerateArray()) Console.WriteLine("  " + u.GetString());
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Could not reach the running host on port {port}: {ex.Message}");
            return 1;
        }
    }

    private static int Devices()
    {
        var devices = ConfigStore.Current.Devices;
        if (devices.Count == 0) { Console.WriteLine("No paired devices."); return 0; }
        foreach (var d in devices)
            Console.WriteLine($"{d.Id}  {d.Name,-28} paired {d.Created.LocalDateTime:g}  last seen {(d.LastSeen?.LocalDateTime.ToString("g") ?? "never")}  {d.LastAddress}{(d.ViewOnly ? "  [view-only]" : "")}");
        return 0;
    }

    private static int Revoke(string[] args)
    {
        if (args.Length == 0) { Console.WriteLine("usage: headroom revoke <device-id>"); return 1; }
        bool ok = AuthService.RevokeDevice(args[0]);
        Console.WriteLine(ok ? "Revoked. (A running host disconnects it on its next reconnect attempt.)" : "No such device.");
        return ok ? 0 : 1;
    }
}
