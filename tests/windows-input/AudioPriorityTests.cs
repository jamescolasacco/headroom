using Concentus;
using Headroom.Host.Services;
using Headroom.Host.Session;

// Audio priority on the Windows host, with no sound device: the wire layout (byte for byte as the Mac host's), 24-bit
// conversion, the deterministic test signal (bit for bit as the brief's integer spec), the timeline (silence on the
// clock, gaps closed, nothing captured lost or padded) and what each kind of viewer gets, top-rate Opus decoded back.
internal static class AudioPriorityTests
{
    /// <summary>The framer's clock in these tests: ticks per second.</summary>
    private const long F = 10_000_000;

    internal static async Task Run()
    {
        // This PC's settings are read for Opus without priority: an empty folder of its own gives the defaults.
        Environment.SetEnvironmentVariable("HEADROOM_DATA", Path.Combine(Path.GetTempPath(), "headroom-audio-test-" + Environment.ProcessId));
        WireLayout();
        Pcm24Conversion();
        TestSignal();
        Framer();
        Packetizer();
        CaptureClock();
        Console.WriteLine("Windows audio: wire layout, 24-bit PCM, test signal, timeline on the clock and every viewer's packets passed");
        Transport();
        await Pings();
        Console.WriteLine("Windows audio priority transport: pacing, path estimate, step-down rules and WebSocket pings passed");
    }

    private static bool Near(double? value, double expected, double accuracy = 0.1) => value is { } v && Math.Abs(v - expected) <= accuracy;

