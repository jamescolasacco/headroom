import Foundation

/// Remote support, AnyDesk-style: the person at this computer creates a one-time code and gives it, with this
/// computer's Headroom ID, to someone who has no account and no pairing. They connect (usually through the
/// relay, from any browser); this computer asks Accept / Decline first unless that's turned off. An accepted
/// session gets a resume key, so a dropped connection reconnects without asking again; it lasts while the session
/// does (plus a few minutes), never longer than 12 hours, and nothing is saved to the config.
public final class SupportService {
    public static let shared = SupportService()

    public struct Decision {
        public let viewOnly: Bool
    }

    private struct Code {
        let value: String
        let expires: Date
        var failures = 0
    }

    private struct Pending {
        let id: String
        let name: String
        let ip: String?
        let created: Date
        let done: (Decision?) -> Void
    }

    private struct Session {
        var device: PairedDevice
        let tokenHash: String
        let created: Date
        var lastSeen: Date
        var active = 0
    }

    static let codeLifetime: TimeInterval = 3600
    static let approvalTimeout: TimeInterval = 60
    private static let resumeGrace: TimeInterval = 10 * 60
    private static let maxSessionAge: TimeInterval = 12 * 3600

    private let lock = NSLock()
    private var code: Code?
    private var pending: [Pending] = []
    private var sessions: [String: Session] = [:] // device id -> session

    // ------------------------------------------------------------------ codes

    /// A new 6-digit code (replacing any earlier one), valid for an hour or until a session it started is accepted.
    @discardableResult
    public func createCode() -> (code: String, expires: Date) {
        let value = (0..<6).map { _ in String(Int.random(in: 0...9)) }.joined()
        let c = Code(value: value, expires: Date().addingTimeInterval(Self.codeLifetime))
        lock.lock(); code = c; lock.unlock()
        Log.info("support", "new support code (valid \(Int(Self.codeLifetime / 60)) min)")
        return (value, c.expires)
    }

    public func cancelCode() {
        lock.lock(); code = nil; lock.unlock()
    }

    /// Checks a code someone typed. Five wrong guesses use the code up, so it can't be brute-forced.
    func verify(_ typed: String) -> Bool {
        let t = Array(typed.filter(\.isNumber).utf8)
        lock.lock(); defer { lock.unlock() }
        guard var c = code, c.expires > Date() else { code = nil; return false }
        if t.count == c.value.utf8.count, Bytes.constantTimeEquals(t, Array(c.value.utf8)) { return true }
        c.failures += 1
        code = c.failures >= 5 ? nil : c
        if code == nil { Log.warn("support", "support code withdrawn after 5 wrong guesses") }
        return false
    }

    // ------------------------------------------------------------------ approval

    /// Asks the person at this computer (the menu-bar app and the settings page show the request). `done` gets
    /// nil if declined, or after a minute without an answer.
    func requestApproval(name: String, ip: String?, done: @escaping (Decision?) -> Void) {
        guard ConfigStore.current.support.askBeforeAccepting else {
            done(Decision(viewOnly: false))
            return
        }
        let p = Pending(id: Bytes.base64Url(Bytes.random(6)), name: name, ip: ip, created: Date(), done: done)
        lock.lock(); pending.append(p); lock.unlock()
        Log.info("support", "'\(name)' (\(ip ?? "?")) asks to connect; waiting for an answer here")
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.approvalTimeout) { [weak self] in
            if self?.take(p.id) != nil {
                Log.info("support", "no answer for '\(name)' within \(Int(Self.approvalTimeout)) s: declined")
                done(nil)
            }
        }
    }

    /// The answer from the menu-bar app or the settings page.
    @discardableResult
    public func decide(id: String, accept: Bool, viewOnly: Bool) -> Bool {
        guard let p = take(id) else { return false }
        Log.info("support", "'\(p.name)' \(accept ? (viewOnly ? "accepted (view only)" : "accepted") : "declined")")
        p.done(accept ? Decision(viewOnly: viewOnly) : nil)
        return true
    }

    private func take(_ id: String) -> Pending? {
        lock.lock(); defer { lock.unlock() }
        guard let i = pending.firstIndex(where: { $0.id == id }) else { return nil }
        return pending.remove(at: i)
    }

    // ------------------------------------------------------------------ sessions

    /// After acceptance: the identity the session runs under and its resume key. Uses up the code.
    func startSession(name: String, viewOnly: Bool, ip: String?) -> (device: PairedDevice, token: String) {
        let token = Bytes.base64Url(Bytes.random(32))
        let hash = AuthService.hashToken(token)
        var dev = PairedDevice(id: "support:" + Bytes.base64Url(Bytes.random(6)), name: name, tokenHash: hash, created: Date(), lastAddress: ip)
        dev.viewOnly = viewOnly
        lock.lock()
        code = nil
        prune()
        sessions[dev.id] = Session(device: dev, tokenHash: hash, created: Date(), lastSeen: Date())
        lock.unlock()
        return (dev, token)
    }

    /// The support session presenting this resume key, if it's still valid.
    func device(forHash hash: String) -> PairedDevice? {
        let h = Array(hash.utf8)
        lock.lock(); defer { lock.unlock() }
        prune()
        return sessions.values.first { Bytes.constantTimeEquals(Array($0.tokenHash.utf8), h) }?.device
    }

    func device(id: String) -> PairedDevice? {
        lock.lock(); defer { lock.unlock() }
        return sessions[id]?.device
    }

    func sessionStarted(_ deviceId: String) {
        lock.lock(); sessions[deviceId]?.active += 1; sessions[deviceId]?.lastSeen = Date(); lock.unlock()
    }

    func sessionEnded(_ deviceId: String) {
        lock.lock()
        if var s = sessions[deviceId] { s.active = max(0, s.active - 1); s.lastSeen = Date(); sessions[deviceId] = s }
        lock.unlock()
    }

    /// Ends a support session for good (disconnected from here): its resume key stops working.
    public func revoke(_ deviceId: String) {
        lock.lock(); let removed = sessions.removeValue(forKey: deviceId) != nil; lock.unlock()
        if removed { Log.info("support", "support session \(deviceId) ended from this computer") }
    }

    public func revokeAll() {
        lock.lock(); sessions.removeAll(); lock.unlock()
    }

    private func prune() { // under lock
        let now = Date()
        sessions = sessions.filter { _, s in
            now.timeIntervalSince(s.created) < Self.maxSessionAge && (s.active > 0 || now.timeIntervalSince(s.lastSeen) < Self.resumeGrace)
        }
        if let c = code, c.expires <= now { code = nil }
    }

    // ------------------------------------------------------------------ status

    public var statusJson: JSONObject {
        lock.lock(); defer { lock.unlock() }
        prune()
        return [
            "code": code.map { ["code": $0.value, "expiresAt": $0.expires] as JSONObject } as Any?,
            "requests": pending.map { ["id": $0.id, "name": $0.name, "address": $0.ip as Any?, "created": $0.created] as JSONObject },
            "askBeforeAccepting": ConfigStore.current.support.askBeforeAccepting,
        ]
    }
}
