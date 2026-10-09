import CryptoKit
import Foundation
import NIOCore
import NIOSSL
import SwiftASN1
import X509

/// Provides the TLS certificate for every incoming connection (selected by SNI), like the Windows host:
///   * *.ts.net names     -> a real Let's Encrypt cert obtained with `tailscale cert` (no device setup needed)
///   * custom cert files  -> whatever the user configured
///   * everything else    -> a server cert issued by a per-host "Headroom Local CA". Install the CA once on
///                           each viewing device (iOS: download the profile from http://host:7080/).
/// Browsers require a secure context for WebCodecs, service workers and wss://, so this matters.
///
/// Keys and certificates live in <data>/certs as PEM files readable only by this user (the Windows host
/// uses DPAPI; here the per-user Library and 0600 permissions do that job, without keychain prompts).
public final class CertificateManager {
    private struct Leaf {
        let chain: [NIOSSLCertificate]
        let key: NIOSSLPrivateKey
        let der: [UInt8]
        let notAfter: Date
    }

    private let lock = NSLock()
    private var caCert: Certificate!
    private var caDer: [UInt8] = []
    private var caKey: P256.Signing.PrivateKey!
    private var server: Leaf!
    private var serverNames = Set<String>()
    private var tailscale: Leaf?
    private var tailscaleNameValue: String?
    private var tailscaleCheckedAt = Date.distantPast
    private var custom: Leaf?
    private var refreshTimer: DispatchSourceTimer?

    private var caCertFile: String { (Paths.certDir as NSString).appendingPathComponent("ca.crt") }
    private var caKeyFile: String { (Paths.certDir as NSString).appendingPathComponent("ca.key") }
    private var serverCertFile: String { (Paths.certDir as NSString).appendingPathComponent("server.crt") }
    private var serverKeyFile: String { (Paths.certDir as NSString).appendingPathComponent("server.key") }

    public init() {}

    public var tailscaleName: String? { lock.lock(); defer { lock.unlock() }; return tailscaleNameValue }