    // The Mac host's tests of the same rules (host-macos/Tests/HeadroomKitTests/AudioPriorityTests.swift), with its numbers.
    private static void Transport()
    {
        Check(AudioService.WireKbps(new AudioService.Format(true, true, AudioService.PcmKbps)) == 2304 + 15
              && AudioService.WireKbps(new AudioService.Format(false, true, 510)) == 510 + 15
              && AudioService.WireKbps(new AudioService.Format(false, true, 64)) == 64 + 15, "what each sound costs on the wire");

        // This session's queue: 512 kbps of Opus made (640 B / 10 ms), the path carrying half; the backlog over 300 ms.
        var rate = new AudioRateWatch();
        long queued = 0, written = 0;
        int firstSlow = -1;
        double carriedSlow = 0;
        for (int i = 0; i < 300; i++)
        {
            queued += 640;
            written += 320;
            var verdict = rate.Update(i * 10_000L, 400_000, queued, written);
            if (verdict != null && firstSlow < 0)
            {
                firstSlow = i;
                carriedSlow = verdict.Value;
            }
        }
        Check(firstSlow == 201 && Math.Abs(carriedSlow - 256) <= 3, $"too slow after a 2 s window, ~256 kbps carried ({firstSlow}, {carriedSlow:0.0})");
        rate.Reset();
        queued = 0;
        for (int i = 0; i < 500; i++)
        {
            queued += 2896;
            Check(rate.Update(i * 10_000L, 500_000, queued, 0) == null, "a stall says nothing about the rate");
        }
        rate.Reset();
        queued = written = 0;
        for (int i = 0; i < 500; i++)
        {
            queued += 2896;
            written += 2896;
            Check(rate.Update(i * 10_000L, 500_000, queued, written) == null, "a queue that keeps up isn't too much sound");
        }
        rate.Reset();
        for (int i = 0; i < 600; i++)
        {
            queued += 2896;
            written += 1448;
            Check(rate.Update(i * 10_000L, i % 100 == 99 ? 200_000 : 400_000, queued, written) == null, "a backlog that dips under 300 ms every second");
        }

        var lossless = ClientSession.AudioLadder(true);
        var compressed = ClientSession.AudioLadder(false);
        Check(lossless.Length == 5 && lossless[0].Pcm && lossless.Skip(1).Select(f => f.Kbps).SequenceEqual(new[] { 510, 256, 128, 64 })
              && lossless.All(f => f.Priority) && compressed.Select(f => f.Kbps).SequenceEqual(new[] { 510, 256, 128, 64 }), "the ladders");
        Check(ClientSession.StepDown(lossless, 0, 2000) == 1 && ClientSession.StepDown(compressed, 0, 400) == 1
              && ClientSession.StepDown(compressed, 0, 200) == 2 && ClientSession.StepDown(compressed, 0, 10) == 3
              && ClientSession.StepDown(lossless, 1, 2000) == 2 && ClientSession.StepDown(compressed, 3, 10) == 3,
            "steps down to the highest rate that fits 80% of what was carried, at least one step");

        var pacer = new VideoPacer();
        Check(pacer.Take(1_000_000, 0) == null, "no pace: never held back");
        pacer.SetRate(1600, 0); // 200 kB/s
        int fragment = Wire.PriorityFragmentPayload + Wire.VideoHeaderSize + 4;
        Check(pacer.Take(fragment, 0) == null, "the first fragment goes at once");
        var secondWait = pacer.Take(fragment, 0);
        Check(Near(secondWait, fragment / 200_000.0 * 1_000_000, 5_000), $"the next waits ~83 ms ({secondWait})");
        var spread = new VideoPacer();
        spread.SetRate(1600, 0);
        long clock = 0;
        int sent = 0;
        while (sent < 160_000)
        {
            var hold = spread.Take(fragment, clock);
            if (hold != null) clock += hold.Value;
            else sent += fragment - Wire.VideoHeaderSize - 4;
        }
        Check(Math.Abs(clock - (0.8e6 - fragment / 200_000.0 * 1e6)) <= 60_000, $"a 160 kB frame at 200 kB/s takes ~0.8 s ({clock} µs)");
        spread.SetRate(80_000, clock);
        Check(spread.Burst == 100_000 && spread.FragmentPayload == 16 * 1024, "fast: a 10 ms bucket, 16 KiB fragments");
        spread.SetRate(4000, clock);
        Check(spread.FragmentPayload == 10_000, "fragments of ~20 ms of the pace");
        spread.SetRate(800, clock);
        Check(spread.FragmentPayload == 4096 && new VideoPacer().FragmentPayload == 16 * 1024, "4 KiB at the least, 16 KiB unpaced");
        Check(ClientSession.VideoPaceKbps(2000, 800, null) == 3000 && ClientSession.VideoPaceKbps(100, 800, null) == 1200
              && ClientSession.VideoPaceKbps(3000, 800, 1400) == 1400 && ClientSession.VideoPaceKbps(1000, 800, 10000) == 1500
              && ClientSession.VideoPaceKbps(1000, 800, 20) == 100, "the pace: 1.5x the target, or the path's, never under 100 kbps");

        var path = new VideoPathEstimate();
        Check(path.Add(90_000, 16_000, 1_000_000, 1_540_000, 40, 3750), "a big frame counts");
        Check(Near(path.Kbps(1_600_000), 1184) && Near(path.PathKbps(1_600_000), 1184) && Near(path.PaceKbps(1_600_000), 1184 * 0.97),
            "74 kB in 500 ms: the path's 1184 kbps, paced just under it");
        Check(!path.Add(20_000, 0, 2_000_000, 2_400_000, 40, 3750) && !path.Add(60_000, 0, 2_000_000, 2_070_000, 40, 3750),
            "small or quick frames don't count");
        Check(path.Add(100_000, 4096, 3_000_000, 3_540_000, 40, 1500), "a frame the pace held back");
        var held = path.Samples[path.Samples.Count - 1];
        Check(held.LimitedByPace && Math.Abs(held.Kbps - (100_000 - 4096) * 8 / 500.0) <= 0.1 && Near(path.PaceKbps(3_600_000), held.Kbps * 1.1)
              && Near(path.PathKbps(3_600_000), 1184) && Near(path.Kbps(3_600_000), 1184), "the pace climbs 10%; the path's figure stays");
        Check(path.Add(100_000, 0, 4_000_000, 4_540_000, 40, 1760) && !path.Samples[path.Samples.Count - 1].LimitedByPace
              && Near(path.PathKbps(4_600_000), 1184) && Near(path.PaceKbps(4_600_000), 1184 * 0.97), "paced 10% over the path, it measures the path");
        Check(path.Kbps(4_540_000 + VideoPathEstimate.MaxAgeUs + 1) == null && path.PaceKbps(4_540_000 + VideoPathEstimate.MaxAgeUs + 1) == null,
            "old samples are forgotten");

        // The way to the viewer: 512 kbps of sound into a ~200 kb/s path, the queue growing 1.56 ms per ms, answers coming.
        var backlog = new PathBacklogWatch();
        int firstTick = -1;
        double carriedPath = 0;
        for (int tick = 0; tick < 20; tick++)
        {
            var verdict = backlog.Update(tick * 250_000L, 350 + tick * 390.0, true, tick, tick * 16_000L);
            if (verdict != null && firstTick < 0)
            {
                firstTick = tick;
                carriedPath = verdict.Value;
            }
        }
        Check(firstTick == 9 && Math.Abs(carriedPath - 512 / (1 + 1.56)) <= 2, $"the path carried ~200 kbps ({firstTick}, {carriedPath:0.0})");
        backlog.Reset();
        for (int tick = 0; tick < 20; tick++)
            Check(backlog.Update(tick * 250_000L, 600, false, tick, tick * 16_000L) == null, "the picture yields first");
        backlog.Reset();
        for (int tick = 0; tick < 40; tick++)
            Check(backlog.Update(tick * 250_000L, 2000 - tick * 25.0, true, tick, tick * 8000L) == null, "a draining queue: the sound fits now");
        backlog.Reset();
        for (int tick = 0; tick < 40; tick++)
            Check(backlog.Update(tick * 250_000L, 400 + tick * 250.0, true, 0, 0) == null, "a stall: no answers, nothing learnt");
        backlog.Reset();
        for (int tick = 0; tick < 20; tick++)
            Check(backlog.Update(tick * 250_000L, 290, true, tick, tick * 16_000L) == null, "under 300 ms: nothing to judge");

        Check(ClientSession.PriorityVideoBudget(5000, 40) == 64 * 1024 && ClientSession.PriorityVideoBudget(100_000, 50) == 687_500
              && ClientSession.PriorityVideoBudget(1_000_000, 500) == 6 * 1024 * 1024 && ClientSession.PriorityVideoBudget(0, 50) == 64 * 1024,
            "about 1.1x the BDP in flight, 64 KiB to 6 MiB");
        Check(ClientSession.CongestionDelayMs(true) == 25 && ClientSession.CongestionDelayMs(false) == 60, "congestion at 25 ms of queueing with priority");
        Check(ClientSession.VideoCeiling(40000, 800, 2550) == 37450 && ClientSession.VideoCeiling(2000, 800, 2550) == 800
              && ClientSession.VideoCeiling(40000, 800, 0) == 40000, "the video ceiling leaves room for the sound");
        Check(ClientSession.PriorityStartKbps == 2500, "priority video starts at 2.5 Mb/s");
    }

