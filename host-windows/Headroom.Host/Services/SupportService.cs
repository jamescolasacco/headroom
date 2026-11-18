using System.Security.Cryptography;
using System.Text;
using Headroom.Host.Config;
using Headroom.Host.Security;
using Headroom.Host.Util;

namespace Headroom.Host.Services;

/// <summary>
/// Guest codes, AnyDesk-style. "Let someone connect" makes a 9-digit code (and a link with it); someone with no
/// account and nothing to install enters it in their browser. This PC always asks Accept / Decline first, and the
/// person here decides what the guest may do (control, files, clipboard), and can change it or stop the session at
/// any time.
///
/// The first 4 digits find this PC on the relay; the other 5 are known only here (the relay never sees them), and
/// five wrong tries use the code up. A code works for one accepted guest, for 10 minutes at most. The accepted guest
/// gets a resume key so a dropped connection comes back without asking again: for 2 minutes after it drops, 12 hours
/// at most in all. Nothing is saved. Same behaviour as the Mac host's SupportService.
/// </summary>
public sealed class SupportService
{
    public static SupportService Shared { get; } = new();

    public sealed record Decision(bool ViewOnly, bool Files, bool Clipboard);

    /// <summary>A code to give out: the digits, until when it works, and a link with it.</summary>
    public sealed record NewCode(string Code, DateTime Expires, string Link);

    private sealed class Code
    {
        public required string Slot;
        public required string Secret;
        public required DateTime Expires;
        public int Failures;
        public string Value => Slot + Secret;
    }

    private sealed record Pending(string Id, string Name, string? Ip, string? Country, DateTimeOffset Created, TaskCompletionSource<Decision?> Done);

    private sealed class Session
    {
        public required PairedDevice Device;
        public required string TokenHash;
        public required DateTime Created;
        public DateTime LastSeen;
        public int Active;
        public required SessionRights Rights;
    }

    private static readonly TimeSpan MaxCodeLifetime = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan ApprovalTimeout = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan ResumeGrace = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan MaxSessionAge = TimeSpan.FromHours(12);
    private const int MaxPending = 3;

    private readonly object _gate = new();
    private Code? _code;
    private readonly List<Pending> _pending = new();
    private readonly Dictionary<string, Session> _sessions = new(); // device id -> session

    // ---------------------------------------------------------------- codes

    /// <summary>A new code, replacing any earlier one. Needs the relay connection (it hands out the first 4 digits). Returns the code, or why there's none.</summary>
    public async Task<(NewCode? Code, string? Error)> CreateCodeAsync()
    {
        var (slot, error) = await RelayService.Shared.RequestSlotAsync();
        if (slot == null) return (null, error ?? "Headroom didn't answer. Try again.");
        var secret = string.Concat(Enumerable.Range(0, 5).Select(_ => (char)('0' + RandomNumberGenerator.GetInt32(10))));
        var latest = DateTime.UtcNow + MaxCodeLifetime;
        var c = new Code { Slot = slot.Digits, Secret = secret, Expires = slot.Expires < latest ? slot.Expires : latest };
        lock (_gate) _code = c;
        Log.Info("guest", $"new guest code, valid {Math.Max(0, (c.Expires - DateTime.UtcNow).TotalMinutes):0} min");
        return (new NewCode(c.Value, c.Expires, Link(RelayService.Shared.PublicBase, c.Value)), null);
    }

    private static string Link(string site, string code) => site + "/#code=" + code;

    /// <summary>"Stop sharing": the code stops working (on the relay too).</summary>
    public void CancelCode()
    {
        bool had;
        lock (_gate) { had = _code != null; _code = null; }
        if (had) RelayService.Shared.ReleaseSlot();
    }

    /// <summary>The relay connection dropped: its slots are gone, so is the code.</summary>
    public void RelayDropped()
    {
        lock (_gate) _code = null;
    }

    /// <summary>Checks a code someone typed. Five wrong tries use the code up, so the 5 secret digits can't be guessed.</summary>
    public bool Verify(string? typed)
    {
        var t = Encoding.ASCII.GetBytes(new string((typed ?? "").Where(char.IsAsciiDigit).ToArray()));
        bool withdrawn;
        lock (_gate)
        {
            if (_code == null || _code.Expires <= DateTime.UtcNow) { _code = null; return false; }
            if (CryptographicOperations.FixedTimeEquals(t, Encoding.ASCII.GetBytes(_code.Value))) return true;
            withdrawn = ++_code.Failures >= 5;
            if (withdrawn) _code = null;
        }
        if (withdrawn)
        {
            Log.Warn("guest", "guest code withdrawn after 5 wrong tries");
            RelayService.Shared.ReleaseSlot();
        }
        return false;
    }

    // ---------------------------------------------------------------- approval

