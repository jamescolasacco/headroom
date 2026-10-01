using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Headroom.Host.Platform;
using Headroom.Host.Services;
using Headroom.Host.Util;

namespace Headroom.Host.Service;

/// <summary>
/// "Service mode" (like RealVNC Server's): a LocalSystem service in session 0 that keeps one agent
/// process (`headroom agent`) running *as SYSTEM inside the active console session*. Being SYSTEM on
/// that session's window station is what allows capturing and controlling the secure desktop (UAC
/// prompts, lock screen, sign-in screen) — a normal user process gets E_ACCESSDENIED there.
///
/// The service:
///   * relaunches the agent whenever the console session changes (sign-in/out, fast user switching)
///     or the agent exits;
///   * puts the agent in a kill-on-close job object so it never outlives the service;
///   * performs Ctrl+Alt+Del (SendSAS) on the agent's behalf over a named pipe.
/// </summary>
public sealed class HeadroomService : BackgroundService
{
    private nint _job;
    private nint _agentProcess;
    private uint _agentSession = uint.MaxValue;
    private int _failures;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Log.Info("service", $"Headroom service started (pid {Environment.ProcessId})");
        _job = CreateKillOnCloseJob();
        var sasTask = Task.Run(() => SasPipeLoop(stoppingToken), stoppingToken);
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try { Supervise(); }
                catch (Exception ex) { Log.Error("service", "supervisor error", ex); }
                await Task.Delay(1000, stoppingToken);
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            KillAgent("service stopping");
            if (_job != 0) Native.CloseHandle(_job);
            Log.Info("service", "Headroom service stopped");
        }
        try { await sasTask; } catch { }
    }

    private void Supervise()
    {
        uint session = Native.WTSGetActiveConsoleSessionId();
        if (session == 0xFFFFFFFF)
        {
            // Console is transitioning (e.g. during sign-out). Wait.
            if (_agentProcess != 0) KillAgent("no active console session");
            return;
        }
        bool alive = _agentProcess != 0 && Native.WaitForSingleObject(_agentProcess, 0) == 0x102 /* WAIT_TIMEOUT */;
        if (alive && session == _agentSession) return;

        if (_agentProcess != 0)
        {
            if (!alive && Native.GetExitCodeProcess(_agentProcess, out var code))
            {
                _failures++;
                Log.Warn("service", $"agent exited with code {code}");
            }
            KillAgent(session != _agentSession ? $"console session changed {_agentSession} -> {session}" : "agent not running");
            if (_failures > 0)
            {
                // Back off on crash loops (e.g. port in use because someone runs `headroom run` manually).
                Thread.Sleep(Math.Min(10_000, 1000 * (1 << Math.Min(_failures, 4))));
            }
        }
        LaunchAgent(session);
    }

    private void LaunchAgent(uint session)
    {
        nint self = 0, dup = 0, env = 0;
        try
        {
            if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ALL_ACCESS, out self)) throw new Win32Exception();
            if (!Native.DuplicateTokenEx(self, Native.TOKEN_ALL_ACCESS, 0, Native.SecurityImpersonation, Native.TokenPrimary, out dup)) throw new Win32Exception();
            uint sid = session;
            // Requires SeTcbPrivilege, which LocalSystem has.
            if (!Native.SetTokenInformation(dup, Native.TokenSessionId, ref sid, sizeof(uint))) throw new Win32Exception();
            Native.CreateEnvironmentBlock(out env, dup, false);

            var exe = Environment.ProcessPath ?? throw new InvalidOperationException("no process path");
            var cmd = new StringBuilder($"\"{exe}\" agent");
            var si = new Native.STARTUPINFO { cb = Marshal.SizeOf<Native.STARTUPINFO>(), lpDesktop = @"winsta0\default" };
            if (!Native.CreateProcessAsUserW(dup, null, cmd, 0, 0, false,
                    Native.CREATE_UNICODE_ENVIRONMENT | Native.CREATE_NO_WINDOW | Native.ABOVE_NORMAL_PRIORITY_CLASS,
                    env, Path.GetDirectoryName(exe), ref si, out var pi))
                throw new Win32Exception();
            Native.CloseHandle(pi.hThread);
            if (_job != 0) AssignProcessToJobObject(_job, pi.hProcess);
            _agentProcess = pi.hProcess;
            _agentSession = session;
            Log.Info("service", $"agent started in session {session} (pid {pi.dwProcessId})");
            // Reset the crash counter once an agent has stayed up for a while.
            _ = Task.Delay(60_000).ContinueWith(_ => { if (_agentProcess == pi.hProcess) _failures = 0; });
        }
        catch (Exception ex)
        {
            _failures++;
            Log.Error("service", $"failed to start agent in session {session}: {ex.Message}");
        }
        finally
        {
            if (env != 0) Native.DestroyEnvironmentBlock(env);
            if (dup != 0) Native.CloseHandle(dup);
            if (self != 0) Native.CloseHandle(self);
        }
    }

    private void KillAgent(string reason)
    {
        if (_agentProcess == 0) return;
        Log.Info("service", $"stopping agent: {reason}");
        Native.TerminateProcess(_agentProcess, 0);
        Native.WaitForSingleObject(_agentProcess, 3000);
        Native.CloseHandle(_agentProcess);
        _agentProcess = 0;
        _agentSession = uint.MaxValue;
    }

    // ------------------------------------------------------------------ Ctrl+Alt+Del bridge

    private static void SasPipeLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var security = new PipeSecurity();
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
                using var pipe = NamedPipeServerStreamAcl.Create(ServiceBridge.PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous, 64, 64, security);
                pipe.WaitForConnectionAsync(ct).GetAwaiter().GetResult();
                int req = pipe.ReadByte();
                bool ok = false;
                if (req == 1)
                {
                    try
                    {
                        Native.SendSAS(false);
                        ok = true;
                        Log.Info("service", "sent Ctrl+Alt+Del (SAS)");
                    }
                    catch (Exception ex) { Log.Warn("service", $"SendSAS failed: {ex.Message}"); }
                }
                pipe.WriteByte(ok ? (byte)1 : (byte)0);
                pipe.Flush();
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                Log.Warn("service", $"SAS pipe error: {ex.Message}");
                Thread.Sleep(500);
            }
        }
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

    private static nint CreateKillOnCloseJob()
    {
        var job = CreateJobObjectW(0, null);
        if (job == 0) return 0;
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, ref info, Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());
        return job;
    }
}
