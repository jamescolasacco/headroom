import AudioToolbox
import COpus
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

/// System audio ("what you hear") via ScreenCaptureKit, cut into 10 ms frames, then per viewer: Opus (libopus, see
/// OpusEncoder) or lossless PCM (signed 24-bit). One capture shared by all viewers; started with the first subscriber,
/// stopped after the last leaves. Each frame carries the host-clock time of its first sample at capture.
///
/// Viewers without audio priority get what they always did: Opus at this computer's bitrate, and after 200 ms of
/// digital silence nothing at all (the sequence number still advances, so the client sees the gap and re-buffers).
/// Viewers with audio priority get a packet for every frame: sound, or a silence packet for digital silence, so their
/// timeline never has holes; their Opus is at the top bitrate unless their path made it step down.
public final class AudioService: NSObject, SCStreamOutput, SCStreamDelegate {
    public static let shared = AudioService()

    public enum Mode: String {
        case opus
        case pcm24
    }

    /// What one viewer gets.
    public struct Format: Equatable {
        public var mode: Mode
        public var priority: Bool
        /// Opus bitrate (kbps) of a viewer with priority: the top rate unless its path made it step down. Viewers
        /// without priority get this computer's configured bitrate, as before; PCM ignores it.
        public var kbps: Int

        public init(mode: Mode = .opus, priority: Bool = false, kbps: Int = AudioService.topOpusKbps) {
            self.mode = mode
            self.priority = priority
            self.kbps = kbps
        }

        public static let standard = Format()
    }

    public struct Packet {
        public let seq: UInt32
        /// Host µs (Clock.nowUs) of the frame's first sample at capture.
        public let timeUs: Int64
        public let codec: Wire.AudioCodec
        /// The whole 0x03 message.
        public let wire: [UInt8]
    }

    /// Opus's highest bitrate for stereo (libopus caps it at 510 kbps; the Windows host uses the same ladder).
    public static let topOpusKbps = 510
    /// Opus bitrates a viewer with priority steps down through when its path can't carry the one before.
    public static let opusSteps = [510, 256, 128, 64]
    /// Lossless: 48000 x 2 x 24 bits.
    public static let pcm24Kbps = 2304

    /// This computer's Opus bitrate for viewers without priority (Settings; 32–256 kbps).
    public static var configuredOpusKbps: Int { max(32, min(256, ConfigStore.current.audio.bitrateKbps)) }

    /// What a viewer with this format costs on the wire, payload and audio headers (kbps, before WebSocket/TCP).
    public static func wireKbps(_ f: Format) -> Int {
        let payload = f.mode == .pcm24 ? pcm24Kbps : (f.priority ? f.kbps : configuredOpusKbps)
        return payload + Wire.audioHeaderSize * 8 * 100 / 1000 + 4 * 8 * 100 / 1000 // + 16 B header + ~4 B framing per 10 ms
    }

    static let sampleRate = 48000
    private static let channels = 2
    static let frameSamples = Wire.pcmFrames // 10 ms per channel

    private struct Subscriber {
        var format: Format
        let fn: (Packet) -> Void
    }

    private let lock = NSLock()
    private var subscribers: [ObjectIdentifier: Subscriber] = [:]
    private var stream: SCStream?
    private var starting = false
    private let queue = DispatchQueue(label: "headroom.audio", qos: .userInteractive)
    private let videoSink = DispatchQueue(label: "headroom.audio.video", qos: .background)

    // Frame state (queue-confined).
    private var pcm = [Float]()          // interleaved stereo, pending
    private var clock = SampleClock()    // host time of the pending samples
    private var seq: UInt32 = 0
    private var silentFrames = 0         // quiet frames in a row (the 200 ms rule of viewers without priority)
    private var previousAllZero = true   // the frame before was digital silence (nothing for an Opus encoder to flush)
    private var lastFrame = [Float]()    // the frame before, to prime an Opus encoder that starts mid-stream
    /// Viewers without priority share one encoder at this computer's bitrate (fixed when it's made, as before); each
    /// viewer with priority has its own, fed every frame, whose bitrate changes in place when its path steps it down.
    private var sharedEncoder: OpusEncoder?
    private var priorityEncoders: [ObjectIdentifier: OpusEncoder] = [:]
    private var timestampsLogged = false