    /// <summary>
    /// Asks the person at this PC (the tray app and the settings window show the request). Null if declined, or after
    /// two minutes without an answer.
    /// </summary>
    public async Task<Decision?> RequestApprovalAsync(string name, string? ip, string? country, CancellationToken ct)
    {
        var p = new Pending(AuthService.Base64Url(RandomNumberGenerator.GetBytes(6)), name, ip, country, DateTimeOffset.UtcNow,
            new TaskCompletionSource<Decision?>(TaskCreationOptions.RunContinuationsAsynchronously));
        lock (_gate)
        {
            if (_pending.Count >= MaxPending) return null;
            _pending.Add(p);
        }
        Log.Info("guest", $"'{name}' ({ip ?? "?"}{(country != null ? ", " + country : "")}) asks to connect; waiting for an answer here");
        try
        {
            var timeout = Task.Delay(ApprovalTimeout, ct);
            var done = await Task.WhenAny(p.Done.Task, timeout);
            if (done == p.Done.Task) return p.Done.Task.Result;
            if (!ct.IsCancellationRequested) Log.Info("guest", $"no answer for '{name}' within {ApprovalTimeout.TotalSeconds:0} s: declined");
            return null;
        }
        finally
        {
            lock (_gate) _pending.Remove(p);
        }
    }

    /// <summary>The answer from the tray app or the settings window.</summary>
    public bool Decide(string id, bool accept, bool viewOnly, bool files, bool clipboard)
    {
        Pending? p;
        lock (_gate)
        {
            p = _pending.FirstOrDefault(x => x.Id == id);
            if (p != null) _pending.Remove(p);
        }
        if (p == null) return false;
        Log.Info("guest", $"'{p.Name}' " + (accept
            ? $"accepted{(viewOnly ? " (view only)" : "")}{(files ? ", files" : "")}{(clipboard ? ", clipboard" : "")}"
            : "declined"));
        p.Done.TrySetResult(accept ? new Decision(viewOnly, files, clipboard) : null);
        return true;
    }

    /// <summary>The guest went away while waiting.</summary>
    public void Withdraw(string name, string? ip)
    {
        List<Pending> gone;
        lock (_gate)
        {
            gone = _pending.Where(x => x.Name == name && x.Ip == ip).ToList();
            _pending.RemoveAll(x => x.Name == name && x.Ip == ip);
        }
        foreach (var p in gone) p.Done.TrySetResult(null);
    }

    // ---------------------------------------------------------------- sessions

    /// <summary>
    /// After acceptance: the identity the session runs under and its resume key. Uses up the code; anyone else still
    /// waiting with it is declined.
    /// </summary>
    public (PairedDevice Device, string Token) StartSession(string name, Decision decision, string? ip)
    {
        var token = AuthService.Base64Url(RandomNumberGenerator.GetBytes(32));
        var dev = new PairedDevice
        {
            Id = "guest:" + AuthService.Base64Url(RandomNumberGenerator.GetBytes(6)),
            Name = name,
            TokenHash = AuthService.HashToken(token),
            Created = DateTimeOffset.UtcNow,
            LastAddress = ip,
            ViewOnly = decision.ViewOnly,
        };
        var rights = new SessionRights(!decision.ViewOnly, decision.Files, decision.Clipboard, Guest: true);
        bool hadCode;
        List<Pending> others;
        lock (_gate)
        {
            hadCode = _code != null;
            _code = null;
            others = _pending.ToList();
            _pending.Clear();
            Prune();
            _sessions[dev.Id] = new Session { Device = dev, TokenHash = dev.TokenHash, Created = DateTime.UtcNow, LastSeen = DateTime.UtcNow, Rights = rights };
        }
        if (hadCode) RelayService.Shared.ReleaseSlot();
        foreach (var p in others) p.Done.TrySetResult(null);
        return (dev, token);
    }

    /// <summary>The guest presenting this resume key, if it's still valid.</summary>
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

    public SessionRights? Rights(string deviceId)
    {
        lock (_gate) return _sessions.TryGetValue(deviceId, out var s) ? s.Rights : null;
    }

    /// <summary>The person here changed what a guest may do: applies at once, to the running session too.</summary>
    public bool SetRights(string deviceId, bool? input, bool? files, bool? clipboard)
    {
        lock (_gate)
        {
            if (!_sessions.TryGetValue(deviceId, out var s)) return false;
            var r = s.Rights;
            s.Rights = r with { Input = input ?? r.Input, Files = files ?? r.Files, Clipboard = clipboard ?? r.Clipboard };
            s.Device.ViewOnly = !s.Rights.Input;
        }
        SessionManager.RightsChanged(deviceId);
        return true;
    }

    public void SessionStarted(string deviceId)
    {
        lock (_gate) if (_sessions.TryGetValue(deviceId, out var s)) { s.Active++; s.LastSeen = DateTime.UtcNow; }
    }

    public void SessionEnded(string deviceId)
    {
        lock (_gate) if (_sessions.TryGetValue(deviceId, out var s)) { s.Active = Math.Max(0, s.Active - 1); s.LastSeen = DateTime.UtcNow; }
    }

    /// <summary>Ends a guest's access for good (stopped from here): its resume key stops working.</summary>
    public void Revoke(string deviceId)
    {
        bool removed;
        lock (_gate) removed = _sessions.Remove(deviceId);
        if (removed) Log.Info("guest", $"guest session {deviceId} ended from this PC");
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
            var site = RelayService.Shared.PublicBase;
            lock (_gate)
            {
                Prune();
                return new
                {
                    code = _code == null ? null : new { code = _code.Value, expiresAt = new DateTimeOffset(_code.Expires, TimeSpan.Zero), link = Link(site, _code.Value) },
                    requests = _pending.Select(p => new { id = p.Id, name = p.Name, address = p.Ip, country = p.Country, created = p.Created }).ToList(),
                };
            }
        }
    }
}
