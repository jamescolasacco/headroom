using System.Collections.Concurrent;
using System.Text;

namespace Headroom.Host.Util;

/// <summary>
/// Tiny, allocation-light logger that writes to the console (when attached) and a rolling file in the data dir.
/// Deliberately independent of Microsoft.Extensions.Logging so the capture/encode threads can log cheaply.
/// </summary>
public static class Log
{
    public enum Level { Debug, Info, Warn, Error }

    private static readonly BlockingCollection<string> Queue = new(new ConcurrentQueue<string>(), 4096);
    private static StreamWriter? _file;
    private static Thread? _writer;
    public static Level MinLevel { get; set; } = Level.Info;
    public static bool ConsoleEnabled { get; set; } = true;

    public static void Init(string? logDir)
    {
        if (logDir != null)
        {
            try
            {
                Directory.CreateDirectory(logDir);
                var path = Path.Combine(logDir, "headroom.log");
                var info = new FileInfo(path);
                if (info.Exists && info.Length > 8 * 1024 * 1024)
                {
                    var old = Path.Combine(logDir, "headroom.old.log");
                    File.Delete(old);
                    File.Move(path, old);
                }
                _file = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete), new UTF8Encoding(false)) { AutoFlush = true };
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[log] could not open log file: {ex.Message}");
            }
        }
        _writer = new Thread(WriterLoop) { IsBackground = true, Name = "log-writer" };
        _writer.Start();
    }

    private static void WriterLoop()
    {
        foreach (var line in Queue.GetConsumingEnumerable())
        {
            if (ConsoleEnabled)
            {
                try { Console.WriteLine(line); } catch { }
            }
            try { _file?.WriteLine(line); } catch { }
        }
    }

    private static void Write(Level level, string tag, string message)
    {
        if (level < MinLevel) return;
        var line = $"{DateTime.Now:HH:mm:ss.fff} {LevelChar(level)} [{tag}] {message}";
        if (_writer == null)
        {
            Console.WriteLine(line);
            return;
        }
        Queue.TryAdd(line);
    }

    private static char LevelChar(Level l) => l switch { Level.Debug => 'D', Level.Info => 'I', Level.Warn => 'W', _ => 'E' };

    public static void Debug(string tag, string message) => Write(Level.Debug, tag, message);
    public static void Info(string tag, string message) => Write(Level.Info, tag, message);
    public static void Warn(string tag, string message) => Write(Level.Warn, tag, message);
    public static void Error(string tag, string message) => Write(Level.Error, tag, message);
    public static void Error(string tag, string message, Exception ex) => Write(Level.Error, tag, $"{message}: {ex}");

    public static void Flush()
    {
        Queue.CompleteAdding();
        _writer?.Join(1000);
    }
}
