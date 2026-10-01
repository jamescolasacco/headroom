using System.Runtime.InteropServices;
using Headroom.Host.Config;
using Headroom.Host.Input;
using Headroom.Host.Platform;
using Headroom.Host.Security;
using Headroom.Host.Util;

namespace Headroom.Host.Web;

/// <summary>
/// File transfer over plain HTTPS (separate TCP connection, so big transfers never stall the video
/// socket). Browse/upload use the device bearer token; downloads use a short-lived URL token minted over
/// the session socket, because browsers open download links themselves (no custom headers).
/// </summary>
public static class FileApi
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/files/list", (HttpContext ctx, string? path) =>
        {
            if (!Allowed(ctx, out var err)) return err!;
            if (string.IsNullOrWhiteSpace(path)) return Results.Json(new { path = "", parent = (string?)null, entries = Roots() });
            try
            {
                var dir = new DirectoryInfo(path);
                if (!dir.Exists) return Results.Json(new { error = "not found" }, statusCode: 404);
                var entries = new List<object>();
                foreach (var d in Safe(() => dir.EnumerateDirectories()))
                {
                    if ((d.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0) continue;
                    entries.Add(new { name = d.Name, path = d.FullName, dir = true, size = 0L, modified = d.LastWriteTimeUtc });
                }
                foreach (var f in Safe(() => dir.EnumerateFiles()))
                {
                    if ((f.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0) continue;
                    entries.Add(new { name = f.Name, path = f.FullName, dir = false, size = f.Length, modified = f.LastWriteTimeUtc });
                }
                return Results.Json(new { path = dir.FullName, parent = dir.Parent?.FullName ?? "", entries });
            }
            catch (UnauthorizedAccessException)
            {
                return Results.Json(new { error = "access denied" }, statusCode: 403);
            }
        });

        app.MapGet("/api/files/download", (HttpContext ctx, string? t) =>
        {
            if (!ConfigStore.Current.Permissions.FileTransfer) return Results.StatusCode(403);
            var path = AuthService.RedeemEphemeral(t, "download", out _);
            if (path == null) return Results.Json(new { error = "link expired" }, statusCode: 401);
            if (!File.Exists(path)) return Results.NotFound();
            Log.Info("files", $"download {path} -> {ctx.Connection.RemoteIpAddress}");
            var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, FileOptions.Asynchronous | FileOptions.SequentialScan);
            return Results.File(stream, "application/octet-stream", Path.GetFileName(path), enableRangeProcessing: true);
        });

        app.MapPost("/api/files/upload", async (HttpContext ctx, string? dir, string? name) =>
        {
            if (!Allowed(ctx, out var err)) return err!;
            var targetDir = string.IsNullOrWhiteSpace(dir) ? DefaultUploadDir() : dir;
            var fileName = SanitizeName(name);
            if (targetDir == null || fileName == null) return Results.Json(new { error = "bad target" }, statusCode: 400);
            Directory.CreateDirectory(targetDir);
            var final = UniquePath(Path.Combine(targetDir, fileName));
            var temp = final + ".headroom-part";
            try
            {
                await using (var fs = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16, FileOptions.Asynchronous))
                    await ctx.Request.Body.CopyToAsync(fs, 1 << 16, ctx.RequestAborted);
                File.Move(temp, final);
            }
            catch
            {
                try { File.Delete(temp); } catch { }
                throw;
            }
            Log.Info("files", $"upload {final} ({new FileInfo(final).Length} bytes) from {ctx.Connection.RemoteIpAddress}");
            return Results.Json(new { path = final, name = Path.GetFileName(final) });
        });

        app.MapPost("/api/files/mkdir", async (HttpContext ctx) =>
        {
            if (!Allowed(ctx, out var err)) return err!;
            var body = await WebHost.ReadJson(ctx);
            var parent = WebHost.Str(body, "parent");
            var name = SanitizeName(WebHost.Str(body, "name"));
            if (parent == null || name == null) return Results.Json(new { error = "bad name" }, statusCode: 400);
            var p = Path.Combine(parent, name);
            Directory.CreateDirectory(p);
            return Results.Json(new { path = p });
        });
    }

    private static bool Allowed(HttpContext ctx, out IResult? error)
    {
        error = null;
        if (!ConfigStore.Current.Permissions.FileTransfer) { error = Results.Json(new { error = "file transfer disabled on host" }, statusCode: 403); return false; }
        var dev = WebHost.Authenticate(ctx);
        if (dev == null) { error = Results.Json(new { error = "unauthorized" }, statusCode: 401); return false; }
        if (dev.ViewOnly) { error = Results.Json(new { error = "view-only device" }, statusCode: 403); return false; }
        return true;
    }

    private static IEnumerable<T> Safe<T>(Func<IEnumerable<T>> f)
    {
        try { return f().ToList(); } catch { return Array.Empty<T>(); }
    }

    private static string? SanitizeName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        name = Path.GetFileName(name.Replace('\\', '/').Split('/').Last());
        foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        name = name.Trim().TrimEnd('.');
        return name.Length == 0 || name is "." or ".." ? null : name;
    }

    private static string UniquePath(string path)
    {
        if (!File.Exists(path) && !Directory.Exists(path)) return path;
        var dir = Path.GetDirectoryName(path)!;
        var stem = Path.GetFileNameWithoutExtension(path);
        var ext = Path.GetExtension(path);
        for (int i = 1; ; i++)
        {
            var p = Path.Combine(dir, $"{stem} ({i}){ext}");
            if (!File.Exists(p) && !Directory.Exists(p)) return p;
        }
    }

    public static string? DefaultUploadDir() => UserFolders.Get(UserFolders.Downloads) ?? UserFolders.Get(UserFolders.Profile);

    private static List<object> Roots()
    {
        var roots = new List<object>();
        void Add(string label, Guid id)
        {
            var p = UserFolders.Get(id);
            if (p != null && Directory.Exists(p)) roots.Add(new { name = label, path = p, dir = true, size = 0L, modified = (DateTime?)null });
        }
        Add("Desktop", UserFolders.Desktop);
        Add("Documents", UserFolders.Documents);
        Add("Downloads", UserFolders.Downloads);
        Add("Home", UserFolders.Profile);
        foreach (var d in DriveInfo.GetDrives().Where(d => d.IsReady && d.DriveType is DriveType.Fixed or DriveType.Removable or DriveType.Network))
            roots.Add(new { name = $"{d.Name.TrimEnd('\\')} {SafeLabel(d)}".Trim(), path = d.RootDirectory.FullName, dir = true, size = 0L, modified = (DateTime?)null });
        return roots;
    }

    private static string SafeLabel(DriveInfo d)
    {
        try { return d.VolumeLabel; } catch { return ""; }
    }
}

