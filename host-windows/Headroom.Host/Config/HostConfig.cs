using System.Text.Json;
using System.Text.Json.Serialization;
using Headroom.Host.Util;

namespace Headroom.Host.Config;

/// <summary>
/// config.json: the same JSON schema (camelCase) and defaults as the Mac host's HostConfig.swift. Unknown fields
/// (including those of older versions) are ignored, so older or newer config files never fail to load.
/// </summary>
public sealed class HostConfig
{
    public const string DefaultServer = "https://relay.colasac.co";

    /// <summary>Stable random id so viewers can recognise this host across address changes.</summary>
    public string? HostId { get; set; }
    /// <summary>HTTPS port for Headroom Viewer on the same network (sessions and file transfer only).</summary>
    public int Port { get; set; } = 7443;
    /// <summary>Loopback-only port for this PC's settings window. 0 disables it.</summary>
    public int HttpHelperPort { get; set; } = 7080;
    /// <summary>The name shown in your account and to people who connect (default: the computer's name).</summary>
    public string? DisplayName { get; set; }

    public VideoSettings Video { get; set; } = new();
    public AudioSettings Audio { get; set; } = new();
    /// <summary>What your own devices (signed in to your account) may do. Guests get what you allow when you accept them.</summary>
    public PermissionSettings Permissions { get; set; } = new();
    public TlsSettings Tls { get; set; } = new();

    /// <summary>Lock the workstation when the last viewer disconnects.</summary>
    public bool LockOnDisconnect { get; set; }
    /// <summary>Show a Windows toast/tray notice when someone connects.</summary>
    public bool NotifyOnConnect { get; set; } = true;

    /// <summary>The Headroom service: accounts, and the relay that makes this computer reachable from anywhere.</summary>
    public string Server { get; set; } = DefaultServer;
    /// <summary>Signed in to a Headroom account (with this computer's own sign-in there), if it is.</summary>
    public AccountLink? Account { get; set; }
}

/// <summary>
/// This computer's sign-in to an account: its own credential there (not the account password) and the last list
/// of sign-ins it received, so it keeps working through a short outage.
/// </summary>
public sealed class AccountLink
{
    public string Server { get; set; } = "";
    public string Email { get; set; } = "";
    public string AccountId { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public string Token { get; set; } = "";
    public List<AccountDevice> Devices { get; set; } = new();
}

/// <summary>A sign-in of the account (a browser, a phone, Headroom Viewer), as the account server describes it to this computer.</summary>
public sealed record AccountDevice
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    /// <summary>SHA-256 (uppercase hex) of the token this device presents to this computer.</summary>
    public string TokenHash { get; init; } = "";
    public bool ViewOnly { get; init; }
}

/// <summary>Who a session belongs to: one of your account's sign-ins ("account:&lt;id&gt;") or a guest ("guest:&lt;id&gt;"). Never saved.</summary>
public sealed class PairedDevice
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>SHA-256 of the bearer token (tokens are 256-bit random, so a fast hash is sufficient).</summary>
    public string TokenHash { get; set; } = "";
    public DateTimeOffset Created { get; set; }
    public DateTimeOffset? LastSeen { get; set; }
    public string? LastAddress { get; set; }
    public bool ViewOnly { get; set; }
}

public sealed class VideoSettings
{
    /// <summary>auto | hardware | software</summary>
    public string Encoder { get; set; } = "auto";
    public int MaxFps { get; set; } = 60;
    /// <summary>Upper bound for adaptive bitrate (kbps).</summary>
    public int MaxBitrateKbps { get; set; } = 40000;
    public int StartBitrateKbps { get; set; } = 12000;
    public int MinBitrateKbps { get; set; } = 800;
}

public sealed class AudioSettings
{
    public bool Enabled { get; set; } = true;
    public int BitrateKbps { get; set; } = 128;
}

public sealed class PermissionSettings
{
    public bool Clipboard { get; set; } = true;
    public bool FileTransfer { get; set; } = true;
    public bool Audio { get; set; } = true;
    public bool Input { get; set; } = true;
}

public sealed class TlsSettings
{
    /// <summary>auto (Tailscale cert when available, else local CA) | local | tailscale | custom</summary>
    public string Mode { get; set; } = "auto";
    public string? CertFile { get; set; }
    public string? KeyFile { get; set; }
    /// <summary>Extra DNS names / IPs to put in the self-signed certificate.</summary>
    public List<string> ExtraNames { get; set; } = new();
}

/// <summary>Loads/saves the config atomically and serializes concurrent mutations.</summary>
public static class ConfigStore
{
    private static readonly object Gate = new();
    private static HostConfig? _current;

    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static HostConfig Current
    {
        get
        {
            lock (Gate)
            {
                return _current ??= Load();
            }
        }
    }

    private static HostConfig Load()
    {
        try
        {
            if (File.Exists(Paths.ConfigFile))
            {
                var json = File.ReadAllText(Paths.ConfigFile);
                var cfg = JsonSerializer.Deserialize<HostConfig>(json, JsonOptions) ?? new HostConfig();
                // Fields of older versions (password, paired devices, ...) are simply ignored.
                if (string.IsNullOrWhiteSpace(cfg.Server)) cfg.Server = HostConfig.DefaultServer;
                // Sign-ins from before email accounts (usernames) don't work any more: start signed out.
                if (cfg.Account is { } a && (string.IsNullOrWhiteSpace(a.Email) || string.IsNullOrEmpty(a.Token) || string.IsNullOrEmpty(a.Server)))
                    cfg.Account = null;
                if (cfg.Account is { } b) b.Devices ??= new();
                return cfg;
            }
        }
        catch (Exception ex)
        {
            Log.Error("config", "failed to read config, using defaults", ex);
        }
        return new HostConfig();
    }

    public static void Reload()
    {
        lock (Gate) _current = Load();
    }

    /// <summary>Mutate and persist under a lock.</summary>
    public static void Update(Action<HostConfig> mutate)
    {
        lock (Gate)
        {
            _current ??= Load();
            mutate(_current);
            SaveLocked(_current);
        }
    }

    private static void SaveLocked(HostConfig cfg)
    {
        Directory.CreateDirectory(Paths.DataDir);
        var tmp = Paths.ConfigFile + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(cfg, JsonOptions));
        File.Move(tmp, Paths.ConfigFile, overwrite: true);
    }
}