    /// Tests only (with the test pattern): HEADROOM_TEST_AUDIO=1 plays a quiet 440 Hz tone instead of this Mac's sound,
    /// HEADROOM_TEST_AUDIO=music the deterministic test signal (TestMusic), so the whole path runs without the Screen
    /// Recording permission and a checker can compare what arrives with what was made.
    private enum TestSource { case tone, music }
    private static let testSource: TestSource? = {
        guard Displays.testPatternSize != nil else { return nil }
        switch ProcessInfo.processInfo.environment["HEADROOM_TEST_AUDIO"] {
        case "1": return .tone
        case "music": return .music
        default: return nil
        }
    }()
    private var testTimer: DispatchSourceTimer? // under `lock`
    private var tonePhase = 0.0                 // queue-confined
    private var music = TestMusic()             // queue-confined
    private var musicStartUs: Int64 = 0
    private var musicMade: Int64 = 0

    public func subscribe(_ owner: AnyObject, format: Format = .standard, _ fn: @escaping (Packet) -> Void) {
        lock.lock()
        subscribers[ObjectIdentifier(owner)] = Subscriber(format: format, fn: fn)
        let start = subscribers.count == 1
        lock.unlock()
        if start { Task { await self.start() } }
    }

    /// A subscriber's format changed (asked for, or stepped down): applies from the next frame.
    public func setFormat(_ owner: AnyObject, _ format: Format) {
        lock.lock()
        subscribers[ObjectIdentifier(owner)]?.format = format
        lock.unlock()
    }

    public func unsubscribe(_ owner: AnyObject) {
        lock.lock()
        subscribers[ObjectIdentifier(owner)] = nil
        let stop = subscribers.isEmpty
        let s = stop ? stream : nil
        let test = stop ? testTimer : nil
        if stop { stream = nil; testTimer = nil }
        lock.unlock()
        if stop {
            s?.stopCapture { _ in }
            if s != nil { Log.info("audio", "system audio capture stopped") }
            if let test { test.cancel(); Log.info("audio", "test audio stopped") }
            queue.async { [self] in reset() }
        }
    }

