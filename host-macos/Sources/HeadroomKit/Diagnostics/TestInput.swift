import AppKit
import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// Test input (HEADROOM_TEST_INPUT=<file.jsonl>, only together with the test pattern): every input event the engine
/// would post to this Mac is recorded instead, so automated tests see exactly what would reach the app in front,
/// with no Accessibility permission and without ever touching the real Mac. InputInjector's choke point (`post`),
/// Caps Lock, locking the screen and the viewers' special actions all come here instead.
///
///  * `<file.jsonl>`: one line per event, `{"t": ms since the engine started, "kind": "key|flags|mouse|scroll|special|caps|media", ...}`
///    (emptied when the engine starts);
///  * `<file.jsonl>.state.json`: what the recorder keeps (TestInputModel.json), rewritten on every change;
///  * GET /api/admin/test-input (the same state) and POST /api/admin/test-input/reset, on the loopback admin API;
///  * the test pattern draws the field, what's held, the last event and the pointer (TestPatternSource).
public final class TestInput {
    /// The log, when test input is on: HEADROOM_TEST_INPUT set, with the synthetic display (--test-pattern).
    public static let logPath: String? = {
        guard let raw = ProcessInfo.processInfo.environment["HEADROOM_TEST_INPUT"], !raw.isEmpty else { return nil }
        guard Displays.testPatternSize != nil else {
            Log.warn("input", "HEADROOM_TEST_INPUT is ignored: it works only with the test pattern (--test-pattern); input goes to this Mac")
            return nil
        }
        return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath).standardizedFileURL.path
    }()

    public static var enabled: Bool { logPath != nil }

    public static let shared = TestInput(path: logPath)

    /// Where the pointer is before anything moves it (the real cursor is never read): the test display's centre.
    static var startPointer: CGPoint {
        let b = CGDisplayBounds(CGMainDisplayID())
        if !b.isEmpty { return CGPoint(x: b.midX, y: b.midY) }
        let (w, h) = Displays.testPatternSize ?? (1920, 1080)
        return CGPoint(x: w / 2, y: h / 2)
    }

    private let lock = NSLock()
    private var model = TestInputModel()
    private var version = 0
    private var lastDown: Date?
    private var capsOn = false
    private let keys = LayoutKeys()
    private let io = DispatchQueue(label: "headroom.testinput", qos: .utility)
    private let log: FileHandle?
    private let statePath: String?
    private var stateQueued = false // io-confined
    private static let started: Date = {
        // The engine's own start (the process's), so `t` lines up with the engine's log, not with the first event.
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return Date() }
        let tv = info.kp_proc.p_starttime
        return Date(timeIntervalSince1970: Double(tv.tv_sec) + Double(tv.tv_usec) / 1_000_000)
    }()

    private init(path: String?) {
        guard let path else { log = nil; statePath = nil; return }
        _ = Self.started
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: path, contents: nil) // a new log for each engine run
        log = FileHandle(forWritingAtPath: path)
        statePath = path + ".state.json"
        Log.info("input", "test input: recording to \(path) (state: \(path).state.json); nothing is posted to this Mac")
        io.async { [self] in writeState() }
    }

    // ------------------------------------------------------------------------------------------- what InputInjector sends

    /// An event InputInjector would have posted. `string`: the text a key event carries (CGEventKeyboardSetUnicodeString)
    /// when it was set explicitly; key events otherwise type what this Mac's layout makes of their key and flags.
    func record(_ e: CGEvent, string: String? = nil) {
        let t = Self.now
        let type = e.type
        switch type {
        case .keyDown, .keyUp:
            let code = Int(e.getIntegerValueField(.keyboardEventKeycode))
            let down = type == .keyDown
            let mods = TestInputModel.Mods(e.flags)
            var chars = "", base = ""
            if let string {
                chars = string; base = string
                if down { keys.clearDeadKey() }
            } else if down {
                (chars, base) = keys.translate(code, mods, compose: !mods.contains(.command) && !mods.contains(.control))
            } else {
                base = keys.translate(code, [], compose: false).1 // only to name the key
            }
            var fields: JSONObject = ["keycode": code, "down": down, "flags": mods.subtracting(.fn).names]
            if down { fields["chars"] = chars }
            if string != nil { fields["unicode"] = true }
            change(t, "key", fields) { $0.key(code: code, down: down, mods: mods, chars: chars, base: base) }
        case .flagsChanged:
            let code = Int(e.getIntegerValueField(.keyboardEventKeycode))
            let mods = TestInputModel.Mods(e.flags)
            change(t, "flags", ["keycode": code, "flags": mods.names]) { $0.flags(code: code, mods: mods) }
        case .mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
             .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            let kind: String
            switch type {
            case .mouseMoved: kind = "moved"
            case .leftMouseDown, .rightMouseDown, .otherMouseDown: kind = "down"
            case .leftMouseUp, .rightMouseUp, .otherMouseUp: kind = "up"
            default: kind = "dragged"
            }
            let button = kind == "moved" ? nil : TestInputModel.buttonName(Int(e.getIntegerValueField(.mouseEventButtonNumber)))
            let p = e.location
            let clicks = kind == "down" || kind == "up" ? Int(e.getIntegerValueField(.mouseEventClickState)) : 0
            var fields: JSONObject = ["type": kind, "x": p.x, "y": p.y, "flags": TestInputModel.Mods(e.flags).subtracting(.fn).names]
            if let button { fields["button"] = button }
            if kind == "down" || kind == "up" { fields["clickState"] = clicks }
            if kind == "down" { lock.lock(); lastDown = Date(); lock.unlock() }
            change(t, "mouse", fields) { $0.mouse(type: kind, button: button, x: p.x, y: p.y, clickState: clicks, t: t) }
        case .scrollWheel:
            // +dy up, +dx right (the protocol's directions), in the event's own units.
            let pixels = e.getIntegerValueField(.scrollWheelEventIsContinuous) != 0
            let dy = Double(e.getIntegerValueField(pixels ? .scrollWheelEventPointDeltaAxis1 : .scrollWheelEventDeltaAxis1))
            let dx = -Double(e.getIntegerValueField(pixels ? .scrollWheelEventPointDeltaAxis2 : .scrollWheelEventDeltaAxis2))
            change(t, "scroll", ["dx": dx, "dy": dy, "units": pixels ? "pixel" : "line", "flags": TestInputModel.Mods(e.flags).subtracting(.fn).names]) {
                $0.scroll(dx: dx, dy: dy)
            }
        default:
            // NX_SYSDEFINED, subtype 8: a media key (InputInjector.postMediaKey).
            if type.rawValue == 14, let ns = NSEvent(cgEvent: e), ns.subtype.rawValue == 8 {
                let code = (ns.data1 >> 16) & 0xFFFF
                let down = (ns.data1 >> 8) & 0xFF == 0xA
                let name = TestInputModel.mediaName(code)
                change(t, "media", ["key": name, "code": code, "down": down]) { $0.media(name, down: down) }
            } else {
                change(t, "other", ["type": Int(type.rawValue)]) { $0.other(Int(type.rawValue)) }
            }
        }
    }

    /// Where the recorded pointer is (global points), for showing it as this Mac's cursor.
    public var pointer: CGPoint {
        lock.lock(); defer { lock.unlock() }
        return model.pointer ?? Self.startPointer
    }

    /// Caps Lock as this Mac would have it (InputInjector reads this instead of the real lock state).
    var capsLockOn: Bool { lock.lock(); defer { lock.unlock() }; return capsOn }

    func setCapsLock(_ on: Bool) {
        lock.lock(); capsOn = on; lock.unlock()
        change(Self.now, "caps", ["on": on]) { $0.caps(on) }
    }

    /// A viewer's special action (lock, taskmgr, cad…) or the engine locking the screen: recorded, never performed.
    func special(_ action: String) {
        change(Self.now, "special", ["action": action]) { $0.special(action) }
    }

    // ------------------------------------------------------------------------------------------- state

    /// What the admin API and the state file show.
    public var state: JSONObject {
        lock.lock(); defer { lock.unlock() }
        var s = model.json
        if let p = Self.logPath { s["log"] = p }
        return s
    }

    /// Clears the field, shortcuts, clicks and counters (not the log, nor what's held or where the pointer is).
    public func reset() {
        lock.lock(); model.reset(); version += 1; lock.unlock()
        io.async { [self] in scheduleState() }
    }

    /// What the test pattern draws; `key` changes whenever the picture should.
    struct Overlay {
        let lines: [String]
        let pointer: CGPoint?
        let click: TestInputModel.Click?
        let key: Int
    }

    func overlay(fieldChars: Int = 48, now: Date = Date()) -> Overlay {
        lock.lock(); defer { lock.unlock() }
        let showClick = lastDown.map { now.timeIntervalSince($0) < 1 } ?? false
        return Overlay(lines: model.overlayLines(fieldChars: fieldChars), pointer: model.pointer, click: showClick ? model.clicks.last : nil,
                       key: version * 2 + (showClick ? 1 : 0))
    }

    private static var now: Int { Int((Date().timeIntervalSince(started) * 1000).rounded()) }

    private func change(_ t: Int, _ kind: String, _ fields: JSONObject, _ apply: (inout TestInputModel) -> Void) {
        lock.lock(); apply(&model); version += 1; lock.unlock()
        // `t` and `kind` first, so the lines read well.
        var line = Data("{\"t\":\(t),\"kind\":\"\(kind)\"".utf8)
        let rest = JSON.data(fields)
        if rest.count > 2 { line.append(UInt8(ascii: ",")); line.append(rest.dropFirst()) } else { line.append(UInt8(ascii: "}")) }
        line.append(0x0A)
        io.async { [self] in
            try? log?.write(contentsOf: line)
            scheduleState()
        }
    }

    /// io queue: one state write after the events already queued (a burst of moves writes it once).
    private func scheduleState() {
        guard !stateQueued else { return }
        stateQueued = true
        io.async { [self] in
            stateQueued = false
            writeState()
        }
    }

    private func writeState() {
        guard let statePath else { return }
        try? JSON.data(state, pretty: true).write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}

