using System.Security.Cryptography;
using System.Text;
using Headroom.Host.Config;
using Headroom.Host.Security;
using Headroom.Host.Util;

namespace Headroom.Host.Services;

/// <summary>
/// Remote support, AnyDesk-style: the person at this PC creates a one-time code and gives it, with this PC's
/// Headroom ID, to someone who has no account and no pairing. They connect (usually through the relay, from any
/// browser); this PC asks Accept / Decline first unless that's turned off. An accepted session gets a resume key,
/// so a dropped connection reconnects without asking again; it lasts while the session does (plus a few minutes),
/// never longer than 12 hours, and nothing is saved to the config. Same behaviour as the Mac host's SupportService.
/// </summary>
public sealed class SupportService
{
    public static SupportService Shared { get; } = new();

    public sealed record Decision(bool ViewOnly);

    private sealed class Code
    {
        public required string Value;
        public required DateTime Expires;
        public int Failures;
    }

    private sealed record Pending(string Id, string Name, string? Ip, DateTimeOffset Created, TaskCompletionSource<Decision?> Done);

    private sealed class Session
    {
        public required PairedDevice Device;
        public required string TokenHash;
        public required DateTime Created;
        public DateTime LastSeen;
        public int Active;
    }

    private static readonly TimeSpan CodeLifetime = TimeSpan.FromHours(1);
    private static readonly TimeSpan ApprovalTimeout = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan ResumeGrace = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan MaxSessionAge = TimeSpan.FromHours(12);

    private readonly object _gate = new();
    private Code? _code;
    private readonly List<Pending> _pending = new();
    private readonly Dictionary<string, Session> _sessions = new(); // device id -> session

    // ---------------------------------------------------------------- codes

    /// <summary>A new 6-digit code (replacing any earlier one), valid for an hour or until a session it started is accepted.</summary>
    public (string Code, DateTime Expires) CreateCode()
    {
        var value = string.Concat(Enumerable.Range(0, 6).Select(_ => (char)('0' + RandomNumberGenerator.GetInt32(10))));
        var c = new Code { Value = value, Expires = DateTime.UtcNow + CodeLifetime };
        lock (_gate) _code = c;
        Log.Info("support", $"new support code (valid {CodeLifetime.TotalMinutes:0} min)");
        return (value, c.Expires);
    }

    public void CancelCode()
    {
        lock (_gate) _code = null;
    }

    /// <summary>Checks a code someone typed. Five wrong guesses use the code up, so it can't be brute-forced.</summary>
    public bool Verify(string? typed)
    {
        var t = Encoding.ASCII.GetBytes(new string((typed ?? "").Where(char.IsAsciiDigit).ToArray()));
        lock (_gate)
        {
            if (_code == null || _code.Expires <= DateTime.UtcNow) { _code = null; return false; }
            if (CryptographicOperations.FixedTimeEquals(t, Encoding.ASCII.GetBytes(_code.Value))) return true;
            if (++_code.Failures >= 5)
            {
                _code = null;
                Log.Warn("support", "support code withdrawn after 5 wrong guesses");
            }
            return false;
        }
    }

    // ---------------------------------------------------------------- approval

    /// <summary>
    /// Asks the person at this PC (the tray app and the settings page show the request). Null if declined, or after a
    /// minute without an answer.
    /// </summary>
    public async Task<Decision?> RequestApprovalAsync(string name, string? ip, CancellationToken ct)
    {
        if (!ConfigStore.Current.Support.AskBeforeAccepting) return new Decision(false);
        var p = new Pending(AuthService.Base64Url(RandomNumberGenerator.GetBytes(6)), name, ip, DateTimeOffset.UtcNow,
            new TaskCompletionSource<Decision?>(TaskCreationOptions.RunContinuationsAsynchronously));
        lock (_gate) _pending.Add(p);
        Log.Info("support", $"'{name}' ({ip ?? "?"}) asks to connect; waiting for an answer here");
        try
        {
            var done = await Task.WhenAny(p.Done.Task, Task.Delay(ApprovalTimeout, ct));
            if (done != p.Done.Task) Log.Info("support", $"no answer for '{name}' within {ApprovalTimeout.TotalSeconds:0} s: declined");
            return done == p.Done.Task ? p.Done.Task.Result : null;
        }
        catch (OperationCanceledException)
        {
            return null;
        }
        finally
        {
            lock (_gate) _pending.Remove(p);
        }
    }

