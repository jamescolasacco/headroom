using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Headroom.Host.Config;
using Headroom.Host.Util;

namespace Headroom.Host.Security;

public enum PairResult { Ok, BadCredentials, TotpRequired, RateLimited, NotConfigured }

/// <summary>
/// Password + TOTP + device-token authentication.
///  - The password (PBKDF2-SHA256, 600k iterations) is only used to pair a device.
///  - Pairing returns a 256-bit random bearer token; only its SHA-256 is stored.
///  - Every viewer connection authenticates with that token, so the password never travels again.
///  - Failed attempts are rate limited per IP and globally.
/// </summary>
public static class AuthService
{
    private const int Pbkdf2Iterations = 600_000;
    private static readonly ConcurrentDictionary<string, FailureRecord> Failures = new();
    private static readonly object GlobalGate = new();
    private static readonly Queue<DateTime> GlobalFailures = new();
    private static readonly ConcurrentDictionary<string, OneTimeCode> PairCodes = new();
    private static readonly ConcurrentDictionary<string, Ephemeral> EphemeralTokens = new();

    private sealed class FailureRecord
    {
        public int Count;
        public DateTime BlockedUntil;
        public DateTime LastFailure;
    }

    private sealed record OneTimeCode(DateTime Expires);
    private sealed record Ephemeral(string DeviceId, string Purpose, string Value, DateTime Expires);

    public static bool HasPassword => ConfigStore.Current.Password != null;

    public static void SetPassword(string password)
    {
        if (password.Length < 8) throw new ArgumentException("Password must be at least 8 characters.");
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, Pbkdf2Iterations, HashAlgorithmName.SHA256, 32);
        ConfigStore.Update(c => c.Password = new PasswordRecord
        {
            Iterations = Pbkdf2Iterations,
            Salt = Convert.ToBase64String(salt),
            Hash = Convert.ToBase64String(hash),
        });
    }

    private static bool VerifyPassword(string password)
    {
        var rec = ConfigStore.Current.Password;
        if (rec == null) return false;
        var salt = Convert.FromBase64String(rec.Salt);
        var expected = Convert.FromBase64String(rec.Hash);
        var actual = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, rec.Iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

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

    private static void RecordFailure(IPAddress? ip)
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

    private static void RecordSuccess(IPAddress? ip) => Failures.TryRemove(ip?.ToString() ?? "?", out _);

    // ---------------------------------------------------------------- pairing

    /// <summary>Creates a short single-use pairing code (shown on the host, e.g. as a QR code).</summary>
    public static string CreatePairCode(TimeSpan lifetime)
    {
        foreach (var kv in PairCodes)
            if (kv.Value.Expires < DateTime.UtcNow) PairCodes.TryRemove(kv.Key, out _);
        // 10 chars of Crockford-ish base32 ≈ 50 bits; single use and short-lived.
        const string alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
        var chars = new char[10];
        for (int i = 0; i < chars.Length; i++) chars[i] = alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)];
        var code = new string(chars);
        PairCodes[code] = new OneTimeCode(DateTime.UtcNow + lifetime);
        return code;
    }

    public static (PairResult result, string? token, PairedDevice? device) Pair(
        IPAddress? ip, string? password, string? totp, string? pairCode, string deviceName)
    {
        if (RetryAfter(ip) != null) return (PairResult.RateLimited, null, null);

        bool ok = false;
        if (!string.IsNullOrEmpty(pairCode))
        {
            var normalized = pairCode.Trim().ToUpperInvariant();
            if (PairCodes.TryRemove(normalized, out var oc) && oc.Expires > DateTime.UtcNow) ok = true;
        }
        else
        {
            if (!HasPassword) return (PairResult.NotConfigured, null, null);
            if (!string.IsNullOrEmpty(password) && VerifyPassword(password))
            {
                var cfg = ConfigStore.Current;
                if (cfg.TotpEnabled && cfg.TotpSecret != null)
                {
                    if (string.IsNullOrEmpty(totp)) return (PairResult.TotpRequired, null, null);
                    ok = Totp.Verify(cfg.TotpSecret, totp);
                }
                else ok = true;
            }
        }

        if (!ok)
        {
            RecordFailure(ip);
            return (PairResult.BadCredentials, null, null);
        }
        RecordSuccess(ip);

        var tokenBytes = RandomNumberGenerator.GetBytes(32);
        var token = Base64Url(tokenBytes);
        var device = new PairedDevice
        {
            Id = Base64Url(RandomNumberGenerator.GetBytes(9)),
            Name = string.IsNullOrWhiteSpace(deviceName) ? "Device" : deviceName.Trim()[..Math.Min(64, deviceName.Trim().Length)],
            TokenHash = HashToken(token),
            Created = DateTimeOffset.UtcNow,
            LastAddress = ip?.ToString(),
        };
        ConfigStore.Update(c => c.Devices.Add(device));
        Log.Info("auth", $"paired new device '{device.Name}' ({device.Id}) from {ip}");
        return (PairResult.Ok, token, device);
    }

    /// <summary>Validates a device bearer token. Returns the device or null.</summary>
    public static PairedDevice? ValidateToken(string? token, IPAddress? ip, bool touch = true)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 128) return null;
        if (RetryAfter(ip) != null) return null;
        var hash = HashToken(token);
        var hashBytes = Encoding.ASCII.GetBytes(hash);
        PairedDevice? match = null;
        foreach (var d in ConfigStore.Current.Devices)
        {
            if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(d.TokenHash), hashBytes)) match = d;
        }
        if (match == null)
        {
            RecordFailure(ip);
            return null;
        }
        if (touch)
        {
            var id = match.Id;
            ConfigStore.Update(c =>
            {
                var d = c.Devices.FirstOrDefault(x => x.Id == id);
                if (d != null) { d.LastSeen = DateTimeOffset.UtcNow; d.LastAddress = ip?.ToString(); }
            });
        }
        return match;
    }

    public static bool RevokeDevice(string id)
    {
        bool removed = false;
        ConfigStore.Update(c => removed = c.Devices.RemoveAll(d => d.Id == id) > 0);
        if (removed) Log.Info("auth", $"revoked device {id}");
        return removed;
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
        if (ConfigStore.Current.Devices.All(d => d.Id != e.DeviceId)) return null;
        deviceId = e.DeviceId;
        return e.Value;
    }

    public static string HashToken(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    public static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) — compatible with every authenticator app.</summary>
