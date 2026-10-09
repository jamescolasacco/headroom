import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// ScreenCaptureKit capture of one display, straight into NV12 (BT.709, video range) IOSurfaces that the
/// encoder takes without a CPU copy. ScreenCaptureKit only delivers a frame when the screen changed
/// ("complete" status), which is exactly the "send only when something moved" model the pipeline wants.
/// The cursor is left out of the video; CursorTracker sends it separately.
final class ScreenCaptureSource: CaptureSource, SCStreamOutput, SCStreamDelegate {
    private let outputQueue = DispatchQueue(label: "headroom.capture", qos: .userInteractive)
    private var stream: SCStream?
    private var stopped = false
    private var failures = 0
    private var restartPending = false
    private var reconfigToken: Int?
    private let stateLock = NSLock()

    override func start() {
        super.start()
        reconfigToken = DisplayReconfiguration.add { [weak self] in self?.displaysChanged() }
        Task { await self.startStream() }
    }

    override func stop() {
        super.stop()
        if let t = reconfigToken { DisplayReconfiguration.remove(t) }
        stateLock.lock()
        stopped = true
        let s = stream
        stream = nil
        stateLock.unlock()
        s?.stopCapture { _ in }
    }

    private func configuration(for m: MonitorInfo) -> SCStreamConfiguration {
        let c = SCStreamConfiguration()
        c.width = m.width
        c.height = m.height
        c.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        c.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        c.colorSpaceName = CGColorSpace.sRGB
        c.showsCursor = false
        c.scalesToFit = false
        // Up to the display's refresh rate; each viewer's pipeline applies its own cap.
        let fps = max(30, min(240, Int(m.refreshHz.rounded())))
        c.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        c.queueDepth = 6
        if #available(macOS 14.0, *) {
            c.captureResolution = .best
            c.ignoreShadowsDisplay = false
            c.presenterOverlayPrivacyAlertSetting = .never
        }
        return c
    }

    /// Returns false if the source was stopped.
    private func beginAttempt() -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        if stopped { return false }
        restartPending = false
        return true
    }

    /// Adopts a started stream; false if the source was stopped meanwhile.
    private func adopt(_ s: SCStream) -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        if stopped { return false }
        stream = s
        failures = 0
        return true
    }

    private func startStream() async {
        guard beginAttempt() else { return }

        // Re-resolve the display every time: resolution or arrangement may have changed.
        guard let current = Displays.find(monitor.id) else {
            setStatus(.unavailable, detail: "display disconnected")
            scheduleRestart()
            return
        }
        updateMonitor(current)
        if !CGPreflightScreenCaptureAccess() {
            setStatus(.unavailable, detail: Permissions.screenRecordingHint)
            scheduleRestart(after: 3)
            return
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == current.displayID }) else {
                setStatus(.unavailable, detail: "display not shareable")
                scheduleRestart()
                return
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let s = SCStream(filter: filter, configuration: configuration(for: current), delegate: self)
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: outputQueue)
            try await s.startCapture()
            guard adopt(s) else {
                try? await s.stopCapture()
                return
            }
            Log.info("capture", "\(current.id) (\(current.name)) capturing \(current.width)x\(current.height) @\(Int(current.refreshHz)) Hz, scale \(current.scale)")
            setStatus(.ok)
        } catch {
            let ns = error as NSError
            let detail: String
            if ns.domain == SCStreamErrorDomain, ns.code == SCStreamError.userDeclined.rawValue {
                detail = Permissions.screenRecordingHint
            } else {
                detail = ns.localizedDescription
            }
            Log.warn("capture", "\(current.id): could not start capture: \(ns.domain) \(ns.code) \(ns.localizedDescription)")
            setStatus(.unavailable, detail: detail)
            scheduleRestart()
        }
    }

    private func scheduleRestart(after seconds: Double? = nil) {
        stateLock.lock()
        if stopped || restartPending { stateLock.unlock(); return }
        restartPending = true
        failures += 1
        let delay = seconds ?? min(5, 0.5 * Double(failures))
        stateLock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            Task { await self?.startStream() }
        }
    }

    private func displaysChanged() {
        guard let m = Displays.find(monitor.id) else { return }
        guard m.width != monitor.width || m.height != monitor.height || m.refreshHz != monitor.refreshHz else {
            updateMonitor(m) // position/arrangement only: cursor mapping follows, the stream doesn't change
            return
        }
        Log.info("capture", "\(m.id): display mode changed to \(m.width)x\(m.height)")
        updateMonitor(m)
        bumpGeneration()
        stateLock.lock()
        let s = stream
        stateLock.unlock()
        s?.updateConfiguration(configuration(for: m)) { [weak self] err in
            if let err {
                Log.warn("capture", "reconfigure failed (\(err.localizedDescription)); restarting stream")
                self?.restartStream()
            }
        }
    }

    private func restartStream() {
        stateLock.lock()
        let s = stream
        stream = nil
        stateLock.unlock()
        s?.stopCapture { _ in }
        scheduleRestart(after: 0.2)
    }

    // ------------------------------------------------------------------ SCStreamOutput / delegate

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = atts.first?[.status] as? Int, let st = SCFrameStatus(rawValue: raw) else { return }
        // .idle = nothing changed (no image); .blank/.suspended = display asleep or capture paused.
        guard st == .complete, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        publish(pb)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let ns = error as NSError
        Log.warn("capture", "\(monitor.id): stream stopped: \(ns.domain) \(ns.code) \(ns.localizedDescription)")
        stateLock.lock()
        if self.stream === stream { self.stream = nil }
        stateLock.unlock()
        setStatus(.unavailable, detail: ns.code == SCStreamError.userDeclined.rawValue ? Permissions.screenRecordingHint : "capture stopped; retrying")
        scheduleRestart()
    }
}

/// Fans CoreGraphics display-reconfiguration callbacks (resolution changes, displays plugged in) out to listeners.
enum DisplayReconfiguration {
    private static let lock = NSLock()
    private static var listeners: [Int: () -> Void] = [:]
    private static var next = 1
    private static var registered = false
    private static var pending = false

    static func add(_ fn: @escaping () -> Void) -> Int {
        lock.lock(); defer { lock.unlock() }
        let t = next
        next += 1
        listeners[t] = fn
        if !registered {
            registered = true
            CGDisplayRegisterReconfigurationCallback({ _, flags, _ in
                // Called once per display before and after the change; act once, after it settles.
                if flags.contains(.beginConfigurationFlag) { return }
                DisplayReconfiguration.coalesce()
            }, nil)
        }
        return t
    }

    static func remove(_ t: Int) {
        lock.lock(); listeners[t] = nil; lock.unlock()
    }

    private static func coalesce() {
        lock.lock()
        if pending { lock.unlock(); return }
        pending = true
        lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
            lock.lock()
            pending = false
            let ls = Array(listeners.values)
            lock.unlock()
            for l in ls { l() }
        }
    }
}
