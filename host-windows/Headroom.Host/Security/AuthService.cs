using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Headroom.Host.Config;
using Headroom.Host.Util;

namespace Headroom.Host.Security;

/// <summary>
/// Who may open a session here: your account's sign-ins (each presents a token derived for this computer by the
/// account server; only its SHA-256 is known here) and guests you accepted (with the resume key they were given).
/// Failed attempts are rate limited per address and overall. Same scheme as the Mac host's AuthService.
/// </summary>
public static class AuthService
{
    private static readonly ConcurrentDictionary<string, FailureRecord> Failures = new();
    private static readonly object GlobalGate = new();
    private static readonly Queue<DateTime> GlobalFailures = new();
    private static readonly ConcurrentDictionary<string, Ephemeral> EphemeralTokens = new();

    private sealed class FailureRecord
    {
        public int Count;
        public DateTime BlockedUntil;
        public DateTime LastFailure;
    }

    private sealed record Ephemeral(string DeviceId, string Purpose, string Value, DateTime Expires);

    // ---------------------------------------------------------------- rate limiting

    public static TimeSpan? RetryAfter(IPAddress? ip)
    {
        var key = ip?.ToString() ?? "?";
        if (Failures.TryGetValue(key, out var rec) && rec.BlockedUntil > DateTime.UtcNow)
            return rec.BlockedUntil - DateTime.UtcNow;
        lock (GlobalGate)
        {
            Prune();
            if (GlobalFailures.Count >= 30) return TimeSpan.FromSeconds(60);
        }
        return null;
    }

    private static void Prune()
    {
        while (GlobalFailures.Count > 0 && GlobalFailures.Peek() < DateTime.UtcNow.AddMinutes(-1)) GlobalFailures.Dequeue();
    }

    public static void RecordFailure(IPAddress? ip)
    {
        var key = ip?.ToString() ?? "?";
        var rec = Failures.GetOrAdd(key, _ => new FailureRecord());
        lock (rec)
        {
            if (rec.LastFailure < DateTime.UtcNow.AddHours(-1)) rec.Count = 0;
            rec.Count++;
            rec.LastFailure = DateTime.UtcNow;
            if (rec.Count >= 5)
            {
                // 5 free attempts, then 2s, 4s, 8s ... capped at 15 minutes.
                var seconds = Math.Min(900, Math.Pow(2, rec.Count - 4));
                rec.BlockedUntil = DateTime.UtcNow.AddSeconds(seconds);
            }
        }
        lock (GlobalGate)
        {
            GlobalFailures.Enqueue(DateTime.UtcNow);
            Prune();
        }
        Log.Warn("auth", $"failed authentication from {key} (count {rec.Count})");
    }

    /// <summary>A successful authentication clears the address's failures (it takes valid credentials, so it can't be abused).</summary>
    public static void RecordSuccess(IPAddress? ip) => Failures.TryRemove(ip?.ToString() ?? "?", out _);

    // ---------------------------------------------------------------- session tokens

    /// <summary>Validates a session token: an accepted guest's resume key, or an account sign-in's. Returns who it is, or null.</summary>
    public static PairedDevice? ValidateToken(string? token, IPAddress? ip)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 128) return null;
        if (RetryAfter(ip) != null) return null;
        var hash = HashToken(token);
        // A guest reconnecting with its resume key (checked before the slower path below).
        if (Services.SupportService.Shared.DeviceForHash(hash) is { } guest) { RecordSuccess(ip); return guest; }
        // A sign-in of this computer's account? (If not yet known, it may have signed in moments ago: check in.)
        var acct = Services.AccountService.Shared.DeviceForHash(hash);
        if (acct == null && Services.AccountService.Shared.RefreshForUnknownToken()) acct = Services.AccountService.Shared.DeviceForHash(hash);
        if (acct == null)
        {
            RecordFailure(ip);
            return null;
        }
        // Account sign-ins are managed (and their last-seen kept) by the account server.
        RecordSuccess(ip);
        return new PairedDevice
        {
            Id = Services.AccountService.LocalId(acct.Id), Name = acct.Name, TokenHash = acct.TokenHash,
            Created = DateTimeOffset.UtcNow, LastAddress = ip?.ToString(), ViewOnly = acct.ViewOnly,
        };
    }

    /// <summary>
    /// What a session's owner may do right now, if they still may connect at all: an account sign-in gets this PC's
    /// settings; a guest gets what was allowed when they were accepted (or changed since).
    /// </summary>
    public static SessionRights? Allowed(string? id)
    {
        if (id == null) return null;
        if (id.StartsWith("account:", StringComparison.Ordinal) && Services.AccountService.Shared.Device(id[8..]) is { } a)
        {
            var p = ConfigStore.Current.Permissions;
            return new SessionRights(p.Input && !a.ViewOnly, p.FileTransfer && !a.ViewOnly, p.Clipboard, Guest: false);
        }
        if (id.StartsWith("guest:", StringComparison.Ordinal)) return Services.SupportService.Shared.Rights(id);
        return null;
    }

    // ---------------------------------------------------------------- ephemeral URL tokens (downloads)

    /// <summary>
    /// Short-lived single-purpose token that can safely appear in a URL (e.g. a file download link that
    /// the browser opens itself, where we can't attach an Authorization header).
    /// </summary>
    public static string CreateEphemeral(string deviceId, string purpose, string value, TimeSpan lifetime)
    {
        foreach (var kv in EphemeralTokens)
            if (kv.Value.Expires < DateTime.UtcNow) EphemeralTokens.TryRemove(kv.Key, out _);
        var t = Base64Url(RandomNumberGenerator.GetBytes(24));
        EphemeralTokens[t] = new Ephemeral(deviceId, purpose, value, DateTime.UtcNow + lifetime);
        return t;
    }

    public static string? RedeemEphemeral(string? token, string purpose, out string? deviceId)
    {
        deviceId = null;
        if (token == null || !EphemeralTokens.TryRemove(token, out var e)) return null;
        if (e.Expires < DateTime.UtcNow || e.Purpose != purpose) return null;
        if (Allowed(e.DeviceId) == null) return null;
        deviceId = e.DeviceId;
        return e.Value;
    }

    public static string HashToken(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    public static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>What a session may do besides watching.</summary>
public sealed record SessionRights(bool Input, bool Files, bool Clipboard, bool Guest)
{
    /// <summary>The shape the settings window shows.</summary>
    public object Json => new { input = Input, files = Files, clipboard = Clipboard };
}