    /// <summary>The answer from the tray app or the settings page.</summary>
    public bool Decide(string id, bool accept, bool viewOnly)
    {
        Pending? p;
        lock (_gate)
        {
            p = _pending.FirstOrDefault(x => x.Id == id);
            if (p != null) _pending.Remove(p);
        }
        if (p == null) return false;
        Log.Info("support", $"'{p.Name}' {(accept ? (viewOnly ? "accepted (view only)" : "accepted") : "declined")}");
        p.Done.TrySetResult(accept ? new Decision(viewOnly) : null);
        return true;
    }

    // ---------------------------------------------------------------- sessions

    /// <summary>After acceptance: the identity the session runs under and its resume key. Uses up the code.</summary>
    public (PairedDevice Device, string Token) StartSession(string name, bool viewOnly, string? ip)
    {
        var token = AuthService.Base64Url(RandomNumberGenerator.GetBytes(32));
        var dev = new PairedDevice
        {
            Id = "support:" + AuthService.Base64Url(RandomNumberGenerator.GetBytes(6)),
            Name = name,
            TokenHash = AuthService.HashToken(token),
            Created = DateTimeOffset.UtcNow,
            LastAddress = ip,
            ViewOnly = viewOnly,
        };
        lock (_gate)
        {
            _code = null;
            Prune();
            _sessions[dev.Id] = new Session { Device = dev, TokenHash = dev.TokenHash, Created = DateTime.UtcNow, LastSeen = DateTime.UtcNow };
        }
        return (dev, token);
    }

    /// <summary>The support session presenting this resume key, if it's still valid.</summary>
    public PairedDevice? DeviceForHash(string hash)
    {
        var h = Encoding.ASCII.GetBytes(hash);
        lock (_gate)
        {
            Prune();
            PairedDevice? match = null;
            foreach (var s in _sessions.Values)
                if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(s.TokenHash), h)) match = s.Device;
            return match;
        }
    }

    public PairedDevice? Device(string id)
    {
        lock (_gate) return _sessions.TryGetValue(id, out var s) ? s.Device : null;
    }

    public void SessionStarted(string deviceId)
    {
        lock (_gate) if (_sessions.TryGetValue(deviceId, out var s)) { s.Active++; s.LastSeen = DateTime.UtcNow; }
    }

    public void SessionEnded(string deviceId)
    {
        lock (_gate) if (_sessions.TryGetValue(deviceId, out var s)) { s.Active = Math.Max(0, s.Active - 1); s.LastSeen = DateTime.UtcNow; }
    }

    /// <summary>Ends a support session for good (disconnected from here): its resume key stops working.</summary>
    public void Revoke(string deviceId)
    {
        bool removed;
        lock (_gate) removed = _sessions.Remove(deviceId);
        if (removed) Log.Info("support", $"support session {deviceId} ended from this PC");
    }

    public void RevokeAll()
    {
        lock (_gate) _sessions.Clear();
    }

    private void Prune() // under lock
    {
        var now = DateTime.UtcNow;
        foreach (var (id, s) in _sessions.ToArray())
            if (now - s.Created >= MaxSessionAge || (s.Active == 0 && now - s.LastSeen >= ResumeGrace)) _sessions.Remove(id);
        if (_code != null && _code.Expires <= now) _code = null;
    }

    // ---------------------------------------------------------------- status

    public object Status
    {
        get
        {
            lock (_gate)
            {
                Prune();
                return new
                {
                    code = _code == null ? null : new { code = _code.Value, expiresAt = new DateTimeOffset(_code.Expires, TimeSpan.Zero) },
                    requests = _pending.Select(p => new { id = p.Id, name = p.Name, address = p.Ip, created = p.Created }).ToList(),
                    askBeforeAccepting = ConfigStore.Current.Support.AskBeforeAccepting,
                };
            }
        }
    }
}
