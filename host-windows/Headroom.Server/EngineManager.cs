using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Headroom.Server;

/// <summary>
/// Owns the relationship with the engine (headroom.exe):
///  * service mode — the Windows service runs it; we only start/stop the service (elevated);
///  * user mode — we run `headroom.exe run` ourselves, hidden, inside a kill-on-close job object so the
///    engine never outlives this tray app.
/// </summary>
public sealed class EngineManager : IDisposable
{
    private Process? _child;
    private readonly nint _job = CreateKillOnCloseJob();

    public static string EnginePath
    {
        get
        {
            var env = Environment.GetEnvironmentVariable("HEADROOM_ENGINE");
            if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;
            return Path.Combine(AppContext.BaseDirectory, "headroom.exe");
        }
    }

    public static bool EngineExists => File.Exists(EnginePath);

    public static bool ServiceInstalled
    {
        get
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\Headroom");
            return key != null;
        }
    }

    public bool OwnsEngine => _child is { HasExited: false };

    /// <summary>Starts the engine in user mode. Returns false if there's no engine binary next to us.</summary>
    public bool StartUserMode()
    {
        if (OwnsEngine) return true;
        if (!EngineExists) return false;
        var psi = new ProcessStartInfo(EnginePath, "run")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = Path.GetDirectoryName(EnginePath)!,
        };
        _child = Process.Start(psi);
        if (_child != null && _job != 0) AssignProcessToJobObject(_job, _child.Handle);
        return _child != null;
    }

    public void StopUserMode()
    {
        if (_child == null) return;
        try
        {
            if (!_child.HasExited)
            {
                _child.Kill(entireProcessTree: true);
                _child.WaitForExit(3000);
            }
        }
        catch { }
        _child.Dispose();
        _child = null;
    }

    /// <summary>Start/stop the Windows service (shows a UAC prompt).</summary>
    public static bool ControlService(bool start)
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo("sc.exe", $"{(start ? "start" : "stop")} Headroom")
            {
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
            });
            p?.WaitForExit(15000);
            return p?.ExitCode == 0;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false; // user declined the UAC prompt
        }
    }

    public void Dispose()
    {
        StopUserMode();
        if (_job != 0) CloseHandle(_job);
    }

    // ------------------------------------------------------------------ job object

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS { public ulong a, b, c, d, e, f; }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern nint CreateJobObjectW(nint attrs, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(nint job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(nint job, nint process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(nint h);

    private static nint CreateKillOnCloseJob()
    {
        var job = CreateJobObjectW(0, null);
        if (job == 0) return 0;
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
        SetInformationJobObject(job, 9, ref info, Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());
        return job;
    }
}