// ------------------------------------------------------------------------------------------- the model

/// What the recorder keeps, from the decoded events: a focused text field (the caret always at its end), the modifier
/// keys and buttons held, the pointer, the last 20 clicks, scroll totals and counters. Pure state (unit-tested).
struct TestInputModel {
    struct Mods: OptionSet {
        let rawValue: Int
        static let shift = Mods(rawValue: 1), control = Mods(rawValue: 2), option = Mods(rawValue: 4), command = Mods(rawValue: 8)
        static let caps = Mods(rawValue: 16), fn = Mods(rawValue: 32)

        init(rawValue: Int) { self.rawValue = rawValue }

        init(_ f: CGEventFlags) {
            var m: Mods = []
            if f.contains(.maskShift) { m.insert(.shift) }
            if f.contains(.maskControl) { m.insert(.control) }
            if f.contains(.maskAlternate) { m.insert(.option) }
            if f.contains(.maskCommand) { m.insert(.command) }
            if f.contains(.maskAlphaShift) { m.insert(.caps) }
            if f.contains(.maskSecondaryFn) { m.insert(.fn) }
            self = m
        }

        var names: [String] {
            [(Mods.shift, "shift"), (.control, "control"), (.option, "option"), (.command, "command"), (.caps, "caps"), (.fn, "fn")]
                .filter { contains($0.0) }.map(\.1)
        }