    private func beginStart() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if stream != nil || testTimer != nil || starting || subscribers.isEmpty { return false }
        starting = true
        return true
    }

    /// HEADROOM_TEST_AUDIO=1: 10 ms of tone every 10 ms, through the same path as captured sound.
    private func startTone() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        lock.lock()
        guard !subscribers.isEmpty, testTimer == nil else { lock.unlock(); return }
        testTimer = t
        lock.unlock()
        t.schedule(deadline: .now(), repeating: .milliseconds(10))
        t.setEventHandler { [weak self] in
            guard let self else { return }
            let first = self.pcm.count / 2
            self.pcm.reserveCapacity(self.pcm.count + Self.frameSamples * 2)
            for _ in 0..<Self.frameSamples {
                let v = Float(sin(self.tonePhase) * 0.05)
                self.tonePhase = (self.tonePhase + 2 * Double.pi * 440 / Double(Self.sampleRate)).truncatingRemainder(dividingBy: 2 * Double.pi)
                self.pcm.append(v)
                self.pcm.append(v)
            }
            self.clock.append(frames: self.pcm.count / 2 - first, firstSampleUs: Clock.nowUs)
            self.emitFrames()
        }
        t.resume()
        Log.info("audio", "test tone started (HEADROOM_TEST_AUDIO)")
    }

    /// HEADROOM_TEST_AUDIO=music: frame n is due at t0 + n / 48 kHz on the host clock. Each tick makes every frame due by
    /// now, so the rate is exactly 48 kHz on average whatever the timer does, and frame n's time is exact.
    private func startMusic() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        lock.lock()
        guard !subscribers.isEmpty, testTimer == nil else { lock.unlock(); return }
        testTimer = t
        lock.unlock()
        queue.async { [self] in
            reset()
            music = TestMusic()
            musicStartUs = Clock.nowUs
            musicMade = 0
            clock.append(frames: 0, firstSampleUs: musicStartUs)
            t.schedule(deadline: .now() + .milliseconds(10), repeating: .milliseconds(10), leeway: .milliseconds(1))
            t.setEventHandler { [weak self] in self?.makeMusic() }
            t.resume()
        }
        Log.info("audio", "test music started (HEADROOM_TEST_AUDIO=music)")
    }

    private func makeMusic() {
        let due = TestMusic.framesDue(elapsedUs: Clock.nowUs - musicStartUs)
        let count = Int(due - musicMade)
        guard count > 0 else { return }
        music.append(frames: count, to: &pcm)
        musicMade = due
        clock.append(frames: count, firstSampleUs: nil)
        emitFrames()
    }

    private func endStart() {
        lock.lock(); starting = false; lock.unlock()
    }

    /// Keeps the started stream if anyone still wants audio.
    private func adopt(_ s: SCStream) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if subscribers.isEmpty { return false }
        stream = s
        return true
    }

    private func start() async {
        guard beginStart() else { return }
        defer { endStart() }
        switch Self.testSource {
        case .tone?: startTone(); return
        case .music?: startMusic(); return
        case nil: break
        }
        // Never trigger the system prompt from here: the menu-bar app asks for Screen Recording explicitly.
        guard CGPreflightScreenCaptureAccess() else {
            Log.warn("audio", "no audio: \(Permissions.screenRecordingHint)")
            return
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { return }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.capturesAudio = true
            cfg.sampleRate = Self.sampleRate
            cfg.channelCount = Self.channels
            // Viewing this Mac from itself would capture its own playback: the session turns audio off then,
            // and our process never plays anything anyway.
            cfg.excludesCurrentProcessAudio = true
            // Audio rides on a display stream; keep the video side as cheap as possible.
            cfg.width = 2
            cfg.height = 2
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            cfg.queueDepth = 3
            let s = SCStream(filter: filter, configuration: cfg, delegate: self)
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoSink)
            try await s.startCapture()
            guard adopt(s) else { try? await s.stopCapture(); return }
            Log.info("audio", "system audio capture started (48 kHz stereo)")
        } catch {
            Log.warn("audio", "audio capture unavailable: \(error.localizedDescription)")
        }
    }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid else { return }
        append(sb)
    }

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        Log.warn("audio", "audio stream stopped: \(error.localizedDescription)")
        lock.lock()
        if self.stream === stream { self.stream = nil }
        let resume = !subscribers.isEmpty
        lock.unlock()
        if resume {
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { Task { await self.start() } }
        }
    }

    // ------------------------------------------------------------------ captured samples (audio queue)

    private func append(_ sb: CMSampleBuffer) {
        guard let fmt = CMSampleBufferGetFormatDescription(sb), let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmt) else { return }
        let asbd = asbdPtr.pointee
        guard asbd.mFormatID == kAudioFormatLinearPCM, (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0, asbd.mBitsPerChannel == 32 else { return }
        let frames = CMSampleBufferGetNumSamples(sb)
        guard frames > 0 else { return }
        var blockBuffer: CMBlockBuffer?
        var listSize = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: &listSize, bufferListOut: nil, bufferListSize: 0,
                                                                blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        let raw = UnsafeMutableRawPointer.allocate(byteCount: listSize, alignment: 16)
        defer { raw.deallocate() }
        let abl = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sb, bufferListSizeNeededOut: nil, bufferListOut: abl, bufferListSize: listSize,
                                                                      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
                                                                      flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                                                                      blockBufferOut: &blockBuffer) == noErr else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(abl)
        let srcChannels = Int(asbd.mChannelsPerFrame)
        let nonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        let firstUs = captureTimeUs(sb, frames: frames)
        pcm.reserveCapacity(pcm.count + frames * 2)
        if nonInterleaved {
            let l = buffers[0].mData?.assumingMemoryBound(to: Float.self)
            let r = buffers.count > 1 ? buffers[1].mData?.assumingMemoryBound(to: Float.self) : l
            guard let l, let r else { return }
            for i in 0..<frames { pcm.append(l[i]); pcm.append(r[i]) }
        } else {
            guard let p = buffers[0].mData?.assumingMemoryBound(to: Float.self) else { return }
            for i in 0..<frames {
                let a = p[i * srcChannels]
                pcm.append(a)
                pcm.append(srcChannels > 1 ? p[i * srcChannels + 1] : a)
            }
        }
        clock.append(frames: frames, firstSampleUs: firstUs)
        emitFrames()
    }

    /// Host-clock time (Clock.nowUs) of the buffer's first sample. ScreenCaptureKit stamps buffers on the host time
    /// clock (mach absolute time, which Clock counts too): the buffer's age is host-clock-now minus its presentation
    /// time. Anything else (no time, or an age that makes no sense) falls back to "the buffer ends now".
    private func captureTimeUs(_ sb: CMSampleBuffer, frames: Int) -> Int64 {
        let now = Clock.nowUs
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        var ageUs: Int64?
        if pts.isNumeric {
            let age = CMTimeConvertScale(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts), timescale: 1_000_000, method: .roundHalfAwayFromZero)
            if age.isNumeric, age.value > -50_000, age.value < 2_000_000 { ageUs = age.value }
        }
        if !timestampsLogged {
            timestampsLogged = true
            if let ageUs {
                Log.info("audio", "capture times from the stream (first buffer \(String(format: "%.1f", Double(ageUs) / 1000)) ms old, \(frames) frames)")
            } else {
                Log.warn("audio", "the stream's times aren't on the host clock (\(pts.seconds) s): stamping samples on arrival")
            }
        }
        return now - (ageUs ?? Int64(frames) * 1_000_000 / Int64(Self.sampleRate))
    }

    // ------------------------------------------------------------------ frames -> packets (audio queue)

    private func emitFrames() {
        let need = Self.frameSamples * Self.channels
        var consumed = 0
        while pcm.count - consumed >= need {
            let start = consumed
            consumed += need
            let timeUs = clock.timeUs(ofFrame: clock.framesOut + Int64(start / Self.channels))
            emitFrame(from: start, timeUs: timeUs)
        }
        if consumed > 0 {
            pcm.removeFirst(consumed)
            clock.consume(frames: consumed / Self.channels)
        }
        if pcm.count > Self.sampleRate * 2 { // never build a backlog
            clock.consume(frames: pcm.count / Self.channels)
            pcm.removeAll()
        }
    }

    private func emitFrame(from start: Int, timeUs: Int64) {
        let need = Self.frameSamples * Self.channels
        let peak = pcm.withUnsafeBufferPointer { Self.peak($0, start: start, count: need) }
        let allZero = Self.isDigitalSilence(peak: peak)
        seq &+= 1
        // Viewers without priority: digital silence stops their packets after 200 ms (as before).
        if peak < 1e-5 { silentFrames += 1 } else { silentFrames = 0 }
        let legacyHold = peak < 1e-5 && silentFrames > 20

        lock.lock(); let subs = Array(subscribers); lock.unlock()
        let legacy = subs.contains { !$0.value.format.priority && $0.value.format.mode == .opus } ? sharedEncoder?.kbps ?? Self.configuredOpusKbps : 0
        // Viewers with priority, Opus: their own encoder sees every frame (silence too), so each stays one continuous
        // stream; a step down changes its bitrate in place. A new one starts primed with the frame before.
        var priorityPackets: [ObjectIdentifier: Packet] = [:]
        var live = Set<ObjectIdentifier>()
        for (id, s) in subs where s.format.priority && s.format.mode == .opus {
            live.insert(id)
            let e: OpusEncoder
            if let have = priorityEncoders[id] {
                e = have
                if e.kbps != s.format.kbps { e.setBitrate(kbps: s.format.kbps) }
            } else {
                guard let made = OpusEncoder(kbps: s.format.kbps) else { continue }
                if lastFrame.count == Self.frameSamples * Self.channels {
                    _ = lastFrame.withUnsafeBufferPointer { made.encode($0.baseAddress!) }
                }
                priorityEncoders[id] = made
                e = made
            }
            if let p = encodePacket(e, start: start, timeUs: timeUs) { priorityPackets[id] = p }
        }
        for id in priorityEncoders.keys where !live.contains(id) { priorityEncoders.removeValue(forKey: id)?.dispose() }

        var sharedPacket: Packet??
        var pcmPacket: Packet?
        var silencePacket: Packet?
        for (id, s) in subs {
            let p: Packet?
            switch Self.delivery(s.format, allZero: allZero, previousAllZero: previousAllZero, legacyHold: legacyHold, legacyKbps: legacy) {
            case .none:
                p = nil
            case .silence:
                if silencePacket == nil {
                    silencePacket = Packet(seq: seq, timeUs: timeUs, codec: .silence, wire: Wire.audioSilence(seq: seq, timeUs: timeUs))
                }
                p = silencePacket
            case .pcm24:
                if pcmPacket == nil {
                    let wire = pcm.withUnsafeBufferPointer { Wire.audioPcm24(seq: seq, timeUs: timeUs, samples: $0, start: start) }
                    pcmPacket = Packet(seq: seq, timeUs: timeUs, codec: .pcm24, wire: wire)
                }
                p = pcmPacket
            case .opus(_, true):
                p = priorityPackets[id]
            case .opus(let kbps, false):
                // Viewers without priority: one shared encoder, run only when a packet goes out (as before).
                if sharedPacket == nil {
                    if sharedEncoder == nil { sharedEncoder = OpusEncoder(kbps: kbps) }
                    sharedPacket = sharedEncoder.map { encodePacket($0, start: start, timeUs: timeUs) } ?? nil
                }
                p = sharedPacket ?? nil
            }
            if let p { s.fn(p) }
        }
        previousAllZero = allZero
        if lastFrame.count != need { lastFrame = [Float](repeating: 0, count: need) }
        pcm.withUnsafeBufferPointer { src in
            lastFrame.withUnsafeMutableBufferPointer { dst in
                for i in 0..<need { dst[i] = src[start + i] }
            }
        }
    }

    private func encodePacket(_ e: OpusEncoder, start: Int, timeUs: Int64) -> Packet? {
        let payload: [UInt8]? = pcm.withUnsafeBufferPointer { e.encode($0.baseAddress! + start) }
        guard let payload else { return nil }
        return Packet(seq: seq, timeUs: timeUs, codec: .opus, wire: Wire.audio(codec: .opus, seq: seq, timeUs: timeUs, payload: payload))
    }

    private func reset() {
        sharedEncoder?.dispose()
        sharedEncoder = nil
        for e in priorityEncoders.values { e.dispose() }
        priorityEncoders.removeAll()
        pcm.removeAll()
        clock = SampleClock()
        silentFrames = 0
        previousAllZero = true
        lastFrame.removeAll()
        timestampsLogged = false
    }

    // ------------------------------------------------------------------ per-frame decisions (pure)

    enum Delivery: Equatable {
        case none
        case silence
        case pcm24
        case opus(kbps: Int, priority: Bool)
    }

    /// What one viewer gets for a frame. With priority: a packet for every frame; digital silence is a silence
    /// packet, except, for Opus, the first silent frame after sound: that packet still carries the end of the sound
    /// (the encoder's lookahead, 120 samples), and without it the decoder would cut the sound short. Without priority,
    /// as before: Opus at this computer's bitrate, and nothing once digital silence has lasted 200 ms.
    static func delivery(_ f: Format, allZero: Bool, previousAllZero: Bool, legacyHold: Bool, legacyKbps: Int) -> Delivery {
        if f.priority {
            if allZero && (f.mode == .pcm24 || previousAllZero) { return .silence }
            return f.mode == .pcm24 ? .pcm24 : .opus(kbps: f.kbps, priority: true)
        }
        if legacyHold { return .none }
        return f.mode == .pcm24 ? .pcm24 : .opus(kbps: legacyKbps, priority: false)
    }

    /// Largest |sample| of `count` interleaved samples from `start` (NaN counts as 0, as the PCM packet has it).
    static func peak(_ s: UnsafeBufferPointer<Float>, start: Int, count: Int) -> Float {
        var peak: Float = 0
        for i in start..<(start + count) {
            let a = abs(s[i])
            if a > peak { peak = a }
        }
        return peak
    }

    /// Every sample of the frame is 0 as signed 24-bit (|x| · 2^23 < 0.5): a silence packet says exactly what a PCM
    /// packet of it would.
    static func isDigitalSilence(peak: Float) -> Bool { peak * 8_388_608 < 0.5 }
}

