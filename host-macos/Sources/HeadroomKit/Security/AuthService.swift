import CommonCrypto
import CryptoKit
import Foundation

public enum PairResult { case ok, badCredentials, totpRequired, rateLimited, notConfigured }

/// Password + TOTP + device-token authentication (same scheme as the Windows host):
///  - The password (PBKDF2-SHA256, 600k iterations) is only used to pair a device.
///  - Pairing returns a 256-bit random bearer token; only its SHA-256 is stored.
///  - Every viewer connection authenticates with that token, so the password never travels again.
///  - Failed attempts are rate limited per IP and globally.
public enum AuthService {
    private static let pbkdf2Iterations = 600_000

    private struct FailureRecord { var count = 0; var blockedUntil = Date.distantPast; var lastFailure = Date.distantPast }
    private struct Ephemeral { let deviceId: String; let purpose: String; let value: String; let expires: Date }

    private static let lock = NSLock()
    private static var failures: [String: FailureRecord] = [:]
    private static var globalFailures: [Date] = []
    private static var pairCodes: [String: Date] = [:]
    private static var ephemeralTokens: [String: Ephemeral] = [:]

    public static var hasPassword: Bool { ConfigStore.current.password != nil }

    public struct PasswordTooShort: Error, CustomStringConvertible {
        public var description: String { "Password must be at least 8 characters." }
    }

    public static func setPassword(_ password: String) throws {
        guard password.count >= 8 else { throw PasswordTooShort() }
        let salt = Bytes.random(16)
        let hash = pbkdf2(Array(password.utf8), salt: salt, iterations: pbkdf2Iterations, length: 32)
        ConfigStore.update {
            $0.password = PasswordRecord(iterations: pbkdf2Iterations, salt: Data(salt).base64EncodedString(), hash: Data(hash).base64EncodedString())
        }
    }

    private static func verifyPassword(_ password: String) -> Bool {
        guard let rec = ConfigStore.current.password,
              let salt = Data(base64Encoded: rec.salt), let expected = Data(base64Encoded: rec.hash), rec.iterations > 0 else { return false }
        let actual = pbkdf2(Array(password.utf8), salt: [UInt8](salt), iterations: rec.iterations, length: expected.count)
        return Bytes.constantTimeEquals(actual, [UInt8](expected))
    }