public static class Totp
{
    private const string B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    private static long _lastUsedStep = -1;

    public static string NewSecret()
    {
        var bytes = RandomNumberGenerator.GetBytes(20);
        var sb = new StringBuilder();
        int buffer = 0, bits = 0;
        foreach (var b in bytes)
        {
            buffer = (buffer << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                sb.Append(B32[(buffer >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }
        if (bits > 0) sb.Append(B32[(buffer << (5 - bits)) & 31]);
        return sb.ToString();
    }

    private static byte[] DecodeBase32(string s)
    {
        s = s.Trim().TrimEnd('=').ToUpperInvariant().Replace(" ", "");
        var output = new List<byte>();
        int buffer = 0, bits = 0;
        foreach (var c in s)
        {
            int v = B32.IndexOf(c);
            if (v < 0) continue;
            buffer = (buffer << 5) | v;
            bits += 5;
            if (bits >= 8)
            {
                output.Add((byte)((buffer >> (bits - 8)) & 0xFF));
                bits -= 8;
            }
        }
        return output.ToArray();
    }

    public static string Compute(string secret, long step)
    {
        var key = DecodeBase32(secret);
        Span<byte> msg = stackalloc byte[8];
        for (int i = 7; i >= 0; i--) { msg[i] = (byte)(step & 0xFF); step >>= 8; }
        var hash = HMACSHA1.HashData(key, msg);
        int offset = hash[^1] & 0x0F;
        int code = ((hash[offset] & 0x7F) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
        return (code % 1_000_000).ToString("D6");
    }

    public static bool Verify(string secret, string code)
    {
        code = code.Trim().Replace(" ", "");
        if (code.Length != 6) return false;
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30;
        for (long s = now - 1; s <= now + 1; s++)
        {
            if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Compute(secret, s)), Encoding.ASCII.GetBytes(code)))
            {
                // Reject replay of a code that was already accepted.
                if (s <= Interlocked.Read(ref _lastUsedStep)) return false;
                Interlocked.Exchange(ref _lastUsedStep, s);
                return true;
            }
        }
        return false;
    }

    public static string ProvisioningUri(string secret, string account) =>
        $"otpauth://totp/Headroom:{Uri.EscapeDataString(account)}?secret={secret}&issuer=Headroom&digits=6&period=30";
}