// ---------------------------------------------------------------------------------------------- Opus encoder

/// libopus (vendored, 1.6.1): 48 kHz float stereo in, one 10 ms packet out per call. Restricted low delay (CELT only,
/// 120 samples of lookahead), music, VBR, complexity 10, like the Windows host. AudioToolbox's Opus encoder can't be
/// used for music: it high-passes everything (-7.8 dB at 40 Hz, -19 dB at 20 Hz) whatever its settings. Audio queue
/// only.
final class OpusEncoder {
    private let encoder: OpaquePointer
    private var out = [UInt8](repeating: 0, count: 1500)
    private(set) var kbps: Int
    /// Samples (per channel) the decoded sound lags what went in.
    let lookahead: Int

    init?(kbps: Int) {
        var err: Int32 = 0
        guard let e = opus_encoder_create(Int32(AudioService.sampleRate), 2, OPUS_APPLICATION_RESTRICTED_LOWDELAY, &err), err == OPUS_OK else {
            Log.warn("audio", "Opus encoder unavailable (\(err))")
            return nil
        }
        encoder = e
        self.kbps = kbps
        copus_encoder_set(e, OPUS_SET_BITRATE_REQUEST, Int32(kbps * 1000))
        copus_encoder_set(e, OPUS_SET_VBR_REQUEST, 1)
        copus_encoder_set(e, OPUS_SET_SIGNAL_REQUEST, OPUS_SIGNAL_MUSIC)
        copus_encoder_set(e, OPUS_SET_COMPLEXITY_REQUEST, 10)
        var la: Int32 = 0
        copus_encoder_get(e, OPUS_GET_LOOKAHEAD_REQUEST, &la)
        lookahead = Int(la)
    }

