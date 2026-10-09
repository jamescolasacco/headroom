import CryptoKit
import Foundation
import Security

/// Certificates the viewer trusts *for itself only* (never added to the macOS keychain or trust settings).
/// Each Headroom computer has its own self-signed local CA. After the user confirms the fingerprint once
/// (trust on first use) we pin that computer's server key: TLS challenges from the page (fetch, WebSocket,
/// downloads) are accepted when the leaf's key matches a pin for that host. Headroom Server keeps the same key
/// across certificate renewals, so the pin lasts. Same scheme and fingerprint format as the Windows viewer.
enum TrustStore {
    struct Pin: Codable {
        let host: String
        let spki: String         // base64 SHA-256 of SubjectPublicKeyInfo
        let fingerprint: String  // first 128 bits, hex, grouped
        let subject: String
        let added: Date
    }

    static let dataDir: URL = {
        if let d = ProcessInfo.processInfo.environment["HEADROOM_VIEWER_DATA"], !d.isEmpty { return URL(fileURLWithPath: d) }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Headroom Viewer")
    }()

    private static var file: URL { dataDir.appendingPathComponent("trusted-hosts.json") }
    private static let lock = NSLock()
    private static var cached: [Pin]?

    static var pins: [Pin] {
        lock.lock(); defer { lock.unlock() }
        if let c = cached { return c }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        let p = (try? Data(contentsOf: file)).flatMap { try? dec.decode([Pin].self, from: $0) } ?? []
        cached = p
        return p
    }