    /// <summary>The viewer's side of an upgraded connection: what it sent, handed out in reads of a set size; what we write, kept.</summary>
    private sealed class FakeConnection : Stream
    {
        private readonly byte[] _incoming;
        private readonly int _chunk;
        private int _readAt;
        public readonly List<byte> Written = new();
        public TaskCompletionSource HoldBigWrites = new();

        public FakeConnection(byte[] incoming, int chunk, bool hold = false)
        {
            _incoming = incoming;
            _chunk = chunk;
            if (!hold) HoldBigWrites.SetResult();
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Flush() { }
        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public override int Read(byte[] buffer, int offset, int count) => ReadInto(buffer.AsSpan(offset, count));
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => new ValueTask<int>(ReadInto(buffer.Span));

        private int ReadInto(Span<byte> buffer)
        {
            int n = Math.Min(Math.Min(_chunk, buffer.Length), _incoming.Length - _readAt);
            _incoming.AsSpan(_readAt, n).CopyTo(buffer);
            _readAt += n;
            return n;
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            lock (Written) Written.AddRange(buffer.AsSpan(offset, count).ToArray());
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (buffer.Length > 100) await HoldBigWrites.Task;
            lock (Written) Written.AddRange(buffer.ToArray());
        }
    }

    private static async Task Pings()
    {
        // What a browser sends (masked frames), with pongs among other frames: split into reads of any size, they pass
        // through unchanged and the pongs' 8 bytes come out.
        var frames = new List<byte>();
        var key = new byte[] { 0x11, 0x22, 0x33, 0x44 };
        void Frame(int opcode, byte[] payload, bool masked = true)
        {
            frames.Add((byte)(0x80 | opcode));
            int m = masked ? 0x80 : 0;
            if (payload.Length < 126) frames.Add((byte)(m | payload.Length));
            else if (payload.Length < 65536)
            {
                frames.Add((byte)(m | 126));
                frames.Add((byte)(payload.Length >> 8));
                frames.Add((byte)payload.Length);
            }
            else
            {
                frames.Add((byte)(m | 127));
                for (int shift = 56; shift >= 0; shift -= 8) frames.Add((byte)((long)payload.Length >> shift));
            }
            if (masked) frames.AddRange(key);
            for (int i = 0; i < payload.Length; i++) frames.Add(masked ? (byte)(payload[i] ^ key[i & 3]) : payload[i]);
        }
        byte[] Payload(long value)
        {
            var b = new byte[8];
            System.Buffers.Binary.BinaryPrimitives.WriteInt64LittleEndian(b, value);
            return b;
        }
        Frame(1, System.Text.Encoding.ASCII.GetBytes("hello"));
        Frame(0xA, Payload(123456789));
        Frame(2, new byte[300]);
        Frame(0xA, new byte[] { 1, 2, 3, 4 });
        Frame(0xA, Payload(-5));
        Frame(9, Array.Empty<byte>());
        Frame(2, new byte[70_000]);
        Frame(0xA, Payload(42), masked: false);
        Frame(8, new byte[] { 3, 0xE8 });
        var bytes = frames.ToArray();
        foreach (int chunk in new[] { 1, 3, 7, 4096, bytes.Length })
        {
            var pings = new PingStream(new FakeConnection(bytes, chunk));
            var pongs = new List<long>();
            pings.Pong = pongs.Add;
            var read = new List<byte>();
            var buffer = new byte[5000];
            int n;
            while ((n = await pings.ReadAsync(buffer.AsMemory())) > 0) read.AddRange(buffer.AsSpan(0, n).ToArray());
            Check(read.SequenceEqual(bytes), $"the viewer's frames pass through unchanged (reads of {chunk})");
            Check(pongs.SequenceEqual(new long[] { 123456789, -5, 42 }), $"pongs found in reads of {chunk}: {string.Join(", ", pongs)}");
        }

        // A ping: 10 bytes (FIN + ping, not masked, its 8 bytes little-endian), never inside a frame being written.
        var connection = new FakeConnection(Array.Empty<byte>(), 1, hold: true);
        var stream = new PingStream(connection);
        var big = new byte[1000];
        Array.Fill(big, (byte)7);
        var frameWrite = stream.WriteAsync(big).AsTask();
        var ping = stream.SendPingAsync(0x0102030405060708);
        await Task.Delay(50);
        Check(connection.Written.Count == 0 && !ping.IsCompleted, "a ping waits for the frame being written");
        connection.HoldBigWrites.SetResult();
        await Task.WhenAll(frameWrite, ping);
        Check(connection.Written.SequenceEqual(big.Concat(new byte[] { 0x89, 8, 8, 7, 6, 5, 4, 3, 2, 1 })), "the ping goes after the whole frame");

        // The session over (the connection let go): no more pings, and one waiting behind a frame being written is dropped.
        var closing = new FakeConnection(Array.Empty<byte>(), 1, hold: true);
        var closingStream = new PingStream(closing);
        var lastFrame = closingStream.WriteAsync(big).AsTask();
        var queuedPing = closingStream.SendPingAsync(99);
        closingStream.Dispose();
        Check(!closingStream.TrySendPing(100), "no ping once the connection is let go");
        closing.HoldBigWrites.SetResult();
        await Task.WhenAll(lastFrame, queuedPing);
        Check(closing.Written.SequenceEqual(big), "a ping waiting when the connection went is dropped");
    }