    func dispose() { opus_encoder_destroy(encoder) }

    /// A step down (or back up): the stream carries on without a break.
    func setBitrate(kbps: Int) {
        guard kbps != self.kbps else { return }
        copus_encoder_set(encoder, OPUS_SET_BITRATE_REQUEST, Int32(kbps * 1000))
        self.kbps = kbps
    }

    /// One packet from 480 interleaved stereo frames at `samples`.
    func encode(_ samples: UnsafePointer<Float>) -> [UInt8]? {
        let enc = encoder
        let n = out.withUnsafeMutableBufferPointer { opus_encode_float(enc, samples, Int32(AudioService.frameSamples), $0.baseAddress!, Int32($0.count)) }
        guard n > 0 else { return nil }
        return Array(out[0..<Int(n)])
    }
}

// ---------------------------------------------------------------------------------------------- sample times

/// Host-clock time of every pending sample, from the times its buffers were captured at (anchors). Frames are
/// counted from the start of the capture.
struct SampleClock {
    private(set) var anchors: [(frame: Int64, us: Int64)] = []
    private(set) var framesIn: Int64 = 0
    private(set) var framesOut: Int64 = 0

    /// `frames` more samples per channel, the first captured at `firstSampleUs` (nil: right after the ones before).
    mutating func append(frames: Int, firstSampleUs: Int64?) {
        if let t = firstSampleUs { anchors.append((framesIn, t)) }
        framesIn += Int64(frames)
    }

