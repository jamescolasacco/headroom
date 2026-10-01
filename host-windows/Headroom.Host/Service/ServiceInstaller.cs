using System.Diagnostics;
using Headroom.Host.Platform;
using Headroom.Host.Util;
using Microsoft.Win32;

namespace Headroom.Host.Service;

/// <summary>`headroom service install|uninstall|start|stop|status` — requires an elevated prompt.</summary>
public static class ServiceInstaller
{
    public const string ServiceName = "Headroom";
    private const string FirewallRule = "Headroom Remote Desktop";

    public static int Run(string[] args)
    {
        var sub = args.Length > 0 ? args[0].ToLowerInvariant() : "status";
        if (sub != "status" && !Native.IsUserAnAdmin())
        {
            Console.WriteLine("This needs administrator rights. Open Terminal as administrator and run the command again.");
            return 5;
        }
        return sub switch
        {
            "install" => Install(),
            "uninstall" => Uninstall(args.Contains("--purge")),
            "start" => Sc("start", ServiceName) == 0 ? Ok("Started.") : 1,
            "stop" => Sc("stop", ServiceName) == 0 ? Ok("Stopped.") : 1,
            "status" => Status(),
            _ => Help(),
        };
    }

    private static int Ok(string msg) { Console.WriteLine(msg); return 0; }

    private static int Help()
    {
        Console.WriteLine("usage: headroom service install|uninstall [--purge]|start|stop|status");
        return 1;
    }

    private static int Install()
    {
        var exe = Environment.ProcessPath!;
        if (exe.EndsWith("dotnet.exe", StringComparison.OrdinalIgnoreCase))
        {
            Console.WriteLine("Install from the published headroom.exe (see install.ps1), not via `dotnet headroom.dll`.");
            return 1;
        }
        Console.WriteLine($"Installing service for {exe}");

        // Recreate so a moved/updated exe path is picked up.
        if (Exists()) { Sc("stop", ServiceName); Sc("delete", ServiceName); Thread.Sleep(1000); }
        if (Sc("create", ServiceName, "binPath=", $"\"{exe}\" service-run", "start=", "auto", "obj=", "LocalSystem", "DisplayName=", "Headroom Remote Desktop") != 0)
            return 1;
        Sc("description", ServiceName, "Headroom remote desktop host (service mode: works at the lock screen, sign-in screen and UAC prompts).");
        // Restart automatically if it ever crashes.
        Sc("failure", ServiceName, "reset=", "86400", "actions=", "restart/3000/restart/5000/restart/30000");

        // Let services generate Ctrl+Alt+Del (SendSAS). 1 = services, 3 = services + ease of access apps.
        try
        {
            using var key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System");
            var current = key.GetValue("SoftwareSASGeneration") as int? ?? 0;
            if (current is not (1 or 3)) key.SetValue("SoftwareSASGeneration", current == 2 ? 3 : 1, RegistryValueKind.DWord);
            Console.WriteLine("Enabled software Ctrl+Alt+Del for services.");
        }
        catch (Exception ex) { Console.WriteLine($"Warning: could not enable software SAS: {ex.Message}"); }

        // Inbound firewall rule (private + domain networks; public Wi-Fi stays closed).
        Run("netsh", $"advfirewall firewall delete rule name=\"{FirewallRule}\"", quiet: true);
        Run("netsh", $"advfirewall firewall add rule name=\"{FirewallRule}\" dir=in action=allow program=\"{exe}\" enable=yes profile=private,domain");
        Console.WriteLine("Added firewall rule for private and domain networks.");

        // The data dir holds the password hash, device tokens and the CA key: SYSTEM + Administrators only.
        Directory.CreateDirectory(Paths.DataDir);
        Run("icacls", $"\"{Paths.DataDir}\" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F", quiet: true);
        Console.WriteLine($"Restricted {Paths.DataDir} to SYSTEM and Administrators.");

        if (Sc("start", ServiceName) != 0) return 1;
        Console.WriteLine();
        Console.WriteLine("Headroom is running as a service. It starts with Windows, before anyone signs in.");
        Console.WriteLine("Logs: " + Paths.LogDir);
        return 0;
    }

    private static int Uninstall(bool purge)
    {
        if (Exists())
        {
            Sc("stop", ServiceName);
            Thread.Sleep(1500);
            Sc("delete", ServiceName);
        }
        Run("netsh", $"advfirewall firewall delete rule name=\"{FirewallRule}\"", quiet: true);
        if (purge && Directory.Exists(Paths.DataDir))
        {
            Directory.Delete(Paths.DataDir, recursive: true);
            Console.WriteLine($"Deleted {Paths.DataDir} (pairings, certificates, settings).");
        }
        Console.WriteLine("Service removed.");
        return 0;
    }

    private static int Status()
    {
        if (!Exists()) { Console.WriteLine("Service not installed (user mode). Install with: headroom service install"); return 3; }
        return Sc("query", ServiceName);
    }

    public static bool Exists()
    {
        using var key = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Services\{ServiceName}");
        return key != null;
    }

    private static int Sc(params string[] args) => Run("sc.exe", string.Join(' ', args.Select(Quote)));

    private static string Quote(string a) => a.Contains(' ') && !a.StartsWith('"') ? $"\"{a.Replace("\"", "\\\"")}\"" : a;

    private static int Run(string file, string args, bool quiet = false)
    {
        var psi = new ProcessStartInfo(file, args) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        using var p = Process.Start(psi)!;
        var output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
        p.WaitForExit();
        if (!quiet && (p.ExitCode != 0 || file == "sc.exe" && args.StartsWith("query"))) Console.Write(output);
        return p.ExitCode;
    }
}
