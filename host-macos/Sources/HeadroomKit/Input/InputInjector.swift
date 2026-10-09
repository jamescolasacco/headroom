import AppKit
import CoreGraphics
import Foundation
import IOKit
import IOKit.hidsystem

/// Per-viewer record of what's held down, so a dropped connection never leaves keys stuck.
public final class InputContext {
    fileprivate var keys = Set<String>()
    fileprivate var buttons = Set<Int>()
    fileprivate let lock = NSLock()
    public init() {}
}

/// Injects mouse/keyboard input with CGEvent on one dedicated queue (needs the Accessibility permission).
///
/// What macOS needs beyond "post an event" (and the Windows SendInput path doesn't):
///  * moves while a button is held must be *drag* events, or nothing drags;
///  * double/triple clicks need an explicit click count, timed like real clicks;
///  * modifier state must be carried in every event's flags (we track it ourselves, per key, left/right);
///  * local hardware input must not be suppressed after each injected event (default 0.25 s).
public final class InputInjector {
    public static let shared = InputInjector()

    private let queue = DispatchQueue(label: "headroom.input", qos: .userInteractive)
    private let source: CGEventSource?
    /// Move coalescing: the id of the newest queued move, and of the newest move a button/wheel event was queued
    /// after. A move is skipped only if a newer one exists *and* nothing that depends on position came between.
    private let moveOrder = Locked((latest: 0, barrier: 0))

    // Queue-confined state.
    private var heldModifiers: [String: CGEventFlags] = [:] // code -> flags it contributes
    private var buttonsDown = Set<Int>()
    /// The last position we posted (global points; negative on displays left of / above the main one).
    private var lastPos: CGPoint?
    private var clickButton = -1
    private var clickCount = 0
    private var clickTime = Date.distantPast
    private var clickPos = CGPoint.zero
    private var wheelAccX = 0.0, wheelAccY = 0.0
    private var warnedAccessibility = false

    private init() {
        source = CGEventSource(stateID: .hidSystemState)
        source?.localEventsSuppressionInterval = 0
    }

    private var modifierFlags: CGEventFlags {
        var f = CGEventFlags()
        for v in heldModifiers.values { f.formUnion(v) }
        if Self.capsLockOn { f.insert(.maskAlphaShift) }
        return f
    }

    private func post(_ e: CGEvent?) {
        guard let e else { return }
        if !warnedAccessibility && !Permissions.accessibility {
            warnedAccessibility = true
            Log.warn("input", "Accessibility permission is missing: input is ignored by macOS. \(Permissions.accessibilityHint)")
        }
        e.post(tap: .cghidEventTap)
    }

    // --------------------------------------------------------------------------------------- mouse

    /// Move to an absolute position in global display points.
    public func moveTo(_ x: Double, _ y: Double) {
        let id = moveOrder.with { $0.latest += 1; return $0.latest }
        queue.async { [self] in
            // Coalesce: skip if a newer move is queued and no click/scroll needs this position first.
            if moveOrder.with({ $0.latest > id && $0.barrier < id }) { return }
            let p = CGPoint(x: x, y: y)
            if p == lastPos { return }
            let dx = lastPos.map { p.x - $0.x } ?? 0, dy = lastPos.map { p.y - $0.y } ?? 0
            lastPos = p
            postMove(to: p, dx: dx, dy: dy)
        }
    }

    /// Relative motion (pointer lock / games): apps that hide the cursor read the deltas.
    public func moveBy(_ dx: Int, _ dy: Int) {
        queue.async { [self] in
            let cur = CGEvent(source: nil)?.location ?? lastPos ?? .zero
            let p = Self.clampToDisplays(CGPoint(x: cur.x + CGFloat(dx), y: cur.y + CGFloat(dy)))
            lastPos = p
            postMove(to: p, dx: CGFloat(dx), dy: CGFloat(dy))
        }
    }