        /// ⌃⌥⇧⌘, in Apple's order, as menus show shortcuts.
        var symbols: String {
            [(Mods.control, "⌃"), (.option, "⌥"), (.shift, "⇧"), (.command, "⌘")].filter { contains($0.0) }.map(\.1).joined()
        }
    }

    struct Click {
        var button: String
        var clickState: Int
        var x: Double
        var y: Double
        var t: Int
    }

    var field = ""
    var shortcuts: [String] = []
    /// Modifier keys down, as the last flagsChanged event had them (Caps Lock is `caps`, a lock, not a key held).
    var held: Mods = []
    /// Other keys down (a key-down without its key-up yet), by key code, in the order pressed: a stuck key shows here.
    var keysDown: [(code: Int, label: String)] = []
    var caps = false
    var buttons: [String] = []
    var pointer: CGPoint?
    var clicks: [Click] = []
    var scrollX = 0.0, scrollY = 0.0, scrolls = 0
    var events = 0
    var specials: [String] = []
    var last = ""

    /// A key event. `chars`: what a key-down types (its own string, or the layout's character for its key and flags);
    /// `base`: the key's character with no modifiers (shortcuts are named with it).
    mutating func key(code: Int, down: Bool, mods: Mods, chars: String, base: String) {
        events += 1
        let label = Self.keyLabel(code: code, base: base)
        if down { if !keysDown.contains(where: { $0.code == code }) { keysDown.append((code, label)) } }
        else { keysDown.removeAll { $0.code == code } }
        guard down else { last = "\(label) up"; return }
        if mods.contains(.command) || mods.contains(.control) {
            let s = mods.symbols + label
            shortcuts.append(s)
            last = "shortcut \(s)"
            return
        }
        switch code {
        case 51:
            if !field.isEmpty { field.removeLast() }
            last = "delete"
        case 36, 76:
            field += "\n"
            last = "return"
        case 48:
            field += "\t"
            last = "tab"
        default:
            if Self.types(chars) {
                field += chars
                last = "typed \(Self.quoted(chars))"
            } else {
                last = "\(label) (types nothing)"
            }
        }
    }

