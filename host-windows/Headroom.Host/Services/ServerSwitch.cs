using Headroom.Host.Util;

namespace Headroom.Host.Services;

/// <summary>
/// "Stop server" (Headroom Server's window, tray menu): while stopped, nobody can reach this PC. The relay connection
/// closes, so your devices see it as offline; direct connections and guest codes are refused, and any sessions end.
/// The engine keeps running, so the settings window works as usual: sign in, settings, and so on. Not saved: the
/// engine starts it again the next time it starts.
/// </summary>
public sealed class ServerSwitch
{
    public static ServerSwitch Shared { get; } = new();

    private volatile bool _stopped;

    public bool Stopped => _stopped;

    public void Stop()
    {
        if (_stopped) return;
        _stopped = true;
        Log.Info("main", "stopped from Headroom Server: nobody can connect until it's started");
        SupportService.Shared.CancelCode();
        SupportService.Shared.DeclineAll();
        SupportService.Shared.RevokeAll();
        foreach (var s in SessionManager.Active) s.Disconnect("Headroom Server was stopped on this computer");
        // The relay connection closes on its next tick: RelayService wants none while stopped.
    }

    public void Start()
    {
        if (!_stopped) return;
        _stopped = false;
        Log.Info("main", "started from Headroom Server");
    }
}