    public func initialize() throws {
        Paths.ensurePrivateDir(Paths.dataDir)
        Paths.ensurePrivateDir(Paths.certDir)
        let tls = ConfigStore.current.tls
        if tls.mode == "custom", let certFile = tls.certFile {
            do {
                custom = try loadPem(certFile: certFile, keyFile: tls.keyFile ?? certFile)
                Log.info("tls", "using custom certificate \(certFile)")
            } catch {
                Log.error("tls", "failed to load custom certificate; falling back to local CA", error)
            }
        }
        try loadOrCreateCa()
        try ensureServerCert(force: false)
        // `tailscale cert` can take up to a minute on first issuance: don't hold up the listeners for it.
        if tls.mode == "auto" || tls.mode == "tailscale" {
            DispatchQueue.global(qos: .utility).async { [weak self] in self?.tryRefreshTailscale() }
        }

        let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        t.schedule(deadline: .now() + 300, repeating: 300)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            do {
                try self.ensureServerCert(force: false)
                let mode = ConfigStore.current.tls.mode
                if mode == "auto" || mode == "tailscale" { self.tryRefreshTailscale() }
            } catch { Log.error("tls", "certificate refresh failed", error) }
        }
        t.resume()
        refreshTimer = t
    }

    // ------------------------------------------------------------------------------------------- TLS

    /// Server TLS configuration: HTTP/1.1 only (WebSockets ride on it), TLS 1.2+, and the certificate picked
    /// per connection from the SNI name. The full chain (leaf + issuer) is sent so clients can build it and
    /// Headroom Viewer can pin keys the server actually presents.
    public func makeTlsConfiguration() -> TLSConfiguration {
        let leaf = currentLeaf(for: nil)
        var cfg = TLSConfiguration.makeServerConfiguration(certificateChain: leaf.chain.map { .certificate($0) }, privateKey: .privateKey(leaf.key))
        cfg.minimumTLSVersion = .tlsv12
        cfg.applicationProtocols = ["http/1.1"]
        cfg.sslContextCallback = { [weak self] values, promise in
            guard let self else { promise.succeed(.noChanges); return }
            let leaf = self.currentLeaf(for: values.serverHostname)
            var o = NIOSSLContextConfigurationOverride()
            o.certificateChain = leaf.chain.map { .certificate($0) }
            o.privateKey = .privateKey(leaf.key)
            promise.succeed(o)
        }
        return cfg
    }

    private func currentLeaf(for sni: String?) -> Leaf {
        lock.lock(); defer { lock.unlock() }
        if let custom { return custom }
        if let tailscale, let sni, let name = tailscaleNameValue, sni.caseInsensitiveCompare(name) == .orderedSame { return tailscale }
        return server
    }

    public var serverNamesList: [String] { lock.lock(); defer { lock.unlock() }; return serverNames.sorted() }

    /// DER of the local CA certificate (served as /headroom-ca.crt).
    public var caCertificateDer: [UInt8] { lock.lock(); defer { lock.unlock() }; return caDer }

    /// SHA-1 of the CA certificate, uppercase hex (what Windows calls the thumbprint; iOS shows SHA-1 too).
    public var caThumbprint: String { Bytes.hexUpper(Insecure.SHA1.hash(data: caCertificateDer)) }

    /// SHA-256 of the server certificate's public key, first 128 bits as 8 groups of 4 hex digits —
    /// what Headroom Viewer pins and displays ("server key fingerprint").
    public var serverKeyFingerprint: String {
        let der: [UInt8]
        lock.lock(); der = server.der; lock.unlock()
        guard let cert = try? Certificate(derEncoded: der), let spki = try? Self.spkiBytes(cert) else { return "" }
        return Self.formatFingerprint(spki)
    }

    static func spkiBytes(_ cert: Certificate) throws -> [UInt8] {
        var s = DER.Serializer()
        try s.serialize(cert.publicKey)
        return s.serializedBytes
    }

    static func formatFingerprint(_ spki: [UInt8]) -> String {
        let hex = Bytes.hexUpper(SHA256.hash(data: spki)).prefix(32)
        return stride(from: 0, to: 32, by: 4).map { i in
            String(hex[hex.index(hex.startIndex, offsetBy: i)..<hex.index(hex.startIndex, offsetBy: i + 4)])
        }.joined(separator: " ")
    }

    // ------------------------------------------------------------------------------------------- local CA

    private func loadOrCreateCa() throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: caCertFile), fm.fileExists(atPath: caKeyFile) {
            do {
                let pem = try String(contentsOfFile: caCertFile, encoding: .utf8)
                let cert = try Certificate(pemEncoded: pem)
                let key = try P256.Signing.PrivateKey(pemRepresentation: try String(contentsOfFile: caKeyFile, encoding: .utf8))
                if cert.notValidAfter > Date().addingTimeInterval(30 * 86400) {
                    caCert = cert
                    caKey = key
                    caDer = try Self.der(cert)
                    return
                }
                Log.warn("tls", "local CA is about to expire; creating a new one (devices must re-install it)")
            } catch {
                Log.error("tls", "could not read local CA; creating a new one", error)
            }
        }

        let key = P256.Signing.PrivateKey()
        let name = try DistinguishedName {
            CommonName("Headroom Local CA (\(HostInfo.machineName))")
            OrganizationName("Headroom")
        }
        let notBefore = Date().addingTimeInterval(-86400)
        let pub = Certificate.PublicKey(key.publicKey)
        let ski = Self.keyIdentifier(key.publicKey)
        let cert = try Certificate(
            version: .v3,
            serialNumber: Self.randomSerial(),
            publicKey: pub,
            notValidBefore: notBefore,
            notValidAfter: notBefore.addingTimeInterval(10 * 365.25 * 86400),
            issuer: name,
            subject: name,
            signatureAlgorithm: .ecdsaWithSHA256,
            extensions: try Certificate.Extensions {
                Critical(BasicConstraints.isCertificateAuthority(maxPathLength: 0))
                Critical(KeyUsage(digitalSignature: true, keyCertSign: true, cRLSign: true))
                SubjectKeyIdentifier(keyIdentifier: ski[...])
            },
            issuerPrivateKey: Certificate.PrivateKey(key))
        try Paths.writePrivate(Data(key.pemRepresentation.utf8), to: caKeyFile)
        try Paths.writePrivate(Data(try cert.serializeAsPEM().pemString.utf8), to: caCertFile)
        try? FileManager.default.removeItem(atPath: serverCertFile) // force re-issue under the new CA
        caCert = cert
        caKey = key
        caDer = try Self.der(cert)
        Log.info("tls", "created local CA \(caThumbprint)")
    }

    private func ensureServerCert(force: Bool) throws {
        let names = Self.collectNames()
        lock.lock(); defer { lock.unlock() }

        if !force, server == nil, FileManager.default.fileExists(atPath: serverCertFile), FileManager.default.fileExists(atPath: serverKeyFile) {
            do {
                let cert = try Certificate(pemEncoded: try String(contentsOfFile: serverCertFile, encoding: .utf8))
                if cert.issuer == caCert.subject, caCert.publicKey.isValidSignature(cert.signature, for: cert) {
                    let key = try P256.Signing.PrivateKey(pemRepresentation: try String(contentsOfFile: serverKeyFile, encoding: .utf8))
                    server = try makeLeaf(cert, key)
                    serverNames = Self.readSans(cert)
                }
            } catch {
                Log.warn("tls", "could not read server cert: \(error)")
            }
        }

        let lowerNames = Set(names.map { $0.lowercased() })
        let needsNew = force || server == nil || server.notAfter < Date().addingTimeInterval(30 * 86400) || !lowerNames.isSubset(of: serverNames)
        guard needsNew else { return }

        // Keep previously seen names too so a temporarily-down interface doesn't churn the cert.
        let all = lowerNames.union(serverNames)
        let key = try loadOrCreateServerKey()
        let cert = try issueServerCert(names: all, key: key)
        try Paths.writePrivate(Data(try cert.serializeAsPEM().pemString.utf8), to: serverCertFile)
        server = try makeLeaf(cert, key)
        serverNames = all
        Log.info("tls", "issued server certificate for: \(all.sorted().joined(separator: ", "))")
    }

    /// The server's TLS key is generated once and reused for every re-issued certificate (renewal, new IP
    /// addresses). Desktop viewers pin this key, so the pin keeps working for the life of the install.
    private func loadOrCreateServerKey() throws -> P256.Signing.PrivateKey {
        if let pem = try? String(contentsOfFile: serverKeyFile, encoding: .utf8) {
            do { return try P256.Signing.PrivateKey(pemRepresentation: pem) } catch { Log.warn("tls", "server key unreadable, generating a new one: \(error)") }
        }
        let key = P256.Signing.PrivateKey()
        try Paths.writePrivate(Data(key.pemRepresentation.utf8), to: serverKeyFile)
        return key
    }

    private func issueServerCert(names: Set<String>, key: P256.Signing.PrivateKey) throws -> Certificate {
        var general = [GeneralName]()
        for n in names.sorted() {
            if let ip = Self.ipBytes(n) { general.append(.ipAddress(ASN1OctetString(contentBytes: ip[...]))) } else { general.append(.dnsName(n)) }
        }
        let subject = try DistinguishedName {
            CommonName(HostInfo.machineName)
            OrganizationName("Headroom")
        }
        let notBefore = Date().addingTimeInterval(-86400)
        // Apple: TLS server certs must be valid for at most 825 days (398 for public roots). Stay under both.
        var notAfter = notBefore.addingTimeInterval(397 * 86400)
        if notAfter > caCert.notValidAfter { notAfter = caCert.notValidAfter.addingTimeInterval(-86400) }
        let caSki = ((try? caCert.extensions.subjectKeyIdentifier) ?? nil)?.keyIdentifier ?? Self.keyIdentifier(caKey.publicKey)[...]
        return try Certificate(
            version: .v3,
            serialNumber: Self.randomSerial(),
            publicKey: Certificate.PublicKey(key.publicKey),
            notValidBefore: notBefore,
            notValidAfter: notAfter,
            issuer: caCert.subject,
            subject: subject,
            signatureAlgorithm: .ecdsaWithSHA256,
            extensions: try Certificate.Extensions {
                Critical(SubjectAlternativeNames(general))
                Critical(BasicConstraints.notCertificateAuthority)
                Critical(KeyUsage(digitalSignature: true, keyAgreement: true))
                // id-kp-serverAuth is mandatory for Apple platforms.
                try ExtendedKeyUsage([.serverAuth])
                SubjectKeyIdentifier(keyIdentifier: Self.keyIdentifier(key.publicKey)[...])
                AuthorityKeyIdentifier(keyIdentifier: caSki)
            },
            issuerPrivateKey: Certificate.PrivateKey(caKey))
    }

    private func makeLeaf(_ cert: Certificate, _ key: P256.Signing.PrivateKey) throws -> Leaf {
        let der = try Self.der(cert)
        let chain = [try NIOSSLCertificate(bytes: der, format: .der), try NIOSSLCertificate(bytes: caDer, format: .der)]
        let k = try NIOSSLPrivateKey(bytes: Array(key.pemRepresentation.utf8), format: .pem)
        return Leaf(chain: chain, key: k, der: der, notAfter: cert.notValidAfter)
    }

    static func der(_ cert: Certificate) throws -> [UInt8] {
        var s = DER.Serializer()
        try s.serialize(cert)
        return s.serializedBytes
    }

    /// RFC 5280 §4.2.1.2 method 1: SHA-1 of the subjectPublicKey bits.
    static func keyIdentifier(_ pub: P256.Signing.PublicKey) -> [UInt8] {
        Array(Insecure.SHA1.hash(data: pub.x963Representation))
    }

    static func randomSerial() -> Certificate.SerialNumber {
        var serial = Bytes.random(16)
        serial[0] &= 0x7F
        if serial[0] == 0 { serial[0] = 1 }
        return Certificate.SerialNumber(bytes: serial)
    }

    static func ipBytes(_ s: String) -> [UInt8]? {
        var v4 = in_addr()
        if inet_pton(AF_INET, s, &v4) == 1 { return withUnsafeBytes(of: &v4) { Array($0) } }
        var v6 = in6_addr()
        if inet_pton(AF_INET6, s, &v6) == 1 { return withUnsafeBytes(of: &v6) { Array($0) } }
        return nil
    }

    static func ipString(_ b: ArraySlice<UInt8>) -> String? {
        let bytes = Array(b)
        var buf = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        let family = bytes.count == 4 ? AF_INET : bytes.count == 16 ? AF_INET6 : -1
        guard family != -1, inet_ntop(family, bytes, &buf, socklen_t(buf.count)) != nil else { return nil }
        return String(cString: buf)
    }

    static func readSans(_ cert: Certificate) -> Set<String> {
        var set = Set<String>()
        guard let sans = try? cert.extensions.subjectAlternativeNames else { return set }
        for n in sans {
            switch n {
            case .dnsName(let d): set.insert(d.lowercased())
            case .ipAddress(let ip): if let s = ipString(ip.bytes) { set.insert(s) }
            default: break
            }
        }
        return set
    }

    static func collectNames() -> Set<String> {
        var names: Set<String> = ["localhost", "127.0.0.1", "::1"]
        let local = HostInfo.localHostName.lowercased()
        names.insert(local)
        names.insert(local + ".local")
        for a in NetInterfaces.localAddresses() where a.isV4 { names.insert(a.text) }
        for extra in ConfigStore.current.tls.extraNames {
            let t = extra.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { names.insert(t.lowercased()) }
        }
        return names
    }

    // ------------------------------------------------------------------------------------------- tailscale

    public static func findTailscaleCli() -> String? {
        let candidates = [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func tryRefreshTailscale() {
        lock.lock()
        let fresh = Date().timeIntervalSince(tailscaleCheckedAt) < 6 * 3600 && tailscale != nil
        if !fresh { tailscaleCheckedAt = Date() }
        lock.unlock()
        if fresh { return }
        guard let cli = Self.findTailscaleCli() else { return }
        guard let status = Self.run(cli, ["status", "--json"], timeout: 10), let json = JSON.parse(Data(status.utf8)) else { return }
        let dnsName = ((json["Self"] as? JSONObject)?["DNSName"] as? String)?.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let certsEnabled = (json["CertDomains"] as? [Any])?.isEmpty == false
        guard let dnsName, !dnsName.isEmpty, certsEnabled else {
            Log.info("tls", "Tailscale found but HTTPS certificates are not enabled for this tailnet (admin console > DNS > HTTPS Certificates).")
            return
        }
        // "-" writes to stdout: works with the sandboxed App Store build too, which can't write to our folder.
        guard let pem = Self.run(cli, ["cert", "--cert-file", "-", "--key-file", "-", dnsName], timeout: 60) else {
            Log.warn("tls", "tailscale cert failed")
            return
        }
        do {
            let certs = try NIOSSLCertificate.fromPEMBytes(Array(pem.utf8))
            guard let keyBlock = Self.pemBlock(pem, matching: "PRIVATE KEY"), let first = certs.first else {
                Log.warn("tls", "tailscale cert output had no certificate/key")
                return
            }
            let key = try NIOSSLPrivateKey(bytes: Array(keyBlock.utf8), format: .pem)
            let leafDer = try first.toDERBytes()
            let notAfter = (try? Certificate(derEncoded: leafDer))?.notValidAfter ?? Date().addingTimeInterval(30 * 86400)
            lock.lock()
            tailscale = Leaf(chain: certs, key: key, der: leafDer, notAfter: notAfter)
            tailscaleNameValue = dnsName
            lock.unlock()
            Log.info("tls", "Tailscale certificate ready for https://\(dnsName):\(ConfigStore.current.port)/ (expires \(notAfter))")
        } catch {
            Log.warn("tls", "Tailscale certificate unavailable: \(error)")
        }
    }

    static func pemBlock(_ pem: String, matching label: String) -> String? {
        let lines = pem.components(separatedBy: "\n")
        var out = [String]()
        var inBlock = false
        for l in lines {
            if l.hasPrefix("-----BEGIN") && l.contains(label) { inBlock = true }
            if inBlock { out.append(l) }
            if inBlock && l.hasPrefix("-----END") { break }
        }
        return out.isEmpty ? nil : out.joined(separator: "\n") + "\n"
    }

    static func run(_ exe: String, _ args: [String], timeout: TimeInterval) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let done = DispatchSemaphore(value: 0)
        var data = Data()
        DispatchQueue.global().async {
            data = out.fileHandleForReading.readDataToEndOfFile()
            done.signal()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            return nil
        }
        p.waitUntilExit()
        return p.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }

    // ------------------------------------------------------------------------------------------- helpers

    private func loadPem(certFile: String, keyFile: String) throws -> Leaf {
        let certs = try NIOSSLCertificate.fromPEMFile(certFile)
        guard let first = certs.first else { throw NIOSSLError.failedToLoadCertificate }
        let key = try NIOSSLPrivateKey(file: keyFile, format: .pem)
        let der = try first.toDERBytes()
        let notAfter = (try? Certificate(derEncoded: der))?.notValidAfter ?? .distantFuture
        return Leaf(chain: certs, key: key, der: der, notAfter: notAfter)
    }

    /// An Apple configuration profile that installs the local CA (Settings > General > VPN & Device Management).
    public func buildMobileConfig() -> Data {
        let der = Data(caCertificateDer).base64EncodedString()
        let host = Self.xmlEscape(HostInfo.machineName)
        let thumb = caThumbprint
        let payloadUuid = Self.deterministicUuid("payload:" + thumb)
        let profileUuid = Self.deterministicUuid("profile:" + thumb)
        let xml = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>headroom-ca.cer</string>
      <key>PayloadContent</key><data>\(der)</data>
      <key>PayloadDescription</key><string>Lets this device trust the Headroom host \(host).</string>
      <key>PayloadDisplayName</key><string>Headroom Local CA (\(host))</string>
      <key>PayloadIdentifier</key><string>app.headroom.ca.\(payloadUuid)</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>\(payloadUuid)</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>Installs the certificate authority used by Headroom on \(host). After installing, enable it in Settings &gt; General &gt; About &gt; Certificate Trust Settings.</string>
  <key>PayloadDisplayName</key><string>Headroom – \(host)</string>
  <key>PayloadIdentifier</key><string>app.headroom.profile.\(profileUuid)</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>\(profileUuid)</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>

"""
        return Data(xml.utf8)
    }

    static func xmlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&apos;")
    }

    static func deterministicUuid(_ seed: String) -> String {
        var b = Array(SHA256.hash(data: Data(seed.utf8)).prefix(16))
        b[6] = (b[6] & 0x0F) | 0x40
        b[8] = (b[8] & 0x3F) | 0x80
        return UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15])).uuidString
    }
}