    mutating func flags(code: Int, mods: Mods) {
        events += 1
        held = mods.subtracting(.caps)
        let name = Self.modifierName(code)
        if let entry = Self.modifierKeys.first(where: { $0.0.contains(code) }) {
            last = "\(name) \(held.contains(entry.1) ? "down" : "up")"
        } else {
            last = "\(name) flags \(mods.names.joined(separator: "+"))"
        }
    }

    mutating func mouse(type: String, button: String?, x: Double, y: Double, clickState: Int, t: Int) {
        events += 1
        pointer = CGPoint(x: x, y: y)
        let at = "at \(Int(x.rounded())),\(Int(y.rounded()))"
        let b = button ?? "left"
        switch type {
        case "down":
            if !buttons.contains(b) { buttons.append(b) }
            clicks.append(Click(button: b, clickState: clickState, x: x, y: y, t: t))
            if clicks.count > 20 { clicks.removeFirst(clicks.count - 20) }
            last = "\(b) down ×\(clickState) \(at)"
        case "up":
            buttons.removeAll { $0 == b }
            last = "\(b) up \(at)"
        case "dragged":
            last = "drag \(b) \(at)"
        default:
            last = "move \(at)"
        }
    }

    mutating func scroll(dx: Double, dy: Double) {
        events += 1
        scrolls += 1
        scrollX += dx
        scrollY += dy
        last = "scroll dx \(Self.num(dx)) dy \(Self.num(dy))"
    }

    mutating func special(_ action: String) {
        events += 1
        specials.append(action)
        last = "special \(action)"
    }

    mutating func caps(_ on: Bool) {
        events += 1
        caps = on
        last = "caps lock \(on ? "on" : "off")"
    }

    mutating func media(_ name: String, down: Bool) {
        events += 1
        last = "media \(name) \(down ? "down" : "up")"
    }

    mutating func other(_ type: Int) {
        events += 1
        last = "event type \(type)"
    }

