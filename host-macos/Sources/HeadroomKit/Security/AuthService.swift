import CryptoKit
import Foundation

/// Who may open a session here: your account's sign-ins (each presents a token derived for this computer by the
/// account server; only its SHA-256 is known here) and guests you accepted (with the resume key they were given).
/// Failed attempts are rate limited per address and overall.
public enum AuthService {
    private struct FailureRecord { var count = 0; var blockedUntil = Date.distantPast; var lastFailure = Date.distantPast }
    private struct Ephemeral { let deviceId: String; let purpose: String; let value: String; let expires: Date }

    private static let lock = NSLock()
    private static var failures: [String: FailureRecord] = [:]
    private static var globalFailures: [Date] = []
    private static var ephemeralTokens: [String: Ephemeral] = [:]

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

    static func recordFailure(_ ip: String?) {
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

    /// A successful authentication clears the address's failures (it takes valid credentials, so it can't be abused).
    static func recordSuccess(_ ip: String?) {
        lock.lock(); failures[ip ?? "?"] = nil; lock.unlock()
    }

    /// Validates a session token: an account sign-in's, or an accepted guest's resume key. Returns who it is, or nil.
    public static func validateToken(_ token: String?, ip: String?, touch: Bool = true) -> PairedDevice? {
        guard let token, !token.isEmpty, token.count <= 128 else { return nil }
        if retryAfter(ip) != nil { return nil }
        let hashText = hashToken(token)
        // A guest reconnecting with its resume key (checked before the slower path below).
        if let s = SupportService.shared.device(forHash: hashText) { recordSuccess(ip); return s }
        // A sign-in of this computer's account? (If not yet known, it may have signed in moments ago: check in.)
        var acct = AccountService.shared.device(forHash: hashText)
        if acct == nil, AccountService.shared.refreshForUnknownToken() { acct = AccountService.shared.device(forHash: hashText) }
        guard let a = acct else {
            recordFailure(ip)
            return nil
        }
        var d = PairedDevice(id: AccountService.localId(a.id), name: a.name, tokenHash: a.tokenHash, created: Date(), lastAddress: ip)
        d.viewOnly = a.viewOnly
        recordSuccess(ip)
        return d // account sign-ins are managed (and their last-seen kept) by the account server
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
        guard allowed(e.deviceId) != nil else { return nil }
        return (e.value, e.deviceId)
    }

    /// What a session's owner may do right now, if they still may connect at all: an account sign-in gets this
    /// computer's settings; a guest gets what was allowed when they were accepted (or changed since).
    public static func allowed(_ id: String) -> SessionRights? {
        if id.hasPrefix("account:"), let a = AccountService.shared.device(id: String(id.dropFirst(8))) {
            let p = ConfigStore.current.permissions
            return SessionRights(input: p.input && !a.viewOnly, files: p.fileTransfer && !a.viewOnly, clipboard: p.clipboard, guest: false)
        }
        if id.hasPrefix("guest:") { return SupportService.shared.rights(id) }
        return nil
    }

    public static func hashToken(_ token: String) -> String {
        Bytes.hexUpper(SHA256.hash(data: Data(token.utf8)))
    }
}

/// What a session may do besides watching.
public struct SessionRights: Equatable {
    public var input: Bool
    public var files: Bool
    public var clipboard: Bool
    public var guest: Bool
    public var json: JSONObject { ["input": input, "files": files, "clipboard": clipboard] }
}
