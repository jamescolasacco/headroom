import Foundation

/// Guest codes, AnyDesk-style. "Let someone connect" makes a 9-digit code (and a link with it); someone with no
/// account and nothing to install enters it in their browser. This computer always asks Accept / Decline first,
/// and the person here decides what the guest may do (control, files, clipboard), and can change it or stop the
/// session at any time.
///
/// The first 4 digits find this computer on the relay; the other 5 are known only here (the relay never sees
/// them), and five wrong tries use the code up. A code works for one accepted guest, for 10 minutes at most. The
/// accepted guest gets a resume key so a dropped connection comes back without asking again: for 2 minutes after
/// it drops, 12 hours at most in all. Nothing is saved.
public final class SupportService {
    public static let shared = SupportService()

    public struct Decision {
        public let viewOnly: Bool
        public let files: Bool
        public let clipboard: Bool
        public init(viewOnly: Bool, files: Bool, clipboard: Bool) {
            self.viewOnly = viewOnly
            self.files = files
            self.clipboard = clipboard
        }
    }

    private struct Code {
        let slot: String
        let secret: String
        let expires: Date
        var failures = 0
        var value: String { slot + secret }
    }

    private struct Pending {
        let id: String
        let name: String
        let ip: String?
        let country: String?
        let created: Date
        let done: (Decision?) -> Void
    }

    private struct Session {
        var device: PairedDevice
        let tokenHash: String
        let created: Date
        var lastSeen: Date
        var active = 0
        var rights: SessionRights
    }

    static let approvalTimeout: TimeInterval = 120
    private static let resumeGrace: TimeInterval = 120
    private static let maxSessionAge: TimeInterval = 12 * 3600
    private static let maxPending = 3

    private let lock = NSLock()
    private var code: Code?
    private var pending: [Pending] = []
    private var sessions: [String: Session] = [:] // device id -> session

    // ------------------------------------------------------------------ codes

    public enum CodeError: Error, CustomStringConvertible {
        case offline(String?)
        case failed(String)
        public var description: String {
            switch self {
            case .offline(let why): return "This computer isn't connected to Headroom right now\(why.map { " (\($0))" } ?? ""). Check the internet connection and try again."
            case .failed(let why): return why
            }
        }
    }