    /// Clears the field, shortcuts, clicks and counters; what's held, Caps Lock and the pointer stay as they are.
    mutating func reset() {
        field = ""
        shortcuts = []
        clicks = []
        scrollX = 0; scrollY = 0; scrolls = 0
        events = 0
        specials = []
        last = "reset"
    }

    var json: JSONObject {
        [
            "field": field,
            "shortcuts": shortcuts,
            "held": held.names,
            "keys": keysDown.map(\.label),
            "caps": caps,
            "buttons": buttons,
            "pointer": pointer.map { ["x": Double($0.x), "y": Double($0.y)] as Any } ?? NSNull(),
            "clicks": clicks.map { ["button": $0.button, "clickState": $0.clickState, "x": $0.x, "y": $0.y, "t": $0.t] as JSONObject },
            "scroll": ["dx": scrollX, "dy": scrollY, "events": scrolls] as JSONObject,
            "events": events,
            "specials": specials,
            "last": last,
        ]
    }

    /// The test pattern's panel: the field's end (⏎ newline, ⇥ tab, ▏ the caret), what's held, the last event, the count.
    func overlayLines(fieldChars: Int) -> [String] {
        let shown = field.replacingOccurrences(of: "\r\n", with: "⏎").replacingOccurrences(of: "\n", with: "⏎")
            .replacingOccurrences(of: "\r", with: "⏎").replacingOccurrences(of: "\t", with: "⇥")
        var heldNow = held.names
        if caps { heldNow.append("capslock") }
        heldNow += keysDown.map(\.label)
        heldNow += buttons
        return [
            "FIELD: \(shown.suffix(max(1, fieldChars)))▏",
            "HELD: \(heldNow.isEmpty ? "none" : heldNow.joined(separator: " "))",
            "LAST: \(last.count > 40 ? String(last.prefix(39)) + "…" : last)",
            "EVENTS: \(events)",
        ]
    }

    // ------------------------------------------------------------------ names

    /// Typed text: something, and no control characters (escape, arrows, function keys translate to those).
    static func types(_ s: String) -> Bool {
        !s.isEmpty && !s.unicodeScalars.contains { $0.properties.generalCategory == .control }
    }

    private static let modifierKeys: [(Set<Int>, Mods)] = [([56, 60], .shift), ([59, 62], .control), ([58, 61], .option), ([55, 54], .command), ([63], .fn)]

    static func modifierName(_ code: Int) -> String {
        switch code {
        case 56: return "shift-left"
        case 60: return "shift-right"
        case 59: return "control-left"
        case 62: return "control-right"
        case 58: return "option-left"
        case 61: return "option-right"
        case 55: return "command-left"
        case 54: return "command-right"
        case 63: return "fn"
        default: return "key \(code)"
        }
    }

    private static let keyNames: [Int: String] = [
        36: "⏎", 76: "⌤", 48: "⇥", 49: "Space", 51: "⌫", 117: "⌦", 53: "⎋", 123: "←", 124: "→", 125: "↓", 126: "↑",
        115: "Home", 119: "End", 116: "PgUp", 121: "PgDn", 114: "Help", 71: "Clear",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10",
        103: "F11", 111: "F12", 105: "F13", 107: "F14", 113: "F15", 106: "F16", 64: "F17", 79: "F18", 80: "F19", 90: "F20",
    ]

    /// A key as a menu would name it in a shortcut: its symbol, or its character (capitalised).
    static func keyLabel(code: Int, base: String) -> String {
        if let n = keyNames[code] { return n }
        if types(base) { return base.uppercased() }
        return "key \(code)"
    }

    /// CGMouseButton numbering (0 left, 1 right, 2 middle, then back and forward).
    static func buttonName(_ n: Int) -> String {
        switch n {
        case 0: return "left"
        case 1: return "right"
        case 2: return "middle"
        case 3: return "back"
        case 4: return "forward"
        default: return "button\(n)"
        }
    }