    private static void Check(bool ok, string what)
    {
        if (!ok) throw new Exception("Audio: " + what);
    }

    private static void WireLayout()
    {
        var opus = Wire.Audio(Wire.AudioCodec.Opus, 0x01020304, 0x1122334455667788, new byte[] { 9, 8 });
        Check(opus.SequenceEqual(new byte[] { 3, 0, 0, 0, 4, 3, 2, 1, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 9, 8 }), "Opus packet layout");
        Check(Wire.Audio(0x01020304, 0x1122334455667788, new byte[] { 9, 8 }).SequenceEqual(opus), "the old Audio() is codec 0, as before");
        var silence = Wire.Audio(Wire.AudioCodec.Silence, 7, -1, Wire.SilencePayload());
        Check(silence.SequenceEqual(new byte[] { 3, 2, 0, 0, 7, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 0xE0, 0x01 }), "silence packet layout");
        var pcm = Wire.Audio(Wire.AudioCodec.Pcm24, 1, 0, new byte[Wire.PcmPayloadSize]);
        Check(pcm.Length == 16 + 2880 && pcm[1] == 1 && Wire.PriorityFragmentPayload == 16 * 1024, "PCM packet size, priority fragments");
    }

    private static void Pcm24Conversion()
    {
        for (int k = -8388608; k < 8388608; k += 4099)
            if (Wire.Pcm24(k / 8388608f) != k) Check(false, $"k / 2^23 comes back exactly ({k})");
        foreach (int k in new[] { -8388608, -8388607, -1, 0, 1, 8388606, 8388607 })
            Check(Wire.Pcm24(k / 8388608f) == k, $"k / 2^23 comes back exactly ({k})");
        Check(Wire.Pcm24(1f) == 8388607 && Wire.Pcm24(2f) == 8388607 && Wire.Pcm24(float.PositiveInfinity) == 8388607, "clipped at the top");
        Check(Wire.Pcm24(-1f) == -8388608 && Wire.Pcm24(-2f) == -8388608 && Wire.Pcm24(float.NegativeInfinity) == -8388608, "clipped at the bottom");
        Check(Wire.Pcm24(float.NaN) == 0 && Wire.Pcm24(-0f) == 0, "NaN and -0 are 0");
        Check(Wire.Pcm24(0.5f / 8388608f) == 1 && Wire.Pcm24(-0.5f / 8388608f) == -1 && Wire.Pcm24(2.5f / 8388608f) == 3
              && Wire.Pcm24(0.25f / 8388608f) == 0, "rounded to nearest, halves away from zero (as the Mac host)");
        var bytes = new byte[9];
        Check(!Wire.WritePcm24(new[] { -1f, 1f / 8388608f, -8388607f / 8388608f }, bytes)
              && bytes.SequenceEqual(new byte[] { 0x00, 0x00, 0x80, 0x01, 0x00, 0x00, 0x01, 0x00, 0x80 }), "signed 24-bit little-endian");
        Check(Wire.WritePcm24(new[] { 0f, -0f, 1e-9f }, bytes), "below half a 24-bit step is digital silence");
    }

