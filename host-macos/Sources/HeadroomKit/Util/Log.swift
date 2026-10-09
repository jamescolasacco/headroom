import Foundation

/// Tiny logger that writes to the console (when enabled) and a rolling file in the log directory.
/// Deliberately independent of any logging framework so the capture/encode threads can log cheaply:
/// formatting happens on the caller, I/O on one background queue.
public enum Log {
    public enum Level: Int, Comparable {
        case debug, info, warn, error
        public static func < (a: Level, b: Level) -> Bool { a.rawValue < b.rawValue }
        var char: Character {
            switch self {
            case .debug: return "D"
            case .info: return "I"
            case .warn: return "W"
            case .error: return "E"
            }
        }
    }

    public static var minLevel: Level = .info
    public static var consoleEnabled = true

    private static let queue = DispatchQueue(label: "headroom.log", qos: .utility)
    private static var file: FileHandle?
    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()
    private static let stampLock = NSLock()

    /// Opens `<dir>/headroom.log` (rotating to headroom.old.log past 8 MB). Without a directory, logs go to the console only.
    public static func initialize(logDir: String?) {
        guard let logDir else { return }
        let fm = FileManager.default
        do {
            try fm.createDirectory(atPath: logDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let path = (logDir as NSString).appendingPathComponent("headroom.log")
            if let size = (try? fm.attributesOfItem(atPath: path))?[.size] as? NSNumber, size.intValue > 8 * 1024 * 1024 {
                let old = (logDir as NSString).appendingPathComponent("headroom.old.log")
                try? fm.removeItem(atPath: old)
                try? fm.moveItem(atPath: path, toPath: old)
            }
            if !fm.fileExists(atPath: path) { fm.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            let h = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
            h.seekToEndOfFile()
            file = h
        } catch {
            FileHandle.standardError.write("[log] could not open log file: \(error)\n".data(using: .utf8)!)
        }
    }

    private static func write(_ level: Level, _ tag: String, _ message: String) {
        guard level >= minLevel else { return }
        stampLock.lock()
        let ts = stamp.string(from: Date())
        stampLock.unlock()
        let line = "\(ts) \(level.char) [\(tag)] \(message)\n"
        queue.async {
            if consoleEnabled { FileHandle.standardOutput.write(line.data(using: .utf8)!) }
            file?.write(line.data(using: .utf8)!)
        }
    }

    public static func debug(_ tag: String, _ message: @autoclosure () -> String) {
        if minLevel <= .debug { write(.debug, tag, message()) }
    }
    public static func info(_ tag: String, _ message: String) { write(.info, tag, message) }
    public static func warn(_ tag: String, _ message: String) { write(.warn, tag, message) }
    public static func error(_ tag: String, _ message: String) { write(.error, tag, message) }
    public static func error(_ tag: String, _ message: String, _ err: Error) { write(.error, tag, "\(message): \(err)") }

    /// Waits for queued lines to be written (before exit).
    public static func flush() {
        queue.sync { try? file?.synchronize() }
    }
}