/// <summary>Known folders of the interactive user — also correct when we run as SYSTEM in service mode.</summary>
public static class UserFolders
{
    public static readonly Guid Desktop = new("B4BFCC3A-DB2C-424C-B029-7FE99A87C641");
    public static readonly Guid Documents = new("FDD39AD0-238F-46AF-ADB4-6C85480369C7");
    public static readonly Guid Downloads = new("374DE290-123F-4565-9164-39C4925E467B");
    public static readonly Guid Profile = new("5E6C858F-0E22-4760-9AFE-EA3317B67173");

    [DllImport("shell32.dll")]
    private static extern int SHGetKnownFolderPath(ref Guid rfid, uint flags, nint token, out nint path);

    public static string? Get(Guid id)
    {
        nint token = 0;
        try
        {
            if (InputInjector.IsSystem)
            {
                uint session = Native.WTSGetActiveConsoleSessionId();
                if (!Native.WTSQueryUserToken(session, out token)) return null; // nobody logged on
            }
            if (SHGetKnownFolderPath(ref id, 0, token, out var p) != 0) return null;
            try { return Marshal.PtrToStringUni(p); }
            finally { Marshal.FreeCoTaskMem(p); }
        }
        finally
        {
            if (token != 0) Native.CloseHandle(token);
        }
    }
}