    /// A new code, replacing any earlier one. Needs the relay connection (it hands out the first 4 digits).
    public func createCode(_ done: @escaping (Result<(code: String, expires: Date, link: String), CodeError>) -> Void) {
        RelayService.shared.requestSlot { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let e):
                done(.failure(e))
            case .success(let slot):
                let secret = (0..<5).map { _ in String(Bytes.randomInt(10)) }.joined()
                let c = Code(slot: slot.slot, secret: secret, expires: min(slot.expires, Date().addingTimeInterval(600)))
                self.lock.lock(); self.code = c; self.lock.unlock()
                Log.info("guest", "new guest code, valid \(Int(c.expires.timeIntervalSinceNow / 60)) min")
                done(.success((c.value, c.expires, Self.link(c.value))))
            }
        }
    }

    static func link(_ code: String) -> String { RelayService.shared.publicBase + "/#code=" + code }

    /// "Stop sharing": the code stops working (on the relay too).
    public func cancelCode() {
        lock.lock(); let had = code != nil; code = nil; lock.unlock()
        if had { RelayService.shared.releaseSlot() }
    }

    /// The relay connection dropped: its slots are gone, so is the code.
    func relayDropped() {
        lock.lock(); code = nil; lock.unlock()
    }

    /// Checks a code someone typed. Five wrong tries use the code up, so the 5 secret digits can't be guessed.
    func verify(_ typed: String) -> Bool {
        let t = Array(typed.filter(\.isNumber).utf8)
        lock.lock()
        guard var c = code, c.expires > Date() else { code = nil; lock.unlock(); return false }
        if t.count == c.value.utf8.count, Bytes.constantTimeEquals(t, Array(c.value.utf8)) { lock.unlock(); return true }
        c.failures += 1
        code = c.failures >= 5 ? nil : c
        let withdrawn = code == nil
        lock.unlock()
        if withdrawn {
            Log.warn("guest", "guest code withdrawn after 5 wrong tries")
            RelayService.shared.releaseSlot()
        }
        return false
    }

    // ------------------------------------------------------------------ approval

    /// Asks the person at this computer (the menu-bar app and the settings window show the request). `done` gets
    /// nil if declined, or after two minutes without an answer.
    func requestApproval(name: String, ip: String?, country: String?, done: @escaping (Decision?) -> Void) {
        let p = Pending(id: Bytes.base64Url(Bytes.random(6)), name: name, ip: ip, country: country, created: Date(), done: done)
        lock.lock()
        let full = pending.count >= Self.maxPending
        if !full { pending.append(p) }
        lock.unlock()
        if full { done(nil); return }
        Log.info("guest", "'\(name)' (\(ip ?? "?")\(country.map { ", \($0)" } ?? "")) asks to connect; waiting for an answer here")
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.approvalTimeout) { [weak self] in
            if self?.take(p.id) != nil {
                Log.info("guest", "no answer for '\(name)' within \(Int(Self.approvalTimeout)) s: declined")
                done(nil)
            }
        }
    }

    /// The answer from the menu-bar app or the settings window.
    @discardableResult
    public func decide(id: String, accept: Bool, viewOnly: Bool, files: Bool, clipboard: Bool) -> Bool {
        guard let p = take(id) else { return false }
        Log.info("guest", "'\(p.name)' \(accept ? "accepted\(viewOnly ? " (view only)" : "")\(files ? ", files" : "")\(clipboard ? ", clipboard" : "")" : "declined")")
        // Declining ends the code too, so whoever had it can't ask again with it (make a new one for the right person).
        if !accept { cancelCode() }
        p.done(accept ? Decision(viewOnly: viewOnly, files: files, clipboard: clipboard) : nil)
        return true
    }

    /// The guest went away while waiting.
    func withdraw(name: String, ip: String?) {
        lock.lock()
        let gone = pending.filter { $0.name == name && $0.ip == ip }
        pending.removeAll { $0.name == name && $0.ip == ip }
        lock.unlock()
        for p in gone { p.done(nil) }
    }

    private func take(_ id: String) -> Pending? {
        lock.lock(); defer { lock.unlock() }
        guard let i = pending.firstIndex(where: { $0.id == id }) else { return nil }
        return pending.remove(at: i)
    }

    // ------------------------------------------------------------------ sessions

    /// After acceptance: the identity the session runs under and its resume key. Uses up the code; anyone else
    /// still waiting with it is declined.
    func startSession(name: String, decision: Decision, ip: String?) -> (device: PairedDevice, token: String) {
        let token = Bytes.base64Url(Bytes.random(32))
        let hash = AuthService.hashToken(token)
        var dev = PairedDevice(id: "guest:" + Bytes.base64Url(Bytes.random(6)), name: name, tokenHash: hash, created: Date(), lastAddress: ip)
        dev.viewOnly = decision.viewOnly
        let rights = SessionRights(input: !decision.viewOnly, files: decision.files, clipboard: decision.clipboard, guest: true)
        lock.lock()
        let hadCode = code != nil
        code = nil
        let others = pending
        pending.removeAll()
        prune()
        sessions[dev.id] = Session(device: dev, tokenHash: hash, created: Date(), lastSeen: Date(), rights: rights)
        lock.unlock()
        if hadCode { RelayService.shared.releaseSlot() }
        for p in others { p.done(nil) }
        return (dev, token)
    }

    /// The guest presenting this resume key, if it's still valid.
    func device(forHash hash: String) -> PairedDevice? {
        let h = Array(hash.utf8)
        lock.lock(); defer { lock.unlock() }
        prune()
        return sessions.values.first { Bytes.constantTimeEquals(Array($0.tokenHash.utf8), h) }?.device
    }

    func rights(_ deviceId: String) -> SessionRights? {
        lock.lock(); defer { lock.unlock() }
        return sessions[deviceId]?.rights
    }

    /// The person here changed what a guest may do: applies at once, to the running session too.
    @discardableResult
    public func setRights(_ deviceId: String, input: Bool?, files: Bool?, clipboard: Bool?) -> Bool {
        lock.lock()
        guard var s = sessions[deviceId] else { lock.unlock(); return false }
        if let input { s.rights.input = input; s.device.viewOnly = !input }
        if let files { s.rights.files = files }
        if let clipboard { s.rights.clipboard = clipboard }
        sessions[deviceId] = s
        lock.unlock()
        SessionManager.rightsChanged(deviceId)
        return true
    }

    func sessionStarted(_ deviceId: String) {
        lock.lock(); sessions[deviceId]?.active += 1; sessions[deviceId]?.lastSeen = Date(); lock.unlock()
    }

    func sessionEnded(_ deviceId: String) {
        lock.lock()
        if var s = sessions[deviceId] { s.active = max(0, s.active - 1); s.lastSeen = Date(); sessions[deviceId] = s }
        lock.unlock()
    }

    /// Ends a guest's access for good (stopped from here): its resume key stops working.
    public func revoke(_ deviceId: String) {
        lock.lock(); let removed = sessions.removeValue(forKey: deviceId) != nil; lock.unlock()
        if removed { Log.info("guest", "guest session \(deviceId) ended from this computer") }
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
            "code": code.map { ["code": $0.value, "expiresAt": $0.expires, "link": Self.link($0.value)] as JSONObject } as Any?,
            "requests": pending.map {
                ["id": $0.id, "name": $0.name, "address": $0.ip as Any?, "country": $0.country as Any?, "created": $0.created] as JSONObject
            },
        ]
    }
}
