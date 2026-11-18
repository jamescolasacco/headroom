import AppKit
import CryptoKit
import Foundation
import Security

/// Headroom's updater for the Mac apps: it checks the latest GitHub release now and then, downloads it in the
/// background, checks it, and then offers "Restart to Update". It never restarts by itself: a remote-access app
/// that restarts while you're away could leave you outside.
///
/// What it trusts (every file comes from https://github.com/<repo>/releases/latest/download/):
///  - SHA256SUMS.txt lists the release's files and their SHA-256; when this app was built with Headroom's signing
///    certificate (Contents/Resources/update-signing.cer), SHA256SUMS.txt.sig must be that certificate's signature
///    over it, or nothing is installed;
///  - update.json (listed in SHA256SUMS.txt) says which version it is; only a newer one is installed;
///  - the new apps must be the same apps (bundle ids), that version, and, when this app is signed with a
///    certificate, signed with the same one: that's also what lets macOS keep Screen Recording and Accessibility.
public final class Updater: @unchecked Sendable {
    public static let didChange = Notification.Name("HeadroomUpdaterDidChange")
    public static let shared = Updater(config: .forMainBundle())

    public enum Phase: String, Sendable { case idle, checking, downloading, ready, current, failed }

    public struct State: Sendable {
        public var phase: Phase = .idle
        public var current: String
        public var available: String?
        public var progress: Double = 0
        public var message: String?
        public var checkedAt: Date?
        /// For the web pages (the Server window, the Viewer's home screen).
        public var json: [String: Any] {
            var d: [String: Any] = ["cmd": "update", "phase": phase.rawValue, "current": current, "progress": progress]
            if let available { d["version"] = available }
            if let message { d["message"] = message }
            if let checkedAt { d["checkedAt"] = ISO8601DateFormatter().string(from: checkedAt) }
            return d
        }
    }

    public struct Config {
        /// Where the release's files are: https://github.com/<repo>/releases/latest/download/
        public var base: URL
        public var current: String
        /// This app, where it's installed (the update replaces it there).
        public var appURL: URL
        /// Headroom's signing certificate (DER), when this build has it.
        public var certificate: Data?
        public var cacheDir: URL

        public init(base: URL, current: String, appURL: URL, certificate: Data?, cacheDir: URL) {
            self.base = base
            self.current = current
            self.appURL = appURL
            self.certificate = certificate
            self.cacheDir = cacheDir
        }

        public static func forMainBundle() -> Config {
            let b = Bundle.main
            let repo = b.object(forInfoDictionaryKey: "HeadroomUpdateRepo") as? String ?? "jamescolasacco/headroom"
            var base = URL(string: "https://github.com/\(repo)/releases/latest/download/")!
            #if DEBUG
            if let s = ProcessInfo.processInfo.environment["HEADROOM_UPDATE_BASE"], let u = URL(string: s) { base = u } // tests
            #endif
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            return Config(
                base: base,
                current: b.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
                appURL: b.bundleURL,
                certificate: b.url(forResource: "update-signing", withExtension: "cer").flatMap { try? Data(contentsOf: $0) },
                cacheDir: caches.appendingPathComponent(b.bundleIdentifier ?? "app.headroom", isDirectory: true).appendingPathComponent("Updates", isDirectory: true))
        }
    }

    /// The two apps an update can replace, side by side in one folder.
    public static let apps = [(name: "Headroom Server.app", id: "app.headroom.server"), (name: "Headroom Viewer.app", id: "app.headroom.viewer")]

    public private(set) var state: State
    public let config: Config
    private let session: URLSession
    private var timer: Timer?
    private var busy = false
    private let lock = NSLock()

    public init(config: Config) {
        self.config = config
        state = State(current: config.current)
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        c.timeoutIntervalForResource = 15 * 60
        c.httpAdditionalHeaders = ["User-Agent": "Headroom-Updater/\(config.current)"]
        session = URLSession(configuration: c)
    }

