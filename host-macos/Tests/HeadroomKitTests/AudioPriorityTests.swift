import COpus
import XCTest
@testable import HeadroomKit

/// Audio priority: the wire format (codecs 0/1/2), 24-bit conversion, silence, the test signal, sample times, and the
/// rules that decide what each viewer gets (silence packets, step-downs, the transport's queue, video budget).
final class AudioPriorityTests: XCTestCase {
    private let scale: Float = 8_388_608 // 2^23

    // ------------------------------------------------------------------ 24-bit conversion

    func testPcm24IsExactForEvery24BitValue() {
        var k: Int32 = -8_388_608
        while k <= 8_388_607 {
            let x = Float(k) / scale
            if Wire.pcm24(x) != k { XCTFail("k=\(k) came back as \(Wire.pcm24(x))"); return }
            k += 1
        }
    }

    func testPcm24Clips() {
        XCTAssertEqual(Wire.pcm24(1.0), 8_388_607)
        XCTAssertEqual(Wire.pcm24(-1.0), -8_388_608)
        XCTAssertEqual(Wire.pcm24(1.5), 8_388_607)
        XCTAssertEqual(Wire.pcm24(-3), -8_388_608)
        XCTAssertEqual(Wire.pcm24(.infinity), 8_388_607)
        XCTAssertEqual(Wire.pcm24(-.infinity), -8_388_608)
        XCTAssertEqual(Wire.pcm24(.greatestFiniteMagnitude), 8_388_607)
        XCTAssertEqual(Wire.pcm24(.nan), 0)
        XCTAssertEqual(Wire.pcm24(8_388_606.6 / scale), 8_388_607)
    }

    func testPcm24RoundsToNearest() {
        XCTAssertEqual(Wire.pcm24(0.4 / scale), 0)
        XCTAssertEqual(Wire.pcm24(0.5 / scale), 1)   // halves away from zero
        XCTAssertEqual(Wire.pcm24(-0.5 / scale), -1)
        XCTAssertEqual(Wire.pcm24(0.6 / scale), 1)
        XCTAssertEqual(Wire.pcm24(-0.6 / scale), -1)
        XCTAssertEqual(Wire.pcm24(1.49 / scale), 1)
        XCTAssertEqual(Wire.pcm24(1.5 / scale), 2)
        XCTAssertEqual(Wire.pcm24(-1.5 / scale), -2)
        XCTAssertEqual(Wire.pcm24(1234.75 / scale), 1235)
        XCTAssertEqual(Wire.pcm24(-0.0), 0)
        XCTAssertEqual(Wire.pcm24(.leastNonzeroMagnitude), 0)
    }

    // ------------------------------------------------------------------ packet layouts

