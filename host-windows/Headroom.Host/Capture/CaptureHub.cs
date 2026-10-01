namespace Headroom.Host.Capture;

/// <summary>Ref-counted registry of <see cref="CaptureSource"/>s so several viewers can share one duplication per monitor.</summary>
public static class CaptureHub
{
    private static readonly object Gate = new();
    private static readonly Dictionary<string, (CaptureSource Source, int Refs)> Sources = new(StringComparer.OrdinalIgnoreCase);

    public static CaptureSource Acquire(MonitorInfo monitor)
    {
        lock (Gate)
        {
            if (Sources.TryGetValue(monitor.Id, out var entry))
            {
                Sources[monitor.Id] = (entry.Source, entry.Refs + 1);
                return entry.Source;
            }
            var src = new CaptureSource(monitor);
            Sources[monitor.Id] = (src, 1);
            return src;
        }
    }

    public static void Release(CaptureSource source)
    {
        CaptureSource? toDispose = null;
        lock (Gate)
        {
            if (!Sources.TryGetValue(source.Monitor.Id, out var entry) || !ReferenceEquals(entry.Source, source))
            {
                // Monitor id changed under us; find by reference.
                var kv = Sources.FirstOrDefault(k => ReferenceEquals(k.Value.Source, source));
                if (kv.Key == null) return;
                entry = kv.Value;
                if (entry.Refs <= 1) { Sources.Remove(kv.Key); toDispose = source; }
                else Sources[kv.Key] = (source, entry.Refs - 1);
            }
            else if (entry.Refs <= 1)
            {
                Sources.Remove(source.Monitor.Id);
                toDispose = source;
            }
            else Sources[source.Monitor.Id] = (source, entry.Refs - 1);
        }
        toDispose?.Dispose();
    }
}