    private func postMove(to p: CGPoint, dx: CGFloat, dy: CGFloat) {
        let type: CGEventType
        var button = CGMouseButton.left
        if buttonsDown.contains(0) { type = .leftMouseDragged }
        else if buttonsDown.contains(2) { type = .rightMouseDragged; button = .right }
        else if let other = buttonsDown.first { type = .otherMouseDragged; button = CGMouseButton(rawValue: UInt32(Self.cgButtonNumber(other))) ?? .center }
        else { type = .mouseMoved }
        let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)
        e?.setIntegerValueField(.mouseEventDeltaX, value: Int64(dx.rounded()))
        e?.setIntegerValueField(.mouseEventDeltaY, value: Int64(dy.rounded()))
        e?.flags = modifierFlags
        post(e)
    }

    /// 0 left, 1 middle, 2 right, 3 back, 4 forward — same numbering as MouseEvent.button.
    public func button(_ ctx: InputContext, _ b: Int, down: Bool) {
        guard (0...4).contains(b) else { return }
        ctx.lock.lock(); if down { ctx.buttons.insert(b) } else { ctx.buttons.remove(b) }; ctx.lock.unlock()
        moveOrder.with { $0.barrier = $0.latest }
        queue.async { [self] in sendButton(b, down: down) }
    }

    /// Where the next click lands: the position we last posted (the system's cursor can lag a just-posted move).
    private var clickPosition: CGPoint {
        lastPos ?? CGEvent(source: nil)?.location ?? .zero
    }

    private static func cgButtonNumber(_ b: Int) -> Int {
        switch b { case 0: return 0; case 2: return 1; case 1: return 2; default: return b } // 3 back, 4 forward
    }

    private func sendButton(_ b: Int, down: Bool) {
        if down == buttonsDown.contains(b) { return }
        let pos = clickPosition
        if down {
            // Count clicks like the window server does: same button, within the double-click interval, nearby.
            let now = Date()
            if b == clickButton, now.timeIntervalSince(clickTime) <= NSEvent.doubleClickInterval, hypot(pos.x - clickPos.x, pos.y - clickPos.y) < 5 {
                clickCount = min(clickCount + 1, 3)
            } else {
                clickCount = 1
            }
            clickButton = b
            clickTime = now
            clickPos = pos
            buttonsDown.insert(b)
        } else {
            buttonsDown.remove(b)
        }
        let type: CGEventType
        let button: CGMouseButton
        switch b {
        case 0: type = down ? .leftMouseDown : .leftMouseUp; button = .left
        case 2: type = down ? .rightMouseDown : .rightMouseUp; button = .right
        default: type = down ? .otherMouseDown : .otherMouseUp; button = CGMouseButton(rawValue: UInt32(Self.cgButtonNumber(b))) ?? .center
        }
        let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: pos, mouseButton: button)
        e?.setIntegerValueField(.mouseEventClickState, value: Int64(b == clickButton ? clickCount : 1))
        e?.setIntegerValueField(.mouseEventButtonNumber, value: Int64(Self.cgButtonNumber(b)))
        e?.flags = modifierFlags
        post(e)
    }

    /// Wheel in Windows units (120 = one notch; fractions allowed). +dy scrolls up, +dx scrolls right.
    /// Sent as continuous pixel scrolling: the client maps ~100 px of pixel scrolling to 120 units, so
    /// dividing by 1.2 gives back the viewer's own scroll distance.
    public func wheel(_ dx: Int, _ dy: Int) {
        moveOrder.with { $0.barrier = $0.latest }
        queue.async { [self] in
            wheelAccX += Double(dx) / 1.2
            wheelAccY += Double(dy) / 1.2
            let px = Int32(wheelAccX.rounded(.towardZero)), py = Int32(wheelAccY.rounded(.towardZero))
            guard px != 0 || py != 0 else { return }
            wheelAccX -= Double(px)
            wheelAccY -= Double(py)
            // wheel1: +up; wheel2: +left (so a rightward scroll is negative).
            let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: py, wheel2: -px, wheel3: 0)
            e?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            e?.flags = modifierFlags
            post(e)
        }
    }

    // --------------------------------------------------------------------------------------- keyboard

    public func key(_ ctx: InputContext, _ code: String, down: Bool) {
        guard KeyMap.get(code) != nil else { return }
        ctx.lock.lock(); if down { ctx.keys.insert(code) } else { ctx.keys.remove(code) }; ctx.lock.unlock()
        queue.async { [self] in sendKey(code, down: down) }
    }

    private func sendKey(_ code: String, down: Bool) {
        guard let k = KeyMap.get(code) else { return }
        if let media = k.media { postMediaKey(media, down: down); return }
        if code == "CapsLock" {
            // Caps Lock is a lock state on macOS, not a key apps see: toggle it on each press.
            if down { Self.setCapsLock(!Self.capsLockOn) }
            return
        }
        if let mod = k.modifier {
            if down { heldModifiers[code] = mod } else { heldModifiers[code] = nil }
            let e = CGEvent(keyboardEventSource: source, virtualKey: k.code, keyDown: down)
            e?.type = .flagsChanged
            e?.flags = modifierFlags
            post(e)
            return
        }
        let e = CGEvent(keyboardEventSource: source, virtualKey: k.code, keyDown: down)
        e?.flags = modifierFlags.union(k.flags)
        post(e)
    }

    /// Types text independent of the Mac's keyboard layout (soft keyboards, dictation, IME, paste-as-keys).
    public func text(_ s: String) {
        guard !s.isEmpty else { return }
        queue.async { [self] in
            var chunk = [UniChar]()
            func flush() {
                guard !chunk.isEmpty else { return }
                for down in [true, false] {
                    let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                    e?.flags = []
                    chunk.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
                    post(e)
                }
                chunk.removeAll()
            }
            for ch in s.replacingOccurrences(of: "\r\n", with: "\n") {
                switch ch {
                case "\n", "\r": flush(); tap("Enter")
                case "\t": flush(); tap("Tab")
                case "\u{8}": flush(); tap("Backspace")
                default:
                    let units = Array(String(ch).utf16)
                    if chunk.count + units.count > 20 { flush() }
                    chunk.append(contentsOf: units)
                }
            }
            flush()
        }
    }

    private func tap(_ code: String) {
        sendKey(code, down: true)
        sendKey(code, down: false)
    }

    /// Press a chord (e.g. ⌘⌥Esc) and release in reverse order.
    public func chord(_ codes: [String]) {
        queue.async { [self] in
            for c in codes { sendKey(c, down: true) }
            for c in codes.reversed() { sendKey(c, down: false) }
        }
    }

    /// Make the Mac's Caps Lock match the viewer's so typed text has the right case. (No Num/Scroll Lock on a Mac.)
    public func syncLocks(caps: Bool) {
        queue.async {
            if Self.capsLockOn != caps { Self.setCapsLock(caps) }
        }
    }

    /// Releases everything this viewer still holds (disconnect, focus loss, tab switch).
    public func releaseAll(_ ctx: InputContext) {
        ctx.lock.lock()
        let keys = ctx.keys, buttons = ctx.buttons
        ctx.keys.removeAll()
        ctx.buttons.removeAll()
        ctx.lock.unlock()
        guard !keys.isEmpty || !buttons.isEmpty else { return }
        queue.async { [self] in
            for c in keys where c != "CapsLock" { sendKey(c, down: false) }
            for b in buttons { sendButton(b, down: false) }
        }
    }

    // --------------------------------------------------------------------------------------- system

    private func postMediaKey(_ type: Int32, down: Bool) {
        // NX_SYSDEFINED / NX_SUBTYPE_AUX_CONTROL_BUTTONS: how the keyboard's media keys reach the system.
        let flags = NSEvent.ModifierFlags(rawValue: down ? 0xA00 : 0xB00)
        let data1 = Int((Int(type) << 16) | ((down ? 0xA : 0xB) << 8))
        let ev = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags, timestamp: 0,
                                    windowNumber: 0, context: nil, subtype: 8, data1: data1, data2: -1)
        post(ev?.cgEvent)
    }

    static var capsLockOn: Bool { CGEventSource.flagsState(.hidSystemState).contains(.maskAlphaShift) }

    static func setCapsLock(_ on: Bool) {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching(kIOHIDSystemClass))
        guard service != 0 else { return }
        defer { IOObjectRelease(service) }
        var connect: io_connect_t = 0
        guard IOServiceOpen(service, mach_task_self_, UInt32(kIOHIDParamConnectType), &connect) == KERN_SUCCESS else { return }
        IOHIDSetModifierLockState(connect, Int32(kIOHIDCapsLockState), on)
        IOServiceClose(connect)
    }

    /// Lock the screen now (Control-Command-Q), via the login framework when available.
    public func lockScreen() {
        queue.async { [self] in
            typealias LockFn = @convention(c) () -> Int32
            if let h = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_LAZY),
               let sym = dlsym(h, "SACLockScreenImmediate") {
                _ = unsafeBitCast(sym, to: LockFn.self)()
                return
            }
            for c in ["ControlLeft", "MetaLeft", "KeyQ"] { sendKey(c, down: true) }
            for c in ["KeyQ", "MetaLeft", "ControlLeft"] { sendKey(c, down: false) }
        }
    }

    static func clampToDisplays(_ p: CGPoint) -> CGPoint {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var n: UInt32 = 0
        CGGetActiveDisplayList(16, &ids, &n)
        if ids.prefix(Int(n)).contains(where: { CGDisplayBounds($0).contains(p) }) { return p }
        // Outside every display: clamp into the nearest one.
        var best = p, bestD = CGFloat.greatestFiniteMagnitude
        for id in ids.prefix(Int(n)) {
            let b = CGDisplayBounds(id)
            let c = CGPoint(x: min(max(p.x, b.minX), b.maxX - 1), y: min(max(p.y, b.minY), b.maxY - 1))
            let d = hypot(c.x - p.x, c.y - p.y)
            if d < bestD { bestD = d; best = c }
        }
        return best
    }
}