    private static void TestSignal()
    {
        // The reference: the brief's integer spec run on its own (FNV-1a over the 24-bit values of the first 192000
        // frames, int32 little-endian, L then R), and some frames.
        var music = new TestMusic();
        uint hash = 2166136261;
        var frames = new Dictionary<long, (int, int)>();
        for (long n = 0; n < 192960; n++)
        {
            var (l, r) = music.NextQ();
            if (n < 192000)
                foreach (int q in new[] { l, r })
                    for (int b = 0; b < 4; b++) hash = (hash ^ (byte)(q >> (8 * b))) * 16777619;
            if (n is 0 or 1 or 479 or 480 or 1000 or 143999 or 144000 or 191999 or 192000 or 192959) frames[n] = (l, r);
        }
        Check(hash == 0xB6438678, $"the test signal, bit for bit (checksum {hash:x8})");
        Check(frames[0] == (-2059870, 324026) && frames[1] == (-1607090, -113075) && frames[479] == (-59564, 879179)
              && frames[480] == (108425, 494410) && frames[1000] == (1185185, -618411) && frames[143999] == (-1620527, -216559)
              && frames[144000] == (0, 0) && frames[191999] == (0, 0) && frames[192000] == (-1578219, 489268)
              && frames[192959] == (733659, 146345), "the test signal's frames");
        var floats = new TestMusic();
        var ints = new TestMusic();
        var buffer = new float[960];
        floats.Next(buffer);
        for (int i = 0; i < 480; i++)
        {
            var (l, r) = ints.NextQ();
            Check(buffer[2 * i] == l / 8388608f && buffer[2 * i + 1] == r / 8388608f && Wire.Pcm24(buffer[2 * i]) == l, "the test signal as floats: q / 2^23 exactly");
        }
        // The first packet's PCM payload: the FNV-1a the Mac host's tests and the lab's checker pin too.
        var payload = new byte[Wire.PcmPayloadSize];
        Wire.WritePcm24(buffer, payload);
        uint h = 0x811C9DC5;
        foreach (byte b in payload) h = (h ^ b) * 16777619;
        Check(h == 0x7E824ADA, $"the first packet's PCM, as on the Mac and in the lab's checker ({h:x8})");
    }

    private static long Ms(int ms) => ms * F / 1000;

    /// <summary>Frames start .. start + n - 1 of a ramp that's never 0: L = i + 1, R = -(i + 1).</summary>
    private static float[] Ramp(int start, int n)
    {
        var a = new float[n * 2];
        for (int i = 0; i < n; i++)
        {
            a[2 * i] = start + i + 1;
            a[2 * i + 1] = -(start + i + 1);
        }
        return a;
    }

    private static bool Counts(IEnumerable<float> values, int first) => values.Select((v, i) => v == first + i).All(ok => ok);