    /// Checks a little after launch, then every 6 hours. Old downloads are tidied away first.
    public func start(firstCheckAfter: TimeInterval = 20, every: TimeInterval = 6 * 3600) {
        cleanUp()
        DispatchQueue.main.async {
            self.timer?.invalidate()
            DispatchQueue.main.asyncAfter(deadline: .now() + firstCheckAfter) { [weak self] in self?.check() }
            let t = Timer(timeInterval: every, repeats: true) { [weak self] _ in self?.check() }
            RunLoop.main.add(t, forMode: .common)
            self.timer = t
        }
    }

    /// Looks for a newer release and, when there is one, downloads and checks it (nothing is installed yet).
    public func check(userInitiated: Bool = false) {
        guard claim() else { if userInitiated { emit() }; return }
        update { $0.phase = .checking; $0.message = nil }
        Task {
            do { try await self.run() } catch {
                self.update { $0.phase = .failed; $0.message = Self.describe(error); $0.checkedAt = Date() }
            }
            self.release()
        }
    }

    /// One check at a time, and none once an update is waiting to be installed.
    private func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if busy || state.phase == .ready { return false }
        busy = true
        return true
    }

    private func release() {
        lock.lock()
        busy = false
        lock.unlock()
    }

    /// Hands the downloaded update to its installer, which waits for the apps to quit, replaces them and opens them
    /// again. The caller quits right after this returns.
    public func install() throws {
        guard state.phase == .ready, let version = state.available else { throw UpdateError.notReady }
        let stage = config.cacheDir.appendingPathComponent(version).appendingPathComponent("x/Headroom")
        let script = stage.appendingPathComponent("install.sh")
        guard FileManager.default.fileExists(atPath: script.path) else { throw UpdateError.notReady }
        // Checked again now: the download waited in this user's folder since it was checked.
        try validate(stage.deletingLastPathComponent(), version: version)
        let installed = installedApps()
        var args = [script.path]
        if installed.count == 1 { args += ["--only", installed[0].id == "app.headroom.server" ? "server" : "viewer"] }
        // Open again what's open now from this folder (this app included): nothing more, nothing less.
        let dir = config.appURL.deletingLastPathComponent()
        let running = Set(NSWorkspace.shared.runningApplications.compactMap { $0.bundleURL?.standardizedFileURL.path })
        let reopen = { (name: String) in running.contains(dir.appendingPathComponent(name).standardizedFileURL.path) }
        if !reopen("Headroom Server.app") { args.append("--no-launch") }
        if installed.contains(where: { $0.id == "app.headroom.viewer" }) && reopen("Headroom Viewer.app") { args.append("--relaunch-viewer") }

        let log = config.cacheDir.appendingPathComponent("install.log")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        // In the background, detached from this app (which is about to quit), with its output in the log.
        p.arguments = ["-c", "nohup /bin/bash \"$@\" > \"$HEADROOM_UPDATE_LOG\" 2>&1 &", "sh"] + args
        var env = ProcessInfo.processInfo.environment
        env["HEADROOM_INSTALL_DIR"] = config.appURL.deletingLastPathComponent().path
        env["HEADROOM_UPDATE_LOG"] = log.path
        env["HEADROOM_INSTALL_WAIT"] = "1" // give this app a moment to quit by itself first
        p.environment = env
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { throw UpdateError.installer }
    }

    // ------------------------------------------------------------------ the check

    private func run() async throws {
        let sumsData = try await fetch("SHA256SUMS.txt")
        if let cert = config.certificate {
            let sig: Data
            do { sig = try await fetch("SHA256SUMS.txt.sig") } catch UpdateError.http(_, 404) { throw UpdateError.unsigned }
            guard Self.verify(sumsData, signature: sig, certificate: cert) else { throw UpdateError.badSignature }
        }
        let sums = Self.parseSums(String(decoding: sumsData, as: UTF8.self))
        let manifestData = try await fetch("update.json")
        guard sums["update.json"] == Self.sha256(manifestData) else { throw UpdateError.mismatch("update.json") }
        guard let manifest = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              let version = manifest["version"] as? String, !version.isEmpty else { throw UpdateError.badPackage }
        guard Self.isNewer(version, than: config.current) else {
            update { $0.phase = .current; $0.available = nil; $0.checkedAt = Date() }
            return
        }
        let asset = manifest["mac"] as? String ?? "Headroom-macOS.zip"
        guard let expected = sums[asset] else { throw UpdateError.mismatch(asset) }

        let dir = config.cacheDir.appendingPathComponent(version, isDirectory: true)
        let stage = dir.appendingPathComponent("x", isDirectory: true)
        let fm = FileManager.default
        if fm.fileExists(atPath: dir.appendingPathComponent("ready").path), (try? validate(stage, version: version)) != nil {
            update { $0.phase = .ready; $0.available = version; $0.progress = 1; $0.checkedAt = Date() }
            return
        }
        try? fm.removeItem(at: dir)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        update { $0.phase = .downloading; $0.available = version; $0.progress = 0 }
        let zip = dir.appendingPathComponent(asset)
        var last = 0.0
        try await Downloader(session: session).download(config.base.appendingPathComponent(asset), to: zip) { p in
            guard p - last >= 0.02 || p >= 1 else { return }
            last = p
            self.update { $0.progress = p }
        }
        guard try Self.sha256(file: zip) == expected else { throw UpdateError.mismatch(asset) }
        try Self.exec("/usr/bin/ditto", ["-x", "-k", zip.path, stage.path])
        try validate(stage, version: version)
        try? fm.removeItem(at: zip)
        try Data().write(to: dir.appendingPathComponent("ready"))
        update { $0.phase = .ready; $0.progress = 1; $0.checkedAt = Date() }
    }

    /// The unzipped release holds the apps installed here, at that version, signed like this app.
    private func validate(_ stage: URL, version: String) throws {
        let root = stage.appendingPathComponent("Headroom")
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("install.sh").path) else { throw UpdateError.badPackage }
        let signer = Self.signingRoot(of: config.appURL)
        for app in installedApps() {
            let staged = root.appendingPathComponent(app.name)
            guard let info = Self.bundleInfo(staged), info.id == app.id, info.version == version else { throw UpdateError.badPackage }
            if let signer, !Self.satisfies(staged, identifier: app.id, root: signer) { throw UpdateError.otherSigner }
        }
    }

    /// The Headroom apps in this app's folder (this one always).
    public func installedApps() -> [(name: String, id: String)] {
        let dir = config.appURL.deletingLastPathComponent()
        let me = Self.bundleInfo(config.appURL)?.id
        return Self.apps.filter { app in
            app.id == me || Self.bundleInfo(dir.appendingPathComponent(app.name))?.id == app.id
        }
    }

    /// Downloads of versions that are installed now (or older) are no longer needed.
    private func cleanUp() {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(atPath: config.cacheDir.path) else { return }
        for v in items where !Self.isNewer(v, than: config.current) && v.first?.isNumber == true {
            try? fm.removeItem(at: config.cacheDir.appendingPathComponent(v))
        }
    }

    private func fetch(_ name: String) async throws -> Data {
        let req = URLRequest(url: config.base.appendingPathComponent(name), cachePolicy: .reloadIgnoringLocalCacheData)
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw UpdateError.http(name, code) }
        return data
    }

    private func update(_ change: (inout State) -> Void) {
        lock.lock()
        change(&state)
        lock.unlock()
        emit()
    }

    private func emit() {
        let s = state
        DispatchQueue.main.async { NotificationCenter.default.post(name: Self.didChange, object: self, userInfo: ["state": s]) }
    }

    // ------------------------------------------------------------------ checks (public for the test harness)

    /// RSA PKCS#1 v1.5 with SHA-256, the signature `openssl dgst -sha256 -sign` makes.
    public static func verify(_ data: Data, signature: Data, certificate der: Data) -> Bool {
        guard let cert = SecCertificateCreateWithData(nil, der as CFData), let key = SecCertificateCopyKey(cert) else { return false }
        return SecKeyVerifySignature(key, .rsaSignatureMessagePKCS1v15SHA256, data as CFData, signature as CFData, nil)
    }

    /// `sha256sum` output: "<64 hex>  <name>" (a "*" before the name in binary mode).
    public static func parseSums(_ text: String) -> [String: String] {
        var out = [String: String]()
        for line in text.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
            guard parts.count == 2, parts[0].count == 64 else { continue }
            var name = parts[1].trimmingCharacters(in: .whitespaces)
            if name.hasPrefix("*") { name.removeFirst() }
            out[name] = parts[0].lowercased()
        }
        return out
    }

    public static func isNewer(_ a: String, than b: String) -> Bool {
        let parse = { (v: String) in v.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 } }
        let pa = parse(a), pb = parse(b)
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    public static func sha256(_ data: Data) -> String { hex(SHA256.hash(data: data)) }

    public static func sha256(file: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: file)
        defer { try? h.close() }
        var hasher = SHA256()
        while let chunk = try h.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hex(hasher.finalize())
    }

    public static func bundleInfo(_ app: URL) -> (id: String, version: String)? {
        guard let d = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
              let id = d["CFBundleIdentifier"] as? String, let v = d["CFBundleShortVersionString"] as? String else { return nil }
        return (id, v)
    }

    /// SHA-1 of the root of the certificate chain `app` is signed with; nil when it's ad-hoc (no certificate).
    public static func signingRoot(of app: URL) -> String? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let d = info as? [String: Any], let certs = d[kSecCodeInfoCertificates as String] as? [SecCertificate],
              let root = certs.last else { return nil }
        return hex(Insecure.SHA1.hash(data: SecCertificateCopyData(root) as Data))
    }

    /// `app` is validly signed (all architectures, nested code too) as `identifier`, by the certificate `root`.
    public static func satisfies(_ app: URL, identifier: String, root: String) -> Bool {
        var code: SecStaticCode?
        var req: SecRequirement?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString("identifier \"\(identifier)\" and certificate root = H\"\(root)\"" as CFString, [], &req) == errSecSuccess,
              let req else { return false }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
        return SecStaticCodeCheckValidity(code, flags, req) == errSecSuccess
    }

    private static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func exec(_ tool: String, _ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { throw UpdateError.badPackage }
    }

    static func describe(_ e: Error) -> String {
        switch e {
        case let u as UpdateError: return u.description
        case let u as URLError where [.notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .timedOut, .cannotConnectToHost].contains(u.code):
            return "Couldn't reach GitHub to check for updates."
        default: return "Couldn't check for updates (\(e.localizedDescription))."
        }
    }
}

