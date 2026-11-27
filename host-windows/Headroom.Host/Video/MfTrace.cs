using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using SharpGen.Runtime;

namespace Headroom.Host.Video;

/// <summary>
/// HEADROOM_TRACE_MF=1: a line on stderr before ("&gt;") and after ("&lt;", returned or threw) each Media Foundation and
/// D3D11 call the encoder and the converter make, written straight to the handle before the call goes ahead, so the
/// last lines before a crash name the call and the thread it was on. Off unless asked for (the encoder teardown test
/// turns it on).
/// </summary>
public static class MfTrace
{
    public static bool Enabled = Environment.GetEnvironmentVariable("HEADROOM_TRACE_MF") == "1";
    /// <summary>The round of a test that repeats, on every line.</summary>
    public static int Round;

    private static readonly object Gate = new();
    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static Stream? _stderr;

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    /// <summary><c>using (MfTrace.Call("IMFTransform.ProcessInput")) _mft.ProcessInput(...);</c></summary>
    public static Scope Call(string call)
    {
        if (!Enabled) return default;
        Write('>', call);
        return new Scope(call);
    }

    /// <summary>The same, naming the object it's called on (its native pointer).</summary>
    public static Scope Call(string call, CppObject? on)
    {
        if (!Enabled) return default;
        return Call($"{call} {(on == null ? "null" : on.NativePointer.ToString("X", CultureInfo.InvariantCulture))}");
    }

    public static void Note(string text)
    {
        if (Enabled) Write('#', text);
    }

    private static void Write(char mark, string text)
    {
        string line = string.Format(CultureInfo.InvariantCulture, "[mf] {0:F3} tid {1} {2} r{3} {4} {5}\n",
            Clock.Elapsed.TotalMilliseconds, GetCurrentThreadId(), Thread.CurrentThread.Name ?? "-", Volatile.Read(ref Round), mark, text);
        byte[] bytes = Encoding.UTF8.GetBytes(line);
        lock (Gate)
        {
            try
            {
                _stderr ??= Console.OpenStandardError();
                _stderr.Write(bytes, 0, bytes.Length);
                _stderr.Flush();
            }
            catch { }
        }
    }

    public readonly struct Scope : IDisposable
    {
        private readonly string? _call;

        internal Scope(string call) => _call = call;

        public void Dispose()
        {
            if (_call != null) Write('<', _call);
        }
    }
}