    func testOpusPacketKeepsTheOldLayout() {
        let p = Wire.audio(seq: 0x0102_0304, timeUs: 0x0102_0304_0506_0708, opus: [9, 8, 7])
        XCTAssertEqual(p, [3, 0, 0, 0, 4, 3, 2, 1, 8, 7, 6, 5, 4, 3, 2, 1, 9, 8, 7])
        XCTAssertEqual(Wire.audio(codec: .opus, seq: 0x0102_0304, timeUs: 0x0102_0304_0506_0708, payload: [9, 8, 7]), p)
        // Negative times (before the clock's origin can't happen, but the field is signed).
        XCTAssertEqual(Array(Wire.audio(seq: 1, timeUs: -1, opus: [])[8..<16]), [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
    }

    func testPcm24PacketLayout() {
        var samples = [Float](repeating: 0, count: 960 + 6)
        // Three frames before the packet's start, to check `start` is honoured.
        samples[0] = 0.9; samples[1] = 0.9
        let s = 6
        samples[s] = Float(0x12_3456) / scale      // L0
        samples[s + 1] = -1 / scale                // R0
        samples[s + 2] = -1                        // L1: -2^23
        samples[s + 3] = 1                         // R1: clipped to 2^23 - 1
        samples[s + 959] = Float(-0x00_0102) / scale
        let p = samples.withUnsafeBufferPointer { Wire.audioPcm24(seq: 7, timeUs: 1_000_000, samples: $0, start: s) }
        XCTAssertEqual(p.count, 16 + 2880)
        XCTAssertEqual(Array(p[0..<4]), [3, 1, 0, 0])
        XCTAssertEqual(Array(p[4..<8]), [7, 0, 0, 0])
        XCTAssertEqual(Array(p[8..<16]), [0x40, 0x42, 0x0F, 0, 0, 0, 0, 0])
        XCTAssertEqual(Array(p[16..<19]), [0x56, 0x34, 0x12])
        XCTAssertEqual(Array(p[19..<22]), [0xFF, 0xFF, 0xFF])
        XCTAssertEqual(Array(p[22..<25]), [0x00, 0x00, 0x80])
        XCTAssertEqual(Array(p[25..<28]), [0xFF, 0xFF, 0x7F])
        XCTAssertEqual(Array(p[(16 + 2877)...]), [0xFE, 0xFE, 0xFF])
        XCTAssertTrue(p[28..<(16 + 2877)].allSatisfy { $0 == 0 })
    }

    func testSilencePacketLayout() {
        let p = Wire.audioSilence(seq: 0xAABB_CCDD, timeUs: 10_000)
        XCTAssertEqual(p, [3, 2, 0, 0, 0xDD, 0xCC, 0xBB, 0xAA, 0x10, 0x27, 0, 0, 0, 0, 0, 0, 0xE0, 0x01])
    }

    // ------------------------------------------------------------------ libopus

    /// The reason for libopus: AudioToolbox's Opus encoder high-passes everything (-7.8 dB at 40 Hz, -19 dB at 20 Hz).
    /// Through the vendored libopus at the top rate the level stays within 0.5 dB, bass included.
    func testLibopusKeepsTheBass() throws {
        for hz in [20.0, 40, 60, 100, 1000] {
            let e = try XCTUnwrap(OpusEncoder(kbps: AudioService.topOpusKbps))
            defer { e.dispose() }
            XCTAssertEqual(e.lookahead, 120)
            var err: Int32 = 0
            let d = try XCTUnwrap(opus_decoder_create(48000, 2, &err))
            defer { opus_decoder_destroy(d) }
            var decoded = [Float]()
            for k in 0..<200 { // 2 s of a -12 dBFS sine
                var f = [Float](repeating: 0, count: 960)
                for i in 0..<480 {
                    let v = Float(0.25 * sin(2 * Double.pi * hz * Double(k * 480 + i) / 48000))
                    f[2 * i] = v
                    f[2 * i + 1] = v
                }
                let packet = try XCTUnwrap(f.withUnsafeBufferPointer { e.encode($0.baseAddress!) })
                var o = [Float](repeating: 0, count: 960)
                let n = packet.withUnsafeBufferPointer { p in
                    o.withUnsafeMutableBufferPointer { opus_decode_float(d, p.baseAddress, Int32(p.count), $0.baseAddress!, 480, 0) }
                }
                XCTAssertEqual(n, 480)
                decoded += o
            }
            // The level over the second second (a whole number of cycles at every frequency here), left channel.
            var a = 0.0, b = 0.0
            for i in 48000..<96000 {
                let w = 2 * Double.pi * hz * Double(i) / 48000
                a += Double(decoded[2 * i]) * sin(w)
                b += Double(decoded[2 * i]) * cos(w)
            }
            let level = 2 * (a * a + b * b).squareRoot() / 48000
            XCTAssertEqual(20 * log10(level / 0.25), 0, accuracy: 0.5, "\(Int(hz)) Hz")
        }
    }

    func testLibopusBitrateStepsInPlace() throws {
        let e = try XCTUnwrap(OpusEncoder(kbps: AudioService.topOpusKbps))
        defer { e.dispose() }
        var m = TestMusic()
        var pcm = [Float]()
        m.append(frames: 48000, to: &pcm) // 1 s of sound
        func kbps(_ frames: Range<Int>) -> Int {
            let bytes = pcm.withUnsafeBufferPointer { all in frames.reduce(0) { $0 + (e.encode(all.baseAddress! + $1 * 960)?.count ?? 0) } }
            return bytes * 8 * 100 / frames.count / 1000
        }
        let top = kbps(0..<50)
        e.setBitrate(kbps: 128) // a step down, in place: the same stream carries on
        XCTAssertEqual(e.kbps, 128)
        _ = kbps(50..<55)
        let stepped = kbps(55..<100)
        XCTAssertGreaterThan(top, 400)
        XCTAssertLessThanOrEqual(top, 520)
        XCTAssertGreaterThan(stepped, 90)
        XCTAssertLessThan(stepped, 150)
        XCTAssertEqual(OPUS_APPLICATION_RESTRICTED_LOWDELAY, 2051)
    }

    // ------------------------------------------------------------------ silence and what each viewer gets

    func testDigitalSilenceIsWhatTwentyFourBitsCallZero() {
        XCTAssertTrue(AudioService.isDigitalSilence(peak: 0))
        XCTAssertTrue(AudioService.isDigitalSilence(peak: 0.49 / scale))
        XCTAssertFalse(AudioService.isDigitalSilence(peak: 0.5 / scale)) // would round to 1
        XCTAssertFalse(AudioService.isDigitalSilence(peak: 1 / scale))
        let frame: [Float] = [0, -0.0, .nan, 0.2 / scale, -0.3 / scale, 0]
        let peak = frame.withUnsafeBufferPointer { AudioService.peak($0, start: 0, count: $0.count) }
        XCTAssertEqual(peak, 0.3 / scale)
        XCTAssertTrue(AudioService.isDigitalSilence(peak: peak))
        // Consistent with the PCM packet: every one of those samples is 0 as 24-bit.
        XCTAssertTrue(frame.allSatisfy { Wire.pcm24($0) == 0 })
        let loud: [Float] = [0, 0, 0, 0.25]
        XCTAssertEqual(loud.withUnsafeBufferPointer { AudioService.peak($0, start: 1, count: 3) }, 0.25)
        XCTAssertEqual(loud.withUnsafeBufferPointer { AudioService.peak($0, start: 0, count: 3) }, 0)
    }

    func testDeliveryPerViewer() {
        typealias F = AudioService.Format
        let lossless = F(mode: .pcm24, priority: true)
        let compressed = F(mode: .opus, priority: true, kbps: 510)
        let stepped = F(mode: .opus, priority: true, kbps: 128)
        let standard = F(mode: .opus, priority: false, kbps: 128)
        func d(_ f: F, zero: Bool, prevZero: Bool = true, hold: Bool = false) -> AudioService.Delivery {
            AudioService.delivery(f, allZero: zero, previousAllZero: prevZero, legacyHold: hold, legacyKbps: 96)
        }
        // Priority: every frame gets a packet.
        XCTAssertEqual(d(lossless, zero: false), .pcm24)
        XCTAssertEqual(d(lossless, zero: true, prevZero: false), .silence)
        XCTAssertEqual(d(lossless, zero: true), .silence)
        XCTAssertEqual(d(lossless, zero: true, hold: true), .silence)
        XCTAssertEqual(d(compressed, zero: false), .opus(kbps: 510, priority: true))
        XCTAssertEqual(d(compressed, zero: true, prevZero: false), .opus(kbps: 510, priority: true)) // carries the end of the sound
        XCTAssertEqual(d(compressed, zero: true), .silence)
        XCTAssertEqual(d(compressed, zero: true, hold: true), .silence)
        XCTAssertEqual(d(stepped, zero: false), .opus(kbps: 128, priority: true))
        // Without priority, as before: the configured bitrate, nothing once silence has lasted 200 ms, never silence packets.
        XCTAssertEqual(d(standard, zero: false), .opus(kbps: 96, priority: false))
        XCTAssertEqual(d(standard, zero: true), .opus(kbps: 96, priority: false))
        XCTAssertEqual(d(standard, zero: true, hold: true), .none)
        XCTAssertEqual(d(F(mode: .pcm24, priority: false), zero: true, hold: true), .none)
        XCTAssertEqual(d(F(mode: .pcm24, priority: false), zero: true), .pcm24)
    }

    func testWireRates() {
        XCTAssertEqual(AudioService.topOpusKbps, 510)
        XCTAssertEqual(AudioService.opusSteps, [510, 256, 128, 64])
        XCTAssertEqual(AudioService.wireKbps(.init(mode: .pcm24, priority: true)), 2304 + 15)
        XCTAssertEqual(AudioService.wireKbps(.init(mode: .opus, priority: true, kbps: 510)), 510 + 15)
        XCTAssertEqual(AudioService.wireKbps(.init(mode: .opus, priority: true, kbps: 64)), 64 + 15)
    }

    // ------------------------------------------------------------------ the test signal (HEADROOM_TEST_AUDIO=music)

    /// The values every implementation (the lab's JS checker, the Windows host) must reproduce bit for bit.
    func testMusicFirstFrames() {
        var m = TestMusic()
        let expected: [(Int32, Int32)] = [
            (-2_059_870, 324_026), (-1_607_090, -113_075), (-1_177_106, -22335), (-1_269_887, -619_485),
            (-1_124_924, -438_152), (-1_064_824, 166_567), (-930_396, 139_469), (-916_998, 655_392),
        ]
        for (n, e) in expected.enumerated() {
            let (l, r) = m.next()
            XCTAssertEqual(l, e.0, "L of frame \(n)")
            XCTAssertEqual(r, e.1, "R of frame \(n)")
        }
    }

    func testMusicLaterFramesAndSilence() {
        var m = TestMusic()
        var at: [Int64: (Int32, Int32)] = [:]
        var maxAbs: Int32 = 0
        var nonZeroInSound = 0
        for n in Int64(0)..<(192_000 + 480) {
            let (l, r) = m.next()
            maxAbs = max(maxAbs, abs(l), abs(r))
            let silent = n % 192_000 >= 144_000
            if silent {
                if l != 0 || r != 0 { XCTFail("frame \(n) should be digital silence"); return }
            } else if l != 0 || r != 0 {
                nonZeroInSound += 1
            }
            if [479, 480, 1000, 143_999, 144_000, 191_999, 192_000, 192_001].contains(n) { at[n] = (l, r) }
        }
        XCTAssertEqual(at[479]!.0, -59564); XCTAssertEqual(at[479]!.1, 879_179)
        XCTAssertEqual(at[480]!.0, 108_425); XCTAssertEqual(at[480]!.1, 494_410)
        XCTAssertEqual(at[1000]!.0, 1_185_185); XCTAssertEqual(at[1000]!.1, -618_411)
        XCTAssertEqual(at[143_999]!.0, -1_620_527); XCTAssertEqual(at[143_999]!.1, -216_559)
        XCTAssertEqual(at[144_000]!.0, 0); XCTAssertEqual(at[191_999]!.1, 0)
        XCTAssertEqual(at[192_000]!.0, -1_578_219); XCTAssertEqual(at[192_000]!.1, 489_268)
        XCTAssertEqual(at[192_001]!.0, -1_527_073); XCTAssertEqual(at[192_001]!.1, 20426)
        XCTAssertEqual(maxAbs, 2_085_251)
        XCTAssertLessThan(maxAbs, 1 << 21)
        XCTAssertGreaterThan(nonZeroInSound, 144_000 + 480 - 10)
        // Silence starts and ends on packet boundaries: packets 300...399 of every 400 are silent.
        XCTAssertEqual(TestMusic.silenceFrom % 480, 0)
        XCTAssertEqual(TestMusic.period % 480, 0)
    }

    func testMusicSurvivesFloatAndPcm24BitForBit() {
        var m = TestMusic()
        var floats = [Float]()
        m.append(frames: 480, to: &floats)
        var check = TestMusic()
        for i in 0..<480 {
            let (l, r) = check.next()
            XCTAssertEqual(floats[2 * i] * scale, Float(l))
            XCTAssertEqual(Wire.pcm24(floats[2 * i]), l)
            XCTAssertEqual(Wire.pcm24(floats[2 * i + 1]), r)
        }
        // The first packet's payload, as the lab's JS generator computes it (FNV-1a over the 2880 bytes).
        let p = floats.withUnsafeBufferPointer { Wire.audioPcm24(seq: 1, timeUs: 0, samples: $0, start: 0) }
        var h: UInt32 = 0x811C_9DC5
        for b in p[16...] { h ^= UInt32(b); h = h &* 16_777_619 }
        XCTAssertEqual(h, 0x7E82_4ADA)
    }

    func testMusicIsMadeAtExactly48kHz() {
        XCTAssertEqual(TestMusic.framesDue(elapsedUs: 0), 0)
        XCTAssertEqual(TestMusic.framesDue(elapsedUs: -5), 0)
        XCTAssertEqual(TestMusic.framesDue(elapsedUs: 20), 0)
        XCTAssertEqual(TestMusic.framesDue(elapsedUs: 21), 1)
        XCTAssertEqual(TestMusic.framesDue(elapsedUs: 10_000), 480)
        XCTAssertEqual(TestMusic.framesDue(elapsedUs: 999_999), 47999)
        XCTAssertEqual(TestMusic.framesDue(elapsedUs: 1_000_000), 48000)
        XCTAssertEqual(TestMusic.framesDue(elapsedUs: 3_600_000_000), 172_800_000)
        // Ticks that come late or early make the same frames in total.
        var made: Int64 = 0
        for tick in [9_000, 21_000, 30_500, 41_000, 1_000_000] as [Int64] {
            made += TestMusic.framesDue(elapsedUs: tick) - made
        }
        XCTAssertEqual(made, 48000)
    }

    // ------------------------------------------------------------------ sample times

    func testSampleClockGivesEachFrameItsFirstSampleTime() {
        var c = SampleClock()
        let t0: Int64 = 5_000_000
        c.append(frames: 0, firstSampleUs: t0)      // the music: one anchor at the start
        c.append(frames: 1000, firstSampleUs: nil)
        c.append(frames: 1000, firstSampleUs: nil)
        XCTAssertEqual(c.timeUs(ofFrame: 0), t0)
        XCTAssertEqual(c.timeUs(ofFrame: 480), t0 + 10_000)
        XCTAssertEqual(c.timeUs(ofFrame: 960), t0 + 20_000)
        c.consume(frames: 960)
        XCTAssertEqual(c.timeUs(ofFrame: 1440), t0 + 30_000)
        // Captured buffers each bring their own time (a gap in the capture shows in the times).
        var s = SampleClock()
        s.append(frames: 1024, firstSampleUs: 1_000_000)
        s.append(frames: 1024, firstSampleUs: 1_021_333 + 50_000)
        XCTAssertEqual(s.timeUs(ofFrame: 480), 1_010_000)
        XCTAssertEqual(s.timeUs(ofFrame: 1024), 1_071_333)
        XCTAssertEqual(s.timeUs(ofFrame: 1024 + 480), 1_081_333)
        s.consume(frames: 1440)
        XCTAssertEqual(s.anchors.count, 1)
        XCTAssertEqual(s.timeUs(ofFrame: 1440), 1_071_333 + 416 * 1_000_000 / 48000)
    }

    // ------------------------------------------------------------------ the transport's audio queue

    func testAudioQueueWithoutPriorityDropsAsBefore() {
        var q = AudioSendQueue()
        for i in 0..<30 { q.push([UInt8(i)], nowUs: Int64(i) * 10_000) }
        XCTAssertEqual(q.items.count, 26) // as before: dropped once more than 25 were queued
        XCTAssertEqual(q.dropped, 4)
        XCTAssertEqual(q.items.first?.bytes, [0])
        XCTAssertEqual(q.items.last?.bytes, [25])
    }

    func testAudioQueueWithPriorityKeepsTwoSeconds() {
        var q = AudioSendQueue()
        q.priority = true
        for i in 0..<250 { q.push([UInt8(i % 256)], nowUs: Int64(i) * 10_000) }
        XCTAssertEqual(q.items.count, 200)
        XCTAssertEqual(q.dropped, 50)
        XCTAssertEqual(q.items.first?.bytes, [50]) // the oldest went
        XCTAssertEqual(q.backlogUs(nowUs: 2_500_000), 2_000_000)
        XCTAssertEqual(q.pop()?.bytes, [50])
        XCTAssertEqual(q.acceptedBytes, 250)
        var e = AudioSendQueue()
        XCTAssertEqual(e.backlogUs(nowUs: 99), 0)
        XCTAssertNil(e.pop())
    }

    // ------------------------------------------------------------------ stepping down

    func testRateWatchStepsDownOnlyWhenSoundFlowsTooSlowly() {
        // 512 kbps Opus made (640 B / 10 ms); the path carries half of it; the backlog is over 300 ms throughout.
        var w = AudioRateWatch()
        var queued: Int64 = 0, written: Int64 = 0
        var verdicts: [AudioRateWatch.Verdict] = []
        for i in 0..<300 {
            queued += 640
            written += 320
            verdicts.append(w.update(nowUs: Int64(i) * 10_000, backlogUs: 400_000, queuedBytes: queued, writtenBytes: written))
        }
        let slow = verdicts.compactMap { v -> Double? in if case .tooSlow(let k) = v { return k } else { return nil } }
        XCTAssertFalse(slow.isEmpty)
        XCTAssertEqual(verdicts.firstIndex { $0 != .fine }, 201) // the window opened at packet 0 and lasted over 2 s
        XCTAssertEqual(slow[0], 256, accuracy: 3)                // 320 B per 10 ms
    }

    func testRateWatchIgnoresStallsStandingQueuesAndDips() {
        // A stall: nothing reaches the socket.
        var w = AudioRateWatch()
        var queued: Int64 = 0
        for i in 0..<500 {
            queued += 2896
            XCTAssertEqual(w.update(nowUs: Int64(i) * 10_000, backlogUs: 500_000, queuedBytes: queued, writtenBytes: 0), .fine)
        }
        // A queue that keeps up with what's made.
        w.reset()
        queued = 0
        var written: Int64 = 0
        for i in 0..<500 {
            queued += 2896
            written += 2896
            XCTAssertEqual(w.update(nowUs: Int64(i) * 10_000, backlogUs: 500_000, queuedBytes: queued, writtenBytes: written), .fine)
        }
        // Too slow, but the backlog dips under 300 ms every second: never 2 s in a row.
        w.reset()
        for i in 0..<600 {
            queued += 2896
            written += 1448
            let backlog: Int64 = i % 100 == 99 ? 200_000 : 400_000
            XCTAssertEqual(w.update(nowUs: Int64(i) * 10_000, backlogUs: backlog, queuedBytes: queued, writtenBytes: written), .fine)
        }
    }

    func testStepDownLadder() {
        let lossless = ClientSession.audioLadder(.pcm24)
        XCTAssertEqual(lossless.map(\.mode), [.pcm24, .opus, .opus, .opus, .opus])
        XCTAssertEqual(lossless.dropFirst().map(\.kbps), [510, 256, 128, 64])
        XCTAssertTrue(lossless.allSatisfy(\.priority))
        let compressed = ClientSession.audioLadder(.opus)
        XCTAssertEqual(compressed.map(\.kbps), [510, 256, 128, 64])
        // Lossless on a 2 Mb/s path: top-rate Opus fits.
        XCTAssertEqual(ClientSession.stepDown(lossless, from: 0, carriedKbps: 2000), 1)
        // Top-rate Opus on ~400 kb/s: 256 fits (271 <= 320).
        XCTAssertEqual(ClientSession.stepDown(compressed, from: 0, carriedKbps: 400), 1)
        // ~200 kb/s: 256 doesn't fit in 160, 128 does.
        XCTAssertEqual(ClientSession.stepDown(compressed, from: 0, carriedKbps: 200), 2)
        // Next to nothing: the last step.
        XCTAssertEqual(ClientSession.stepDown(compressed, from: 0, carriedKbps: 10), 3)
        XCTAssertEqual(ClientSession.stepDown(lossless, from: 1, carriedKbps: 2000), 2) // always at least one step
        XCTAssertEqual(ClientSession.stepDown(compressed, from: 3, carriedKbps: 10), 3) // nowhere further
    }

    // ------------------------------------------------------------------ video with audio priority

    func testVideoPacerSpreadsBigFramesAtItsRate() {
        var p = VideoPacer()
        XCTAssertNil(p.take(1_000_000, nowUs: 0)) // no rate: never paced
        p.setRate(kbps: 1600, nowUs: 0)           // 200 kB/s
        let fragment = Wire.priorityFragmentPayload + Wire.videoHeaderSize + 4
        XCTAssertNil(p.take(fragment, nowUs: 0))  // the first fragment goes at once
        let wait = p.take(fragment, nowUs: 0)
        XCTAssertNotNil(wait)
        XCTAssertEqual(Double(wait ?? 0), Double(fragment) / 200_000 * 1_000_000, accuracy: 5_000) // ~83 ms
        // A 160 kB frame at 200 kB/s: ~0.8 s, fragment after fragment.
        var p2 = VideoPacer()
        p2.setRate(kbps: 1600, nowUs: 0)
        var now: Int64 = 0, sent = 0
        while sent < 160_000 {
            if let w = p2.take(fragment, nowUs: now) { now += w } else { sent += fragment - Wire.videoHeaderSize - 4 }
        }
        XCTAssertEqual(Double(now), 0.8e6 - Double(fragment) / 200_000 * 1e6, accuracy: 60_000)
        // Faster: the bucket holds 10 ms (but always one whole fragment); fragments are ~20 ms of the pace, 4-16 KiB.
        p2.setRate(kbps: 80_000, nowUs: now)
        XCTAssertEqual(p2.burst, 100_000)
        XCTAssertEqual(p2.fragmentPayload, 16 * 1024)
        p2.setRate(kbps: 4000, nowUs: now)
        XCTAssertEqual(p2.fragmentPayload, 10_000)
        p2.setRate(kbps: 800, nowUs: now)
        XCTAssertEqual(p2.fragmentPayload, 4096)
        XCTAssertEqual(VideoPacer().fragmentPayload, 16 * 1024)
        XCTAssertEqual(ClientSession.paceCeilingKbps(targetKbps: 2000, minKbps: 800), 3000)
        XCTAssertEqual(ClientSession.paceCeilingKbps(targetKbps: 100, minKbps: 800), 1200)
    }

    func testVideoPaceControl() {
        var c = VideoPaceControl()
        XCTAssertEqual(c.kbps, 1500) // until paced frames have measured the path
        // A big frame the path held back (1.47 Mb/s: a 2 Mb/s path with the sound on it): just under it.
        c.frame(measuredKbps: 1470, limitedByPace: false, pathQueueMs: 40, ceilingKbps: 3750)
        XCTAssertEqual(c.kbps, 1425)
        // The path queued (pings): back off 15% a tick.
        c.tick(pathQueueMs: 45, pacedWaits: 3, ceilingKbps: 3750)
        XCTAssertEqual(c.kbps, 1211)
        // Clear path, video waiting on the pace: climb 8% a tick; a clear path without waiting: stay.
        c.tick(pathQueueMs: 5, pacedWaits: 2, ceilingKbps: 3750)
        XCTAssertEqual(c.kbps, 1307)
        c.tick(pathQueueMs: 5, pacedWaits: 0, ceilingKbps: 3750)
        XCTAssertEqual(c.kbps, 1307)
        c.tick(pathQueueMs: 20, pacedWaits: 4, ceilingKbps: 3750) // in between: hold
        XCTAssertEqual(c.kbps, 1307)
        // A big frame the pace held back while the path stayed clear: 1.25x what it measured.
        c.frame(measuredKbps: 1320, limitedByPace: true, pathQueueMs: 8, ceilingKbps: 3750)
        XCTAssertEqual(c.kbps, 1650)
        c.frame(measuredKbps: 1320, limitedByPace: true, pathQueueMs: 25, ceilingKbps: 3750) // not while queued
        XCTAssertEqual(c.kbps, 1650)
        // Bounds: 1.5x the target, 100 kbps.
        c.frame(measuredKbps: 9000, limitedByPace: false, pathQueueMs: 0, ceilingKbps: 3750)
        XCTAssertEqual(c.kbps, 3750)
        for _ in 0..<60 { c.tick(pathQueueMs: 500, pacedWaits: 0, ceilingKbps: 3750) }
        XCTAssertEqual(c.kbps, 100)
        XCTAssertEqual(VideoPaceControl(startKbps: 20000).kbps, 20000) // a stream already running keeps its pace
    }

    func testVideoPathEstimateFromBigFrames() {
        var e = VideoPathEstimate()
        // 90 kB frame (first fragment 16 kB), out at 1 s, acked 540 ms later on a 40 ms path: 74 kB * 8 / 500 ms.
        XCTAssertTrue(e.add(bytes: 90_000, firstFragment: 16_000, firstWriteUs: 1_000_000, ackUs: 1_540_000, minRttMs: 40, paceKbps: 3750))
        XCTAssertEqual(e.kbps(nowUs: 1_600_000)!, 1184, accuracy: 0.1)
        XCTAssertEqual(e.pathKbps(nowUs: 1_600_000)!, 1184, accuracy: 0.1) // well under the pace: the path's
        // Small or quick frames don't count.
        XCTAssertFalse(e.add(bytes: 20_000, firstWriteUs: 2_000_000, ackUs: 2_400_000, minRttMs: 40, paceKbps: 3750))
        XCTAssertFalse(e.add(bytes: 60_000, firstWriteUs: 2_000_000, ackUs: 2_070_000, minRttMs: 40, paceKbps: 3750))
        // A frame the pace held back measures the pace: the pace climbs 10% from it; the path's figure stays.
        XCTAssertTrue(e.add(bytes: 100_000, firstFragment: 4096, firstWriteUs: 3_000_000, ackUs: 3_540_000, minRttMs: 40, paceKbps: 1500))
        XCTAssertEqual(e.samples.last?.limitedByPace, true)
        XCTAssertEqual(e.samples.last!.kbps, (100_000 - 4096) * 8 / 500.0, accuracy: 0.1)
        XCTAssertEqual(e.pathKbps(nowUs: 3_600_000)!, 1184, accuracy: 0.1)
        XCTAssertEqual(e.kbps(nowUs: 3_600_000)!, 1184, accuracy: 0.1) // the lower of two
        // A frame paced 10% over the path measures the path (0.91x the pace: not held back by it).
        XCTAssertTrue(e.add(bytes: 100_000, firstWriteUs: 4_000_000, ackUs: 4_540_000, minRttMs: 40, paceKbps: 1760))
        XCTAssertEqual(e.samples.last?.limitedByPace, false)
        XCTAssertEqual(e.pathKbps(nowUs: 4_600_000)!, 1184, accuracy: 0.1) // the lower of 1184 and 1600
        // Old samples are forgotten.
        XCTAssertNil(e.kbps(nowUs: 4_540_000 + VideoPathEstimate.maxAgeUs + 1))
    }

    func testAudioFitWatch() {
        // Lossless (needs ~2500 kbps) into a 2 Mb/s path, sending ~2.6 Mb/s: the queue grows ~300 ms a second.
        var w = AudioFitWatch()
        var fired: (Int, Double, Bool)?
        for tick in 0..<12 where fired == nil { // 250 ms ticks
            let q = max(0, Double(tick) * 75 - 30)
            if let f = w.update(nowUs: Int64(tick) * 250_000, queueMs: q, bytesOut: Int64(tick) * 81_250, pongs: tick, needKbps: 2500, videoAtFloor: false) {
                fired = (tick, f.carriedKbps, f.peak)
            }
        }
        XCTAssertEqual(fired?.0, 4)                         // after 1 s, the queue ~270 ms
        XCTAssertEqual(fired?.1 ?? 0, 2600 / 1.27, accuracy: 1) // what the path carried: sent / (1 + 0.27), ~2 Mb/s
        XCTAssertEqual(fired?.2, false)
        // The same growth from a picture flood on a path that carries the sound (Opus needs ~615): nothing.
        w.reset()
        for tick in 0..<12 {
            XCTAssertNil(w.update(nowUs: Int64(tick) * 250_000, queueMs: Double(tick) * 75, bytesOut: Int64(tick) * 81_250, pongs: tick, needKbps: 615, videoAtFloor: false))
        }
        // A backlog standing past 450 ms (not growing 50 ms a second, not draining), the picture at its floor: the peak.
        w.reset()
        var peak: Int?
        let qs: [Double] = [460, 462, 458, 461, 463, 460, 466, 470]
        for (tick, q) in qs.enumerated() where peak == nil {
            if let f = w.update(nowUs: Int64(tick) * 250_000, queueMs: q, bytesOut: Int64(tick) * 62_500, pongs: tick, needKbps: 2500, videoAtFloor: true), f.peak {
                peak = tick
            }
        }
        XCTAssertEqual(peak, 4)
        // Draining, or a stall (no answers): nothing.
        w.reset()
        for tick in 0..<12 {
            XCTAssertNil(w.update(nowUs: Int64(tick) * 250_000, queueMs: 900 - Double(tick) * 40, bytesOut: Int64(tick) * 62_500, pongs: tick, needKbps: 2500, videoAtFloor: true))
        }
        w.reset()
        for tick in 0..<12 {
            XCTAssertNil(w.update(nowUs: Int64(tick) * 250_000, queueMs: Double(tick) * 100, bytesOut: 0, pongs: 0, needKbps: 2500, videoAtFloor: true))
        }
    }

    func testPriorityVideoBudgetAndCeiling() {
        // The floor is ~60 ms of the pace within 16–64 KiB: 1.5 Mb/s -> 16 KiB, 4 Mb/s -> 30 kB, 20 Mb/s -> 64 KiB.
        XCTAssertEqual(ClientSession.priorityVideoBudget(deliveryKbps: 1000, minRttMs: 20, paceKbps: 1500), 16 * 1024)
        XCTAssertEqual(ClientSession.priorityVideoBudget(deliveryKbps: 1000, minRttMs: 20, paceKbps: 4000), 30_000)
        XCTAssertEqual(ClientSession.priorityVideoBudget(deliveryKbps: 1000, minRttMs: 20, paceKbps: 20000), 64 * 1024)
        // Above the floor: 1.1x the BDP (5 Mb/s at 40 ms: 27.5 kB; 100 Mb/s at 50 ms: 687.5 kB), at most 6 MiB.
        XCTAssertEqual(ClientSession.priorityVideoBudget(deliveryKbps: 5000, minRttMs: 40, paceKbps: 1500), 27_500)
        XCTAssertEqual(ClientSession.priorityVideoBudget(deliveryKbps: 100_000, minRttMs: 50, paceKbps: 20000), 687_500)
        XCTAssertEqual(ClientSession.priorityVideoBudget(deliveryKbps: 1_000_000, minRttMs: 500, paceKbps: 20000), 6 * 1024 * 1024)
        XCTAssertEqual(ClientSession.congestionDelayMs(priority: true), 25)
        XCTAssertEqual(ClientSession.congestionDelayMs(priority: false), 60)
        XCTAssertEqual(ClientSession.videoCeiling(capKbps: 40000, minKbps: 800, audioKbps: 2550), 37450)
        XCTAssertEqual(ClientSession.videoCeiling(capKbps: 2000, minKbps: 800, audioKbps: 2550), 800)
        XCTAssertEqual(ClientSession.videoCeiling(capKbps: 40000, minKbps: 800, audioKbps: 0), 40000) // priority off: as before
    }
}