    private static void Framer()
    {
        var sent = new List<(float[] Data, bool Captured, long Start)>();
        AudioFramer New()
        {
            sent.Clear();
            return new AudioFramer((frame, captured, start) => sent.Add(((float[])frame.Clone(), captured, start)), F);
        }
        // The left channel of every frame sent, in order.
        List<float> Left() => sent.SelectMany(s => Enumerable.Range(0, 480).Select(i => s.Data[2 * i])).ToList();

        // Without priority: the captured samples in order, whatever the packet sizes; a frame's time is its first sample's.
        var framer = New();
        long t0 = Ms(1000), pos = 0;
        foreach (int n in new[] { 441, 480, 512, 1000, 7 })
        {
            framer.Push(Ramp((int)pos, n), false, t0 + pos * F / 48000, pos, false);
            pos += n;
        }
        Check(sent.Count == 5 && sent.All(s => s.Captured) && Counts(Left(), 1), "frames are the captured samples in order");
        for (int k = 0; k < sent.Count; k++)
            Check(Math.Abs(sent[k].Start - (t0 + 480L * k * F / 48000)) <= 1, "a frame's time is its first sample's capture time");
        // ... and a glitch the device reports changes nothing there, as before.
        framer = New();
        framer.Push(Ramp(0, 480), false, t0, 0, false);
        framer.Push(Ramp(480, 480), false, t0 + Ms(20), 960, true);
        Check(sent.Count == 2 && Counts(Left(), 1), "without priority, no silence is ever added");

        // Priority: 100 ms of sound, then the device goes quiet (WASAPI loopback while nothing plays). After sound the
        // clock waits 200 ms (a stalled capture thread never gets silence put into its sound), then adds silence up to
        // 40 ms behind; when sound comes back, the gap is closed so it lands where it was captured.
        framer = New();
        framer.Continuous = true;
        t0 = Ms(5000);
        for (int k = 0; k < 10; k++) framer.Push(Ramp(480 * k, 480), false, t0 + Ms(10 * k), 480L * k, false);
        for (int ms = 110; ms <= 300; ms += 10) framer.Fill(t0 + Ms(ms));
        Check(sent.Count == 10, "no silence within 200 ms of sound");
        for (int ms = 310; ms <= 1000; ms += 10) framer.Fill(t0 + Ms(ms));
        framer.Push(Ramp(100_000, 4800), false, t0 + Ms(980), 777_777, false);
        var left = Left();
        Check(left.Count == 51840 && Counts(left.Take(4800), 1) && left.Skip(4800).Take(47040 - 4800).All(v => v == 0)
              && Counts(left.Skip(47040), 100_001), "silence on the clock while the device is quiet; sound back exactly where it was captured");
        for (int k = 0; k < sent.Count; k++)
        {
            Check(Math.Abs(sent[k].Start - (t0 + Ms(10 * k))) <= 1, $"every frame on the clock (frame {k})");
            Check(sent[k].Captured == (k < 10 || k >= 98), $"added silence is marked as such (frame {k})");
        }

        // Priority, after digital silence: the clock takes over 40 ms after the device's last packet.
        framer = New();
        framer.Continuous = true;
        framer.Push(new float[960], false, t0, 0, false);
        framer.Fill(t0 + Ms(50));
        Check(sent.Count == 1, "the device may still deliver within 40 ms");
        framer.Fill(t0 + Ms(60));
        Check(sent.Count == 2 && !sent[1].Captured && sent[1].Start == t0 + Ms(10), "after digital silence, silence on the clock");

        // Priority: packets in order are never padded, however their clock times jitter.
        framer = New();
        framer.Continuous = true;
        var jitter = new Random(7);
        for (int k = 0; k < 100; k++) framer.Push(Ramp(480 * k, 480), false, t0 + Ms(10 * k) + jitter.Next(-30_000, 30_001), 480L * k, false);
        left = Left();
        Check(left.Count == 48000 && Counts(left, 1), "packets in order are never padded");
        // ... nor, should the device's positions be no use, packets whose clock times follow on within 5 ms.
        framer = New();
        framer.Continuous = true;
        for (int k = 0; k < 100; k++) framer.Push(Ramp(480 * k, 480), false, t0 + Ms(10 * k) + jitter.Next(-15_000, 15_001), 0, false);
        left = Left();
        Check(left.Count == 48000 && Counts(left, 1), "useless device positions don't pad sound either");

        // Priority: samples the device lost (its position jumps, or it says so) become silence, on time.
        foreach (bool flagged in new[] { false, true })
        {
            framer = New();
            framer.Continuous = true;
            framer.Push(Ramp(0, 480), false, t0, 0, false);
            framer.Push(Ramp(480, 480), false, t0 + Ms(20), flagged ? 480 : 960, flagged);
            left = Left();
            Check(left.Count == 1440 && Counts(left.Take(480), 1) && left.Skip(480).Take(480).All(v => v == 0) && Counts(left.Skip(960), 481),
                "samples the device lost are silence, on time");
        }

        // Priority: a stall in the middle of sound gets no silence; the sound carries on as captured.
        framer = New();
        framer.Continuous = true;
        framer.Push(Ramp(0, 480), false, t0, 0, false);
        framer.Fill(t0 + Ms(160));
        framer.Push(Ramp(480, 480), false, t0 + Ms(10), 480, false);
        left = Left();
        Check(left.Count == 960 && Counts(left, 1), "a stalled capture never gets silence put into its sound");

        // Priority: a late packet the clock's silence already covers. Its leading digital silence in the overlap is
        // skipped; its sound is all kept, right after the clock's silence (and the next packet right after it).
        framer = New();
        framer.Continuous = true;
        long t1 = Ms(10_000);
        for (int ms = 0; ms <= 500; ms += 10) framer.Fill(t1 + Ms(ms)); // quiet from the start: 50 frames of silence
        var late = new float[3000 * 2];
        Array.Copy(Ramp(0, 2500), 0, late, 1000, 5000); // 500 frames of silence, then 2500 of sound
        framer.Push(late, false, t1 + Ms(430), 0, false);
        framer.Push(Ramp(2500, 860), false, t1 + Ms(430) + 3000L * F / 48000, 3000, false);
        left = Left();
        Check(left.Count == 27360 && left.Take(24000).All(v => v == 0) && Counts(left.Skip(24000), 1),
            "late sound kept whole, right after the clock's silence; only digital silence skipped");
        for (int k = 0; k < sent.Count; k++)
            Check(Math.Abs(sent[k].Start - (t1 - Ms(40) + Ms(10 * k))) <= 2 && sent[k].Captured == (k >= 50), $"times stay on the clock (frame {k})");
    }