    /// Host µs of frame `f` (counted from the start): from the latest anchor at or before it, at 48 kHz.
    func timeUs(ofFrame f: Int64) -> Int64 {
        guard let a = anchors.last(where: { $0.frame <= f }) ?? anchors.first else { return Clock.nowUs }
        return a.us + (f - a.frame) * 1_000_000 / Int64(AudioService.sampleRate)
    }

    /// The oldest `frames` pending samples are done with.
    mutating func consume(frames: Int) {
        framesOut += Int64(frames)
        while anchors.count >= 2 && anchors[1].frame <= framesOut { anchors.removeFirst() }
    }
}

// ---------------------------------------------------------------------------------------------- test signal

/// HEADROOM_TEST_AUDIO=music: a deterministic signal in integer math (so a checker in any language can recompute it
/// bit for bit): three triangle waves (220, 1760, 7040 Hz) plus noise, different per channel, 3 s of sound then 1 s of
/// digital silence, repeating. Every value is q / 2^23 with |q| < 2^21: exact in float32 and in 24-bit PCM.
struct TestMusic {
    static let period: Int64 = 192_000
    static let silenceFrom: Int64 = 144_000
    static let inc1: UInt32 = 19_685_267   // 220 Hz
    static let inc2: UInt32 = 157_482_134  // 1760 Hz
    static let inc3: UInt32 = 629_928_537  // 7040 Hz