    /// NX_KEYTYPE_* (InputInjector.postMediaKey).
    static func mediaName(_ code: Int) -> String {
        switch code {
        case 0: return "volume-up"
        case 1: return "volume-down"
        case 2: return "brightness-up"
        case 3: return "brightness-down"
        case 7: return "mute"
        case 16: return "play-pause"
        case 17: return "next"
        case 18: return "previous"
        default: return "media-\(code)"
        }
    }

    private static func quoted(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\n", with: "⏎").replacingOccurrences(of: "\t", with: "⇥") + "\""
    }

    private static func num(_ v: Double) -> String { v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v) }
}

// ------------------------------------------------------------------------------------------- the layout

/// What a key types on this Mac's current keyboard layout (UCKeyTranslate, as KeyboardLayout reads it), with dead
/// keys composed across key presses as a text field would (⌥E then E types é on a US layout).
private final class LayoutKeys {
    private let lock = NSLock()
    private var data: Data?
    private var keyboardType: UInt32 = 0
    private var readAt = Date.distantPast
    private var observing = false
    private var deadKeyState: UInt32 = 0

    func clearDeadKey() { lock.lock(); deadKeyState = 0; lock.unlock() }

    /// (what the key types with these modifiers, the key's own character with none). `compose`: a dead key pressed
    /// before counts (and this one may start another); otherwise this key's character as it is.
    func translate(_ code: Int, _ mods: TestInputModel.Mods, compose: Bool) -> (String, String) {
        refreshIfNeeded()
        lock.lock(); defer { lock.unlock() }
        guard let data, code >= 0, code < 0x80 else { return ("", "") }
        var modifiers = 0
        if mods.contains(.shift) { modifiers |= shiftKey }
        if mods.contains(.option) { modifiers |= optionKey }
        if mods.contains(.caps) { modifiers |= alphaLock }
        let state = UInt32((modifiers >> 8) & 0xFF)
        return data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> (String, String) in
            guard let layout = buf.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return ("", "") }
            var scratch: UInt32 = 0
            let base = Self.key(layout, code, 0, keyboardType, noDeadKeys: true, &scratch)
            let chars: String
            if compose {
                chars = Self.key(layout, code, state, keyboardType, noDeadKeys: false, &deadKeyState)
            } else {
                scratch = 0
                chars = Self.key(layout, code, state, keyboardType, noDeadKeys: true, &scratch)
            }
            return (chars, base)
        }
    }

    private static func key(_ layout: UnsafePointer<UCKeyboardLayout>, _ code: Int, _ modifiers: UInt32, _ keyboardType: UInt32,
                            noDeadKeys: Bool, _ dead: inout UInt32) -> String {
        var length = 0
        var chars = [UniChar](repeating: 0, count: 8)
        let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), modifiers, keyboardType,
                                    noDeadKeys ? OptionBits(kUCKeyTranslateNoDeadKeysMask) : 0, &dead, chars.count, &length, &chars)
        guard status == noErr else { return "" }
        return String(utf16CodeUnits: chars, count: length)
    }

    private func refreshIfNeeded() {
        lock.lock()
        let stale = Date().timeIntervalSince(readAt) > 30
        lock.unlock()
        guard stale else { return }
        // The Text Input Sources APIs belong to the main thread (as in KeyboardLayout).
        let read: () -> (Data?, UInt32) = {
            guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
                  let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return (nil, 0) }
            return (Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data, UInt32(LMGetKbdType()))
        }
        let (d, kbd) = Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
        lock.lock()
        data = d
        keyboardType = kbd
        readAt = Date()
        let watch = !observing
        observing = true
        lock.unlock()
        if watch {
            DistributedNotificationCenter.default().addObserver(
                forName: NSNotification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String), object: nil, queue: nil
            ) { [weak self] _ in
                guard let self else { return }
                self.lock.lock(); self.readAt = .distantPast; self.lock.unlock()
            }
        }
    }
}