    private static void Packetizer()
    {
        // The test signal: 3 s of sound, then 1 s of digital silence, again and again.
        var music = new TestMusic();
        var input = new List<float[]>();
        for (int m = 0; m < 1100; m++)
        {
            var frame = new float[960];
            music.Next(frame);
            input.Add(frame);
        }
        var got = new Dictionary<string, List<AudioService.Packet>>();
        Action<AudioService.Packet> Viewer(string name)
        {
            var list = new List<AudioService.Packet>();
            got[name] = list;
            return p => list.Add(p);
        }
        var pcmPriority = Viewer("pcm, priority");
        var opusPriority = Viewer("opus, priority");
        var opus = Viewer("opus");
        var pcm = Viewer("pcm");
        var packets = new AudioPacketizer();
        packets.Add(pcmPriority, new AudioService.Format(true, true, AudioService.PcmKbps));
        packets.Add(opusPriority, new AudioService.Format(false, true, AudioService.PriorityOpusKbps[0]));
        packets.Add(opus, new AudioService.Format(false, false, 0));
        packets.Add(pcm, new AudioService.Format(true, false, 0));
        Check(packets.Count == 4 && packets.AnyPriority && !packets.Add(pcm, new AudioService.Format(true, false, 0)), "viewers");

        // 8 s captured, 0.3 s of silence added on the clock (the device quiet), 1 s captured.
        var timeline = new List<(float[] Frame, bool Captured)>();
        for (int m = 0; m < 800; m++) timeline.Add((input[m], true));
        for (int k = 0; k < 30; k++) timeline.Add((new float[960], false));
        for (int m = 800; m < 900; m++) timeline.Add((input[m], true));
        for (int i = 0; i < timeline.Count; i++) packets.Process(timeline[i].Frame, timeline[i].Captured, 1000L * i);
        bool Silent(int i) => timeline[i].Frame.All(v => v == 0);

        foreach (var name in new[] { "pcm, priority", "opus, priority" })
            Check(got[name].Count == timeline.Count && got[name].Select((p, i) => p.Sequence == i + 1 && p.Timestamp == 1000L * i).All(ok => ok),
                $"{name}: a packet for every frame, numbered +1 each, with its frame's time");
        var expect = new byte[Wire.PcmPayloadSize];
        for (int i = 0; i < timeline.Count; i++)
        {
            var p = got["pcm, priority"][i];
            if (Silent(i)) Check(p.Codec == Wire.AudioCodec.Silence && p.Data.SequenceEqual(new byte[] { 0xE0, 0x01 }), "pcm, priority: digital silence as codec 2");
            else
            {
                Wire.WritePcm24(timeline[i].Frame, expect);
                Check(p.Codec == Wire.AudioCodec.Pcm24 && p.Data.SequenceEqual(expect), "pcm, priority: sound bit for bit");
            }
        }
        for (int i = 0; i < timeline.Count; i++)
        {
            // Opus: the first silent frame after sound still goes through the encoder (it carries the sound's end).
            var want = !Silent(i) || (i > 0 && !Silent(i - 1)) ? Wire.AudioCodec.Opus : Wire.AudioCodec.Silence;
            Check(got["opus, priority"][i].Codec == want, $"opus, priority: frame {i} is {got["opus, priority"][i].Codec}, not {want}");
        }
        var captured = Enumerable.Range(0, timeline.Count).Where(i => timeline[i].Captured).Select(i => (uint)(i + 1)).ToList();
        Check(got["opus"].Select(p => p.Sequence).SequenceEqual(captured) && got["opus"].All(p => p.Codec == Wire.AudioCodec.Opus && p.Data.Length > 0),
            "opus without priority: every captured frame (silent ones too, as before) and none of the clock's silence");
        var pcmWanted = new List<uint>();
        int quiet = 0;
        for (int i = 0; i < timeline.Count; i++)
        {
            if (!timeline[i].Captured) continue;
            quiet = Silent(i) ? quiet + 1 : 0;
            if (quiet <= 20) pcmWanted.Add((uint)(i + 1));
        }
        Check(pcmWanted.Count == 740 && got["pcm"].Select(p => p.Sequence).SequenceEqual(pcmWanted)
              && got["pcm"].All(p => p.Codec == Wire.AudioCodec.Pcm24 && p.Data.Length == 2880),
            "pcm without priority: captured frames, nothing after 200 ms of digital silence");

        // Top-rate Opus decoded as a viewer would: each packet's 10 ms in its own slot, silence packets as zeros.
        var reference = Join(timeline.Select(x => x.Frame).ToList());
        var decoder = OpusCodecFactory.CreateDecoder(48000, 2);
        var decoded = Decode(got["opus, priority"], decoder);
        int delay = BestDelay(reference, decoded, 960 * 10, 960 * 290);
        double all = Snr(reference, decoded, delay, 0, reference.Length, 1);
        double end = Snr(reference, decoded, delay, 960 * 298, 960 * 301, 1);
        double onset = Snr(reference, decoded, delay, 960 * 400, 960 * 402, 1);
        // libopus on this signal: ~20 dB throughout (the signal has noise above Opus's 20 kHz band); without the frame
        // after the sound it would be ~9 dB at the end of each sound and ~8 dB at the next onset.
        Check(all > 12 && end > 14 && onset > 14,
            $"opus, priority at 510 kbps: {all:0.0} dB overall, {end:0.0} dB at the end of a sound, {onset:0.0} dB at the next onset (delay {delay / 2} samples)");

        // A bandwidth step (510 -> 256 kbps) in place, and lossless -> Opus with a fresh encoder.
        packets.Update(opusPriority, new AudioService.Format(false, true, 256));
        packets.Update(pcmPriority, new AudioService.Format(false, true, AudioService.PriorityOpusKbps[0]));
        int before = got["opus, priority"].Count;
        for (int m = 900; m < 1100; m++) packets.Process(input[m], true, 1000L * (timeline.Count + m - 900));
        var stepped = got["opus, priority"].Skip(before).ToList();
        var switched = got["pcm, priority"].Skip(before).ToList();
        var reference2 = Join(input.Skip(900).Take(200).ToList());
        double top = got["opus, priority"].Take(300).Average(p => p.Data.Length), lower = stepped.Average(p => p.Data.Length);
        double steppedSnr = Snr(reference2, Decode(stepped, decoder), delay, 960 * 2, reference2.Length, 1);
        double switchedSnr = Snr(reference2, Decode(switched, OpusCodecFactory.CreateDecoder(48000, 2)), delay, 960 * 2, reference2.Length, 1);
        Check(stepped.Count == 200 && stepped.All(p => p.Codec == Wire.AudioCodec.Opus) && lower < top * 0.75 && steppedSnr > 12,
            $"a step to 256 kbps in place: {top:0} -> {lower:0} bytes a packet, the same decoder carries on at {steppedSnr:0.0} dB");
        Check(switched.Count == 200 && switched.All(p => p.Codec == Wire.AudioCodec.Opus) && switchedSnr > 12,
            $"lossless to Opus: a fresh decoder starts on it at {switchedSnr:0.0} dB");

        foreach (var viewer in new[] { pcmPriority, opusPriority, opus, pcm }) packets.Remove(viewer);
        Check(packets.Count == 0 && !packets.AnyPriority, "viewers removed");
        packets.Process(input[0], true, 0);
    }