    static func pbkdf2(_ password: [UInt8], salt: [UInt8], iterations: Int, length: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: length)
        let rc = password.withUnsafeBufferPointer { pw in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                 UnsafeRawPointer(pw.baseAddress).map { $0.assumingMemoryBound(to: Int8.self) }, pw.count,
                                 salt, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations), &out, length)
        }
        precondition(rc == kCCSuccess, "PBKDF2 failed")
        return out
    }

    // ---------------------------------------------------------------- rate limiting

    public static func retryAfter(_ ip: String?) -> TimeInterval? {
        let key = ip ?? "?"
        lock.lock(); defer { lock.unlock() }
        let now = Date()
        if let rec = failures[key], rec.blockedUntil > now { return rec.blockedUntil.timeIntervalSince(now) }
        pruneLocked(now)
        if globalFailures.count >= 30 { return 60 }
        return nil
    }

    private static func pruneLocked(_ now: Date) {
        globalFailures.removeAll { $0 < now.addingTimeInterval(-60) }
    }

    private static func recordFailure(_ ip: String?) {
        let key = ip ?? "?"
        lock.lock()
        let now = Date()
        var rec = failures[key] ?? FailureRecord()
        if rec.lastFailure < now.addingTimeInterval(-3600) { rec.count = 0 }
        rec.count += 1
        rec.lastFailure = now
        if rec.count >= 5 {
            // 5 free attempts, then 2s, 4s, 8s ... capped at 15 minutes.
            rec.blockedUntil = now.addingTimeInterval(min(900, pow(2, Double(rec.count - 4))))
        }
        failures[key] = rec
        globalFailures.append(now)
        pruneLocked(now)
        let count = rec.count
        lock.unlock()
        Log.warn("auth", "failed authentication from \(key) (count \(count))")
    }

    private static func recordSuccess(_ ip: String?) {
        lock.lock(); failures[ip ?? "?"] = nil; lock.unlock()
    }

    // ---------------------------------------------------------------- pairing

    /// Creates a short single-use pairing code (shown on the host, e.g. as a QR code).
    public static func createPairCode(lifetime: TimeInterval) -> String {
        // 10 chars of Crockford-ish base32 ≈ 50 bits; single use and short-lived.
        let alphabet = Array("ABCDEFGHJKMNPQRSTVWXYZ23456789")
        let code = String((0..<10).map { _ in alphabet[Bytes.randomInt(alphabet.count)] })
        lock.lock()
        let now = Date()
        pairCodes = pairCodes.filter { $0.value > now }
        pairCodes[code] = now.addingTimeInterval(lifetime)
        lock.unlock()
        return code
    }

    public static func pair(ip: String?, password: String?, totp: String?, pairCode: String?, deviceName: String) -> (PairResult, String?, PairedDevice?) {
        if retryAfter(ip) != nil { return (.rateLimited, nil, nil) }

        var ok = false
        if let pairCode, !pairCode.isEmpty {
            let normalized = pairCode.trimmingCharacters(in: .whitespaces).uppercased()
            lock.lock()
            if let exp = pairCodes.removeValue(forKey: normalized), exp > Date() { ok = true }
            lock.unlock()
        } else {
            if !hasPassword { return (.notConfigured, nil, nil) }
            if let password, !password.isEmpty, verifyPassword(password) {
                let cfg = ConfigStore.current
                if cfg.totpEnabled, let secret = cfg.totpSecret {
                    guard let totp, !totp.isEmpty else { return (.totpRequired, nil, nil) }
                    ok = Totp.verify(secret: secret, code: totp)
                } else {
                    ok = true
                }
            }
        }

        guard ok else {
            recordFailure(ip)
            return (.badCredentials, nil, nil)
        }
        recordSuccess(ip)

        let token = Bytes.base64Url(Bytes.random(32))
        let trimmed = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        let device = PairedDevice(
            id: Bytes.base64Url(Bytes.random(9)),
            name: trimmed.isEmpty ? "Device" : String(trimmed.prefix(64)),
            tokenHash: hashToken(token),
            created: Date(),
            lastAddress: ip)
        ConfigStore.update { $0.devices.append(device) }
        Log.info("auth", "paired new device '\(device.name)' (\(device.id)) from \(ip ?? "?")")
        return (.ok, token, device)
    }

    /// Validates a device bearer token. Returns the device or nil.
    public static func validateToken(_ token: String?, ip: String?, touch: Bool = true) -> PairedDevice? {
        guard let token, !token.isEmpty, token.count <= 128 else { return nil }
        if retryAfter(ip) != nil { return nil }
        let hashText = hashToken(token)
        let hash = Array(hashText.utf8)
        var match: PairedDevice?
        for d in ConfigStore.current.devices where Bytes.constantTimeEquals(Array(d.tokenHash.utf8), hash) { match = d }
        if match == nil {
            // A device of this computer's account? (If not yet known, it may have signed in moments ago: check in.)
            var acct = AccountService.shared.device(forHash: hashText)
            if acct == nil, AccountService.shared.refreshForUnknownToken() { acct = AccountService.shared.device(forHash: hashText) }
            if let a = acct {
                var d = PairedDevice(id: AccountService.localId(a.id), name: a.name, tokenHash: a.tokenHash, created: Date(), lastAddress: ip)
                d.viewOnly = a.viewOnly
                return d // account devices are managed (and their last-seen kept) by the account server
            }
        }
        guard let found = match else {
            recordFailure(ip)
            return nil
        }
        if touch {
            ConfigStore.update { c in
                if let i = c.devices.firstIndex(where: { $0.id == found.id }) {
                    c.devices[i].lastSeen = Date()
                    c.devices[i].lastAddress = ip
                }
            }
        }
        return found
    }

    @discardableResult
    public static func revokeDevice(_ id: String) -> Bool {
        var removed = false
        ConfigStore.update { c in
            let before = c.devices.count
            c.devices.removeAll { $0.id == id }
            removed = c.devices.count != before
        }
        if removed { Log.info("auth", "revoked device \(id)") }
        return removed
    }

    // ---------------------------------------------------------------- ephemeral URL tokens (downloads)

    /// Short-lived single-purpose token that can safely appear in a URL (e.g. a file download link that
    /// the browser opens itself, where we can't attach an Authorization header).
    public static func createEphemeral(deviceId: String, purpose: String, value: String, lifetime: TimeInterval) -> String {
        let t = Bytes.base64Url(Bytes.random(24))
        lock.lock()
        let now = Date()
        ephemeralTokens = ephemeralTokens.filter { $0.value.expires > now }
        ephemeralTokens[t] = Ephemeral(deviceId: deviceId, purpose: purpose, value: value, expires: now.addingTimeInterval(lifetime))
        lock.unlock()
        return t
    }

    public static func redeemEphemeral(_ token: String?, purpose: String) -> (value: String, deviceId: String)? {
        guard let token else { return nil }
        lock.lock()
        let e = ephemeralTokens.removeValue(forKey: token)
        lock.unlock()
        guard let e, e.expires > Date(), e.purpose == purpose else { return nil }
        guard deviceStatus(e.deviceId) != nil else { return nil }
        return (e.value, e.deviceId)
    }

    /// Whether a device (paired here, or an account device) still exists, and if it's view-only.
    public static func deviceStatus(_ id: String) -> (viewOnly: Bool, account: Bool)? {
        if let d = ConfigStore.current.devices.first(where: { $0.id == id }) { return (d.viewOnly, false) }
        if id.hasPrefix("account:"), let a = AccountService.shared.device(id: String(id.dropFirst(8))) { return (a.viewOnly, true) }
        return nil
    }

    public static func hashToken(_ token: String) -> String {
        Bytes.hexUpper(SHA256.hash(data: Data(token.utf8)))
    }
}

/// RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) — compatible with every authenticator app.
public enum Totp {
    private static let b32 = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    private static let lastUsedStep = Locked<Int64>(-1)

    public static func newSecret() -> String {
        var out = ""
        var buffer = 0, bits = 0
        for b in Bytes.random(20) {
            buffer = (buffer << 8) | Int(b)
            bits += 8
            while bits >= 5 {
                out.append(b32[(buffer >> (bits - 5)) & 31])
                bits -= 5
            }
        }
        if bits > 0 { out.append(b32[(buffer << (5 - bits)) & 31]) }
        return out
    }

    static func decodeBase32(_ s: String) -> [UInt8] {
        var out = [UInt8]()
        var buffer = 0, bits = 0
        for c in s.uppercased() where c != "=" && c != " " {
            guard let v = b32.firstIndex(of: c) else { continue }
            buffer = (buffer << 5) | v
            bits += 5
            if bits >= 8 {
                out.append(UInt8((buffer >> (bits - 8)) & 0xFF))
                bits -= 8
            }
        }
        return out
    }

    public static func compute(secret: String, step: Int64) -> String {
        let key = SymmetricKey(data: decodeBase32(secret))
        var s = step.bigEndian
        let msg = withUnsafeBytes(of: &s) { Data($0) }
        let mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: msg, using: key))
        let offset = Int(mac[mac.count - 1] & 0x0F)
        let code = (Int(mac[offset] & 0x7F) << 24) | (Int(mac[offset + 1]) << 16) | (Int(mac[offset + 2]) << 8) | Int(mac[offset + 3])
        return String(format: "%06d", code % 1_000_000)
    }

    public static func verify(secret: String, code: String) -> Bool {
        let c = code.replacingOccurrences(of: " ", with: "").trimmingCharacters(in: .whitespaces)
        guard c.count == 6 else { return false }
        let now = Int64(Date().timeIntervalSince1970) / 30
        for s in (now - 1)...(now + 1) where Bytes.constantTimeEquals(Array(compute(secret: secret, step: s).utf8), Array(c.utf8)) {
            // Reject replay of a code that was already accepted.
            return lastUsedStep.with { last in
                if s <= last { return false }
                last = s
                return true
            }
        }
        return false
    }

    public static func provisioningUri(secret: String, account: String) -> String {
        let acct = account.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "Headroom"
        return "otpauth://totp/Headroom:\(acct)?secret=\(secret)&issuer=Headroom&digits=6&period=30"
    }
}
