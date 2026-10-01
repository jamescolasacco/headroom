using Headroom.Host.Capture;
using Headroom.Host.Video;

namespace Headroom.Host.Diagnostics;

/// <summary>
/// `headroom selftest [seconds] [out.h264] [encoder]`: enumerates displays, streams the primary monitor
/// through the real pipeline and writes an Annex-B file so the bitstream can be checked with ffprobe.
/// </summary>
public static class SelfTest
{
    private sealed class FileSink : IVideoSink
    {
        private readonly FileStream _file;
        public int Frames, KeyFrames;
        public long Bytes;
        public double EncodeMsTotal;
        public string? Codec;
        public string? Encoder;
        public int Width, Height;

        public FileSink(string path) => _file = File.Create(path);

        public bool CanSendVideo => true;

        public void OnVideoConfig(VideoStreamConfig config)
        {
            Codec = config.Codec;
            Encoder = config.EncoderName;
            Width = config.Width;
            Height = config.Height;
            // avcC -> Annex-B SPS/PPS
            var d = config.Description;
            int spsLen = (d[6] << 8) | d[7];
            WriteNal(d.AsSpan(8, spsLen));
            int ppsOff = 8 + spsLen + 1;
            int ppsLen = (d[ppsOff] << 8) | d[ppsOff + 1];
            WriteNal(d.AsSpan(ppsOff + 2, ppsLen));
            Console.WriteLine($"  config: {config.Codec} {config.Width}x{config.Height} (source {config.SourceWidth}x{config.SourceHeight}) encoder='{config.EncoderName}' hw={config.Hardware}");
        }

        public void OnVideoFrame(EncodedVideoFrame frame)
        {
            Frames++;
            if (frame.KeyFrame) KeyFrames++;
            Bytes += frame.Data.Length;
            EncodeMsTotal += frame.EncodeMs;
            int pos = 0;
            var data = frame.Data;
            while (pos + 4 <= data.Length)
            {
                int len = (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
                WriteNal(data.AsSpan(pos + 4, len));
                pos += 4 + len;
            }
        }

        private void WriteNal(ReadOnlySpan<byte> nal)
        {
            _file.Write(new byte[] { 0, 0, 0, 1 });
            _file.Write(nal);
        }

        public void OnCaptureStatus(CaptureStatus status, string? detail) => Console.WriteLine($"  capture status: {status} {detail}");

        public void Close() => _file.Dispose();
    }

    public static int Run(string[] args)
    {
        int seconds = args.Length > 0 && int.TryParse(args[0], out var s) ? s : 5;
        string path = args.Length > 1 ? args[1] : Path.Combine(Path.GetTempPath(), "headroom-selftest.h264");
        string pref = args.Length > 2 ? args[2] : "auto";

        Console.WriteLine("Displays:");
        var monitors = Displays.Enumerate();
        foreach (var m in monitors)
            Console.WriteLine($"  {m.Id} '{m.Name}' {m.Width}x{m.Height} at ({m.X},{m.Y}) {m.RefreshHz}Hz scale {m.Scale:0.##} rot {m.Rotation} primary={m.Primary} gpu='{m.AdapterName}'");
        if (monitors.Count == 0) { Console.WriteLine("no monitors"); return 1; }

        var sink = new FileSink(path);
        var pipeline = new VideoPipeline(new PipelineSettings
        {
            Monitor = monitors[0],
            MaxFps = 60,
            BitrateKbps = 15000,
            EncoderPreference = pref,
        }, sink, 0);
        Console.WriteLine($"Streaming {monitors[0].Id} for {seconds}s (move some windows around for motion)...");
        Thread.Sleep(seconds * 1000);
        pipeline.Dispose();
        sink.Close();
        Console.WriteLine($"Frames: {sink.Frames} (keyframes {sink.KeyFrames}), {sink.Bytes / 1024} KiB, " +
                          $"avg {(sink.Frames > 0 ? sink.Bytes / sink.Frames / 1024.0 : 0):0.0} KiB/frame, " +
                          $"avg encode {(sink.Frames > 0 ? sink.EncodeMsTotal / sink.Frames : 0):0.00} ms, " +
                          $"skipped(flow) {pipeline.FramesSkippedForFlowControl}");
        Console.WriteLine($"Wrote {path}");
        return sink.Frames > 0 ? 0 : 2;
    }
}
