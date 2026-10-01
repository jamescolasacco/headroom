using System.Reflection;
using Headroom.Host.Config;
using Headroom.Host.Platform;
using Headroom.Host.Session;
using Headroom.Host.Util;

namespace Headroom.Host.Services;

/// <summary>Tracks connected viewers: keeps the machine awake while anyone is connected, locks on last disconnect if configured.</summary>
public static class SessionManager
{
    private static readonly object Gate = new();
    private static readonly List<ClientSession> Sessions = new();
    private static Thread? _powerThread;
    private static readonly AutoResetEvent PowerSignal = new(false);

    public static IReadOnlyList<ClientSession> Active
    {
        get { lock (Gate) return Sessions.ToArray(); }
    }

    public static event Action? Changed;

    public static void Register(ClientSession s)
    {
        lock (Gate)
        {
            Sessions.Add(s);
            EnsurePowerThread();
        }
        PowerSignal.Set();
        Changed?.Invoke();
    }

    public static void Unregister(ClientSession s)
    {
        bool last;
        lock (Gate)
        {
            Sessions.Remove(s);
            last = Sessions.Count == 0;
        }
        PowerSignal.Set();
        Changed?.Invoke();
        if (last && ConfigStore.Current.LockOnDisconnect)
        {
            Log.Info("session", "last viewer left; locking workstation");
            Input.InputInjector.Instance.LockWorkstation();
        }
    }

    public static void DisconnectDevice(string deviceId)
    {
        foreach (var s in Active.Where(s => s.Device?.Id == deviceId)) s.Disconnect("device revoked");
    }

    /// <summary>
    /// SetThreadExecutionState is per-thread and lasts until that thread changes it or exits, so a
    /// dedicated long-lived thread owns the "keep awake" request.
    /// </summary>
    private static void EnsurePowerThread()
    {
        if (_powerThread != null) return;
        _powerThread = new Thread(() =>
        {
            bool awake = false;
            while (true)
            {
                PowerSignal.WaitOne(30_000);
                bool want;
                lock (Gate) want = Sessions.Count > 0;
                if (want)
                {
                    // Re-assert periodically; also wakes the display if it was off.
                    Native.SetThreadExecutionState(Native.ES_CONTINUOUS | Native.ES_SYSTEM_REQUIRED | Native.ES_DISPLAY_REQUIRED);
                    if (!awake) Log.Debug("power", "keeping system and display awake while viewers are connected");
                    awake = true;
                }
                else if (awake)
                {
                    Native.SetThreadExecutionState(Native.ES_CONTINUOUS);
                    awake = false;
                }
            }
        }) { IsBackground = true, Name = "power" };
        _powerThread.Start();
    }
}

public static class HostInfo
{
    public static string Version { get; } = typeof(HostInfo).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion?.Split('+')[0] ?? "0.0.0";

    public static string HostId
    {
        get
        {
            var id = ConfigStore.Current.HostId;
            if (id != null) return id;
            id = Security.AuthService.Base64Url(System.Security.Cryptography.RandomNumberGenerator.GetBytes(12));
            ConfigStore.Update(c => c.HostId ??= id);
            return ConfigStore.Current.HostId!;
        }
    }

    public static string Name => string.IsNullOrWhiteSpace(ConfigStore.Current.DisplayName) ? Environment.MachineName : ConfigStore.Current.DisplayName!;

    public static object Describe() => new
    {
        id = HostId,
        name = Name,
        machine = Environment.MachineName,
        os = "windows",
        osVersion = Environment.OSVersion.Version.ToString(),
        version = Version,
    };
}

/// <summary>
/// Requests privileged actions (Ctrl+Alt+Del) from the Headroom service when the agent itself can't
/// perform them. Implemented over a named pipe in <see cref="Service.HeadroomService"/>.
/// </summary>
public static class ServiceBridge
{
    public const string PipeName = "headroom-service";

    public static bool Available => File.Exists(@"\\.\pipe\" + PipeName);

    public static bool RequestSas()
    {
        try
        {
            using var pipe = new System.IO.Pipes.NamedPipeClientStream(".", PipeName, System.IO.Pipes.PipeDirection.InOut);
            pipe.Connect(500);
            pipe.WriteByte(1); // SAS
            return pipe.ReadByte() == 1;
        }
        catch
        {
            return false;
        }
    }
}
