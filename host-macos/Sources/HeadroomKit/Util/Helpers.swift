import Foundation
import Security

/// Process-wide monotonic clock in microseconds. Used for capture timestamps, pong replies and flow control.
public enum Clock {
    private static let start = DispatchTime.now().uptimeNanoseconds
    public static var nowUs: Int64 {
        let s = start // initialise the origin before sampling "now" (the first call would underflow otherwise)
        let n = DispatchTime.now().uptimeNanoseconds
        return n >= s ? Int64((n - s) / 1000) : 0
    }
    public static var nowMs: Int64 { nowUs / 1000 }
}

public enum Bytes {
    public static func random(_ count: Int) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: count)
        let rc = SecRandomCopyBytes(kSecRandomDefault, count, &b)
        precondition(rc == errSecSuccess, "SecRandomCopyBytes failed")
        return b
    }

    /// Uniform random integer in 0..<upper.
    public static func randomInt(_ upper: Int) -> Int {
        precondition(upper > 0)
        var x: UInt32 = 0
        let limit = UInt32.max - UInt32.max % UInt32(upper)
        repeat {
            withUnsafeMutableBytes(of: &x) { _ = SecRandomCopyBytes(kSecRandomDefault, 4, $0.baseAddress!) }
        } while x >= limit
        return Int(x % UInt32(upper))
    }

    public static func base64Url<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "=", with: "")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
    }

    public static func hexUpper<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        bytes.map { String(format: "%02X", $0) }.joined()
    }

    /// Constant-time comparison (only the length leaks).
    public static func constantTimeEquals(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }
}

/// Little-endian binary writing for wire messages.
extension Array where Element == UInt8 {
    mutating func putU16(_ v: UInt16, at o: Int) { self[o] = UInt8(v & 0xFF); self[o + 1] = UInt8(v >> 8) }
    mutating func putU32(_ v: UInt32, at o: Int) { for i in 0..<4 { self[o + i] = UInt8((v >> (8 * UInt32(i))) & 0xFF) } }
    mutating func putI32(_ v: Int32, at o: Int) { putU32(UInt32(bitPattern: v), at: o) }
    mutating func putI64(_ v: Int64, at o: Int) {
        let u = UInt64(bitPattern: v)
        for i in 0..<8 { self[o + i] = UInt8((u >> (8 * UInt64(i))) & 0xFF) }
    }
}

extension Collection where Element == UInt8, Index == Int {
    func u16(at o: Int) -> UInt16 { UInt16(self[startIndex + o]) | UInt16(self[startIndex + o + 1]) << 8 }
    func i16(at o: Int) -> Int16 { Int16(bitPattern: u16(at: o)) }
    func u32(at o: Int) -> UInt32 {
        var v: UInt32 = 0
        for i in 0..<4 { v |= UInt32(self[startIndex + o + i]) << (8 * UInt32(i)) }
        return v
    }
    func f32(at o: Int) -> Float { Float(bitPattern: u32(at: o)) }
}

/// Dynamic JSON in and out. Messages are small and schemaless (they mirror the C# anonymous objects), so
/// dictionaries are the honest representation.
public typealias JSONObject = [String: Any]

public enum JSON {
    public static func parse(_ data: Data) -> JSONObject? {
        guard !data.isEmpty, let o = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? JSONObject else { return nil }
        return o
    }

    public static func parse(_ bytes: [UInt8]) -> JSONObject? { parse(Data(bytes)) }

    /// Serializes; Optional.none values are dropped, Dates become ISO-8601.
    public static func data(_ value: Any, pretty: Bool = false) -> Data {
        let cleaned = clean(value)
        var opts: JSONSerialization.WritingOptions = [.fragmentsAllowed, .withoutEscapingSlashes]
        if pretty { opts.insert(.prettyPrinted); opts.insert(.sortedKeys) }
        return (try? JSONSerialization.data(withJSONObject: cleaned, options: opts)) ?? Data("{}".utf8)
    }

    public static func bytes(_ value: Any) -> [UInt8] { [UInt8](data(value)) }

    private static func clean(_ v: Any) -> Any {
        let m = Mirror(reflecting: v)
        if m.displayStyle == .optional {
            guard let first = m.children.first else { return NSNull() }
            return clean(first.value)
        }
        switch v {
        case let d as [String: Any]:
            var out = [String: Any]()
            for (k, x) in d {
                let xm = Mirror(reflecting: x)
                if xm.displayStyle == .optional && xm.children.isEmpty { continue }
                out[k] = clean(x)
            }
            return out
        case let a as [Any]: return a.map(clean)
        case let date as Date: return ISO8601.string(date)
        case let f as Float: return f.isFinite ? Double(f) : 0
        case let d as Double: return d.isFinite ? d : 0
        default: return v
        }
    }
}

public extension Dictionary where Key == String, Value == Any {
    func str(_ k: String) -> String? { self[k] as? String }
    func int(_ k: String) -> Int? {
        guard let n = self[k] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d == d.rounded(), abs(d) <= Double(Int32.max) else { return nil }
        return n.intValue
    }
    func double(_ k: String) -> Double? {
        guard let n = self[k] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue
    }
    /// True only for a JSON `true` (like the C# helper).
    func bool(_ k: String) -> Bool {
        guard let n = self[k] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return false }
        return n.boolValue
    }
    func boolIfPresent(_ k: String) -> Bool? {
        guard let n = self[k] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }
}

public enum ISO8601 {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let lock = NSLock()

    public static func string(_ d: Date) -> String {
        lock.lock(); defer { lock.unlock() }
        return withFraction.string(from: d)
    }

    public static func parse(_ s: String) -> Date? {
        lock.lock(); defer { lock.unlock() }
        if let d = withFraction.date(from: s) ?? plain.date(from: s) { return d }
        // .NET writes 7 fractional digits ("…20.3091007+00:00"); trim to milliseconds and retry.
        if let r = s.range(of: #"\.\d+"#, options: .regularExpression) {
            let frac = String(s[r].prefix(4))
            return withFraction.date(from: s.replacingCharacters(in: r, with: frac))
        }
        return nil
    }
}

/// A small mutex-protected value.
public final class Locked<T> {
    private var value: T
    private let lock = NSLock()
    public init(_ v: T) { value = v }
    @discardableResult
    public func with<R>(_ body: (inout T) throws -> R) rethrows -> R {
        lock.lock(); defer { lock.unlock() }
        return try body(&value)
    }
    public var get: T { with { $0 } }
}