    static func add(_ pin: Pin) {
        var list = pins.filter { !($0.host == pin.host && $0.spki == pin.spki) }
        list.append(pin)
        lock.lock()
        cached = list
        lock.unlock()
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted]
        enc.dateEncodingStrategy = .iso8601
        if let d = try? enc.encode(list) { try? d.write(to: file, options: .atomic) }
    }

    /// Whether the server's leaf certificate is pinned for this host.
    static func isPinned(host: String, trust: SecTrust) -> Bool {
        guard let leaf = leafCertificate(trust), let spki = spkiHash(leaf) else { return false }
        let h = normalizeHost(host)
        return pins.contains { normalizeHost($0.host) == h && $0.spki == spki }
    }

    static func normalizeHost(_ h: String) -> String {
        h.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    }

    static func leafCertificate(_ trust: SecTrust) -> SecCertificate? {
        (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
    }

    static func spkiBytes(_ cert: SecCertificate) -> [UInt8]? {
        DER.subjectPublicKeyInfo(Array(SecCertificateCopyData(cert) as Data))
    }

    static func spkiHash(_ cert: SecCertificate) -> String? {
        spkiBytes(cert).map { Data(SHA256.hash(data: $0)).base64EncodedString() }
    }

    /// First 128 bits of SHA-256(SPKI) in hex — the "server key fingerprint" Headroom Server shows.
    static func fingerprint(_ cert: SecCertificate) -> String {
        guard let spki = spkiBytes(cert) else { return "?" }
        let hex = SHA256.hash(data: spki).map { String(format: "%02X", $0) }.joined().prefix(32)
        return stride(from: 0, to: 32, by: 4).map { i in
            String(hex[hex.index(hex.startIndex, offsetBy: i)..<hex.index(hex.startIndex, offsetBy: i + 4)])
        }.joined(separator: " ")
    }

    static func subjectName(_ cert: SecCertificate) -> String {
        (SecCertificateCopySubjectSummary(cert) as String?) ?? "unknown"
    }

    // ------------------------------------------------------------------ probing a new computer

    struct ProbeResult {
        var publiclyTrusted = false
        var leaf: SecCertificate?
        var issuedByHostCa = false
        var error: String?
    }

    /// Connects to https://host:port and returns its certificate (inspection only: nothing is sent). If it isn't
    /// publicly trusted, also checks it against the computer's local CA from its plain-HTTP setup port.
    static func probe(_ url: URL, helperPort: Int = 7080, done: @escaping (ProbeResult) -> Void) {
        let capture = ProbeDelegate()
        let session = URLSession(configuration: .ephemeral, delegate: capture, delegateQueue: nil)
        var req = URLRequest(url: url.appendingPathComponent("api/info"))
        req.timeoutInterval = 6
        session.dataTask(with: req) { _, _, err in
            session.finishTasksAndInvalidate()
            var r = ProbeResult()
            r.publiclyTrusted = capture.trusted
            r.leaf = capture.chain.first
            guard let leaf = r.leaf else {
                r.error = "Couldn't reach \(url.host ?? "?"):\(url.port ?? 443) (\(err?.localizedDescription ?? "no certificate"))."
                return done(r)
            }
            if r.publiclyTrusted { return done(r) }
            let host = url.host ?? ""
            let caUrl = URL(string: "http://\(host.contains(":") ? "[\(host)]" : host):\(helperPort)/headroom-ca.crt")!
            var caReq = URLRequest(url: caUrl)
            caReq.timeoutInterval = 6
            URLSession(configuration: .ephemeral).dataTask(with: caReq) { data, _, _ in
                if let data, let ca = SecCertificateCreateWithData(nil, data as CFData) {
                    var trust: SecTrust?
                    SecTrustCreateWithCertificates([leaf] + capture.chain.dropFirst() as CFArray, SecPolicyCreateSSL(true, host as CFString), &trust)
                    if let trust {
                        SecTrustSetAnchorCertificates(trust, [ca] as CFArray)
                        SecTrustSetAnchorCertificatesOnly(trust, true)
                        r.issuedByHostCa = SecTrustEvaluateWithError(trust, nil)
                    }
                }
                done(r)
            }.resume()
        }.resume()
    }

    private final class ProbeDelegate: NSObject, URLSessionDelegate {
        var chain: [SecCertificate] = []
        var trusted = false
        func urlSession(_ s: URLSession, didReceive c: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            guard c.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = c.protectionSpace.serverTrust else {
                return completionHandler(.performDefaultHandling, nil)
            }
            chain = (SecTrustCopyCertificateChain(trust) as? [SecCertificate]) ?? []
            trusted = SecTrustEvaluateWithError(trust, nil)
            // Already trusted: let the request finish. Otherwise we have what we came for.
            completionHandler(trusted ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
        }
    }
}

/// Just enough DER to find a certificate's SubjectPublicKeyInfo.
enum DER {
    /// Returns (header length, content length) of the element at `i`.
    private static func header(_ b: [UInt8], _ i: Int) -> (Int, Int)? {
        guard i + 1 < b.count else { return nil }
        let first = b[i + 1]
        if first < 0x80 { return (2, Int(first)) }
        let n = Int(first & 0x7F)
        guard n >= 1, n <= 4, i + 1 + n < b.count else { return nil }
        var len = 0
        for k in 0..<n { len = (len << 8) | Int(b[i + 2 + k]) }
        return (2 + n, len)
    }

    static func subjectPublicKeyInfo(_ cert: [UInt8]) -> [UInt8]? {
        // Certificate SEQUENCE -> tbsCertificate SEQUENCE
        guard cert.first == 0x30, let (h0, _) = header(cert, 0) else { return nil }
        var i = h0
        guard i < cert.count, cert[i] == 0x30, let (h1, _) = header(cert, i) else { return nil }
        i += h1
        // [0] version (optional), serialNumber, signature, issuer, validity, subject
        var skip = 5
        if i < cert.count && cert[i] == 0xA0 { skip = 6 }
        for _ in 0..<skip {
            guard let (h, l) = header(cert, i) else { return nil }
            i += h + l
        }
        guard i < cert.count, cert[i] == 0x30, let (h, l) = header(cert, i), i + h + l <= cert.count else { return nil }
        return Array(cert[i..<(i + h + l)])
    }
}
