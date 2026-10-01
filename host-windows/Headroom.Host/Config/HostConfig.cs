using System.Text.Json;
using System.Text.Json.Serialization;
using Headroom.Host.Util;

namespace Headroom.Host.Config;

public sealed class HostConfig
{
    /// <summary>Stable random id so viewers can recognise this host across address changes.</summary>
    public string? HostId { get; set; }
    public int Port { get; set; } = 7443;
    /// <summary>Plain-HTTP helper port that only serves the CA certificate/profile and redirects to HTTPS. 0 disables it.</summary>
    public int HttpHelperPort { get; set; } = 7080;
    public string? DisplayName { get; set; }

    public PasswordRecord? Password { get; set; }
    /// <summary>Base32 TOTP secret. When set (and TotpEnabled), pairing a new device needs a 6-digit code.</summary>
    public string? TotpSecret { get; set; }
    public bool TotpEnabled { get; set; }

    public List<PairedDevice> Devices { get; set; } = new();

    public VideoSettings Video { get; set; } = new();
    public AudioSettings Audio { get; set; } = new();
    public PermissionSettings Permissions { get; set; } = new();
    public TlsSettings Tls { get; set; } = new();

    /// <summary>Lock the workstation when the last viewer disconnects.</summary>
    public bool LockOnDisconnect { get; set; }
    /// <summary>Show a Windows toast/tray notice when someone connects.</summary>
    public bool NotifyOnConnect { get; set; } = true;
}

public sealed class PasswordRecord
{
    public string Algorithm { get; set; } = "pbkdf2-sha256";
    public int Iterations { get; set; }
    public string Salt { get; set; } = "";
    public string Hash { get; set; } = "";
}

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
                return JsonSerializer.Deserialize<HostConfig>(json, JsonOptions) ?? new HostConfig();
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