public enum UpdateError: Error, CustomStringConvertible {
    case http(String, Int), unsigned, badSignature, mismatch(String), badPackage, otherSigner, notReady, installer
    public var description: String {
        switch self {
        case .http(let f, let c): return c == 404 ? "The latest release has no \(f)." : "GitHub answered \(c) for \(f)."
        case .unsigned: return "The latest release isn't signed, so it wasn't installed."
        case .badSignature: return "The latest release's signature doesn't match Headroom's certificate, so it wasn't installed."
        case .mismatch(let f): return "\(f) didn't match its checksum, so it wasn't installed."
        case .badPackage: return "The download isn't a Headroom release for this Mac."
        case .otherSigner: return "The new version isn't signed with Headroom's certificate, so it wasn't installed."
        case .notReady: return "There's no downloaded update to install."
        case .installer: return "The installer didn't start."
        }
    }
}

/// One file to disk, with progress.
private final class Downloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let base: URLSession
    private var session: URLSession!
    private var continuation: CheckedContinuation<Void, Error>?
    private var dest: URL!
    private var progress: ((Double) -> Void)?

    init(session: URLSession) { base = session }

    func download(_ url: URL, to dest: URL, progress: @escaping (Double) -> Void) async throws {
        self.dest = dest
        self.progress = progress
        session = URLSession(configuration: base.configuration, delegate: self, delegateQueue: nil)
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            continuation = c
            session.downloadTask(with: url).resume()
        }
    }

    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten done: Int64, totalBytesExpectedToWrite total: Int64) {
        if total > 0 { progress?(Double(done) / Double(total)) }
    }

    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { finish(UpdateError.http(dest.lastPathComponent, code)); return }
        do {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: location, to: dest) // the temporary file is gone after this call
            finish(nil)
        } catch { finish(error) }
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(error) }
    }

    private func finish(_ error: Error?) {
        guard let c = continuation else { return }
        continuation = nil
        if let error { c.resume(throwing: error) } else { c.resume() }
        session.finishTasksAndInvalidate()
    }
}