    private(set) var n: Int64 = 0
    private var p1: UInt32 = 0, p2: UInt32 = 0, p3: UInt32 = 0
    private var sL: UInt32 = 0x1234_5678, sR: UInt32 = 0x9E37_79B9

    /// [-2^22, 2^22)
    static func tri(_ p: UInt32) -> Int32 {
        let v = p >> 8
        let t = v < 0x80_0000 ? v : 0xFF_FFFF - v
        return Int32(t) - 0x40_0000
    }

    /// [-2^18, 2^18)
    static func noise(_ s: UInt32) -> Int32 {
        Int32(bitPattern: (s >> 8) &- 0x80_0000) >> 5
    }

    /// Frame n's left and right values (q, the sample times 2^23).
    mutating func next() -> (l: Int32, r: Int32) {
        var l = (Self.tri(p1) >> 2) + (Self.tri(p2) >> 3) + (Self.tri(p3) >> 4) + Self.noise(sL)
        var r = (Self.tri(p1 &+ 0x4000_0000) >> 2) + (Self.tri(p2) >> 4) + (Self.tri(p3 &+ 0x8000_0000) >> 3) + Self.noise(sR)
        if n % Self.period >= Self.silenceFrom { l = 0; r = 0 }
        n += 1
        p1 &+= Self.inc1
        p2 &+= Self.inc2
        p3 &+= Self.inc3
        sL = sL &* 1_664_525 &+ 1_013_904_223
        sR = sR &* 1_664_525 &+ 1_013_904_223
        return (l, r)
    }

    /// The next `frames` frames as interleaved float samples (q / 2^23, exact).
    mutating func append(frames: Int, to out: inout [Float]) {
        out.reserveCapacity(out.count + frames * 2)
        for _ in 0..<frames {
            let (l, r) = next()
            out.append(Float(l) / 8_388_608)
            out.append(Float(r) / 8_388_608)
        }
    }

    /// Frames due `elapsedUs` after the start: floor(elapsed x 48 kHz).
    static func framesDue(elapsedUs: Int64) -> Int64 {
        elapsedUs <= 0 ? 0 : elapsedUs * Int64(AudioService.sampleRate) / 1_000_000
    }
}
