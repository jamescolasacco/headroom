import AudioToolbox
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

/// System audio ("what you hear") via ScreenCaptureKit -> Opus (10 ms frames, AudioToolbox's encoder) ->
/// subscribers. One capture shared by all viewers; started with the first subscriber, stopped after the
/// last leaves. Like the Windows host, silence produces no packets: the sequence number still advances,
/// so the client sees the gap and re-buffers when sound resumes.
public final class AudioService: NSObject, SCStreamOutput, SCStreamDelegate {
    public static let shared = AudioService()

    public struct Packet {
        public let seq: UInt32
        public let timeUs: Int64
        public let data: [UInt8]
    }

    private static let sampleRate = 48000.0
    private static let channels = 2
    private static let frameSamples = 480 // 10 ms per channel

    private let lock = NSLock()
    private var subscribers: [ObjectIdentifier: (Packet) -> Void] = [:]
    private var stream: SCStream?
    private var starting = false
    private let queue = DispatchQueue(label: "headroom.audio", qos: .userInteractive)
    private let videoSink = DispatchQueue(label: "headroom.audio.video", qos: .background)

    // Encoder state (queue-confined).
    private var converter: AudioConverterRef?
    private var pcm = [Float]()          // interleaved stereo, pending
    private var seq: UInt32 = 0
    private var silentFrames = 0
    private var outBuf = [UInt8](repeating: 0, count: 1500)

    public func subscribe(_ owner: AnyObject, _ fn: @escaping (Packet) -> Void) {
        lock.lock()
        subscribers[ObjectIdentifier(owner)] = fn
        let start = subscribers.count == 1
        lock.unlock()
        if start { Task { await self.start() } }
    }

    public func unsubscribe(_ owner: AnyObject) {
        lock.lock()
        subscribers[ObjectIdentifier(owner)] = nil
        let stop = subscribers.isEmpty
        let s = stop ? stream : nil
        if stop { stream = nil }
        lock.unlock()
        if stop {
            s?.stopCapture { _ in }
            if s != nil { Log.info("audio", "system audio capture stopped") }
            queue.async { [self] in disposeConverter() }
        }
    }

    private func beginStart() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if stream != nil || starting || subscribers.isEmpty { return false }
        starting = true
        return true
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
            cfg.sampleRate = Int(Self.sampleRate)
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
            Log.info("audio", "system audio capture started (48 kHz stereo -> Opus \(ConfigStore.current.audio.bitrateKbps) kbps)")
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

    // ------------------------------------------------------------------ PCM -> Opus (audio queue)

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
        encodeAvailable()
    }

    private func encodeAvailable() {
        let need = Self.frameSamples * Self.channels
        var consumedTotal = 0
        while pcm.count - consumedTotal >= need {
            let start = consumedTotal
            consumedTotal += need
            var peak: Float = 0
            for i in start..<(start + need) { peak = max(peak, abs(pcm[i])) }
            seq &+= 1
            if peak < 1e-5 {
                // Digital silence: after 200 ms of it, stop sending (the client re-buffers on the gap).
                silentFrames += 1
                if silentFrames > 20 { continue }
            } else {
                silentFrames = 0
            }
            guard let packet = encode(pcm, from: start) else { continue }
            let p = Packet(seq: seq, timeUs: Clock.nowUs, data: packet)
            lock.lock(); let subs = Array(subscribers.values); lock.unlock()
            for s in subs { s(p) }
        }
        if consumedTotal > 0 { pcm.removeFirst(consumedTotal) }
        if pcm.count > Int(Self.sampleRate) * 2 { pcm.removeAll() } // never build a backlog
    }

    private final class InputState {
        var base: UnsafePointer<Float>
        var framesLeft: Int
        init(base: UnsafePointer<Float>, framesLeft: Int) { self.base = base; self.framesLeft = framesLeft }
    }

    private func makeConverter() -> AudioConverterRef? {
        var inFmt = AudioStreamBasicDescription(mSampleRate: Self.sampleRate, mFormatID: kAudioFormatLinearPCM,
                                                mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 8,
                                                mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
        var outFmt = AudioStreamBasicDescription(mSampleRate: Self.sampleRate, mFormatID: kAudioFormatOpus, mFormatFlags: 0, mBytesPerPacket: 0,
                                                 mFramesPerPacket: UInt32(Self.frameSamples), mBytesPerFrame: 0, mChannelsPerFrame: 2,
                                                 mBitsPerChannel: 0, mReserved: 0)
        var c: AudioConverterRef?
        guard AudioConverterNew(&inFmt, &outFmt, &c) == noErr, let c else {
            Log.warn("audio", "Opus encoder unavailable")
            return nil
        }
        var bitrate = UInt32(max(32, min(256, ConfigStore.current.audio.bitrateKbps)) * 1000)
        AudioConverterSetProperty(c, kAudioConverterEncodeBitRate, UInt32(MemoryLayout<UInt32>.size), &bitrate)
        return c
    }

    private func disposeConverter() {
        if let c = converter { AudioConverterDispose(c) }
        converter = nil
        pcm.removeAll()
        silentFrames = 0
    }

    private static let noMoreInput: OSStatus = 0x6E6F_6D72 // 'nomr'

    private func encode(_ samples: [Float], from start: Int) -> [UInt8]? {
        if converter == nil { converter = makeConverter() }
        guard let conv = converter else { return nil }
        return samples.withUnsafeBufferPointer { all -> [UInt8]? in
            let state = InputState(base: all.baseAddress! + start, framesLeft: Self.frameSamples)
            var packets: UInt32 = 1
            var desc = AudioStreamPacketDescription()
            let st: OSStatus = outBuf.withUnsafeMutableBytes { out in
                var abl = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 2, mDataByteSize: UInt32(out.count), mData: out.baseAddress))
                return withExtendedLifetime(state) {
                    AudioConverterFillComplexBuffer(conv, { _, ioPackets, ioData, _, user in
                        let s = Unmanaged<InputState>.fromOpaque(user!).takeUnretainedValue()
                        guard s.framesLeft > 0 else {
                            ioPackets.pointee = 0
                            return AudioService.noMoreInput
                        }
                        let n = min(Int(ioPackets.pointee), s.framesLeft)
                        ioData.pointee.mNumberBuffers = 1
                        ioData.pointee.mBuffers.mNumberChannels = 2
                        ioData.pointee.mBuffers.mDataByteSize = UInt32(n * 8)
                        ioData.pointee.mBuffers.mData = UnsafeMutableRawPointer(mutating: s.base)
                        s.base += n * 2
                        s.framesLeft -= n
                        ioPackets.pointee = UInt32(n)
                        return noErr
                    }, Unmanaged.passUnretained(state).toOpaque(), &packets, &abl, &desc)
                }
            }
            guard st == noErr || st == Self.noMoreInput, packets == 1, desc.mDataByteSize > 0 else { return nil }
            let off = Int(desc.mStartOffset), len = Int(desc.mDataByteSize)
            guard off + len <= outBuf.count else { return nil }
            return Array(outBuf[off..<(off + len)])
        }
    }
}