    private static float[] Join(List<float[]> frames)
    {
        var all = new float[frames.Count * 960];
        for (int i = 0; i < frames.Count; i++) Array.Copy(frames[i], 0, all, i * 960, 960);
        return all;
    }

    private static float[] Decode(List<AudioService.Packet> packets, IOpusDecoder decoder)
    {
        var all = new float[packets.Count * 960];
        var frame = new float[960];
        for (int i = 0; i < packets.Count; i++)
        {
            if (packets[i].Codec != Wire.AudioCodec.Opus) continue;
            Check(decoder.Decode(packets[i].Data, frame, 480, false) == 480, "an Opus packet decodes to 10 ms");
            Array.Copy(frame, 0, all, i * 960, 960);
        }
        return all;
    }

    /// <summary>decoded[i] against reference[i - delay] (values, 2 per stereo frame) over [from, to), every step-th value.</summary>
    private static double Snr(float[] reference, float[] decoded, int delay, int from, int to, int step)
    {
        double signal = 0, error = 0;
        for (int i = from; i < to; i += step)
        {
            double r = i - delay >= 0 ? reference[i - delay] : 0;
            double e = decoded[i] - r;
            signal += r * r;
            error += e * e;
        }
        return error == 0 ? 99 : 10 * Math.Log10(signal / error);
    }

    /// <summary>The codec's delay, in values: the alignment that matches best.</summary>
    private static int BestDelay(float[] reference, float[] decoded, int from, int to)
    {
        int best = 0;
        double bestSnr = double.MinValue;
        for (int delay = 0; delay < 960; delay += 2)
        {
            double snr = Snr(reference, decoded, delay, from, to, 7);
            if (snr > bestSnr)
            {
                bestSnr = snr;
                best = delay;
            }
        }
        return best;
    }

    private static void CaptureClock()
    {
        long now = 1_000_000_000_000;
        Check(AudioService.CaptureTicks(now - 150_000, true, 480, now, 10_000_000) == now - 150_000, "WASAPI's capture time, 10 MHz counter");
        long f = 3_579_545, t = 400_000_000_000;
        long qpc = t / f * 10_000_000 + t % f * 10_000_000 / f; // in 100 ns units, as IAudioCaptureClient::GetBuffer reports it
        Check(Math.Abs(AudioService.CaptureTicks(qpc, true, 480, t + 50_000, f) - t) <= 1, "WASAPI's capture time, another counter rate");
        Check(AudioService.CaptureTicks(qpc, false, 480, t + 50_000, f) == t + 50_000 - 480 * f / 48000, "a time flagged as wrong isn't used");
        Check(AudioService.CaptureTicks(0, true, 480, now, 10_000_000) == now - 100_000, "no time: now less the packet's length");
        Check(AudioService.CaptureTicks(now - 30_000_000, true, 480, now, 10_000_000) == now - 100_000, "a time seconds old isn't believed");
        Check(AudioService.CaptureTicks(now + 10, true, 480, now, 10_000_000) == now - 100_000, "nor one in the future");

        Check(AudioService.IsTestMusic(new[] { "headroom.exe", "run", "--test-audio=music" }), "run --test-audio=music");
        Check(AudioService.IsTestMusic(new[] { "headroom.exe", "--data=C:\\hr", "--test-audio=music" }), "run is the default command");
        Check(AudioService.IsTestMusic(new[] { "headroom.exe", "--webroot=C:\\web", "RUN", "--TEST-AUDIO=MUSIC" }), "any case");
        Check(!AudioService.IsTestMusic(new[] { "headroom.exe", "run" }), "not without the flag");
        Check(!AudioService.IsTestMusic(new[] { "headroom.exe", "agent", "--test-audio=music" }), "never the service's agent");
        Check(!AudioService.IsTestMusic(new[] { "headroom.exe", "service-run", "--test-audio=music" }), "never the service");
        Check(!AudioService.TestMusicMode, "not this test");
    }
}
