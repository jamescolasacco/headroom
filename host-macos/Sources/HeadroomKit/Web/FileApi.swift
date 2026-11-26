import Darwin
import Foundation
import NIOHTTP1

/// File transfer over plain HTTPS (separate TCP connection, so big transfers never stall the video
/// socket). Browse/upload use the device bearer token; downloads use a short-lived URL token minted over
/// the session socket, because browsers open download links themselves (no custom headers).
enum FileApi {
    static func list(_ req: HttpRequest) -> HttpResponse {
        if let err = denied(req) { return err }
        let path = req.query["path"] ?? ""
        if path.trimmingCharacters(in: .whitespaces).isEmpty {
            return .json(["path": "", "parent": NSNull(), "entries": roots()])
        }
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else {
            return .json(["error": "not found"], status: .notFound)
        }
        let url = URL(fileURLWithPath: path).standardizedFileURL
        let keys: [URLResourceKey] = [.isDirectoryKey, .isHiddenKey, .fileSizeKey, .contentModificationDateKey, .isPackageKey]
        let items: [URL]
        do {
            items = try fm.contentsOfDirectory(at: url, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])
        } catch {
            let ns = error as NSError
            if ns.code == NSFileReadNoPermissionError || ns.domain == NSPOSIXErrorDomain && ns.code == Int(EPERM) {
                return .json(["error": "access denied (macOS may need to allow Headroom to access this folder)"], status: .forbidden)
            }
            return .json(["error": ns.localizedDescription], status: .forbidden)
        }
        var dirs = [JSONObject](), files = [JSONObject]()
        for item in items {
            guard let rv = try? item.resourceValues(forKeys: Set(keys)), rv.isHidden != true else { continue }
            let modified = rv.contentModificationDate ?? Date(timeIntervalSince1970: 0)
            if rv.isDirectory == true {
                dirs.append(["name": item.lastPathComponent, "path": item.path, "dir": true, "size": 0, "modified": modified])
            } else {
                files.append(["name": item.lastPathComponent, "path": item.path, "dir": false, "size": rv.fileSize ?? 0, "modified": modified])
            }
        }
        let byName: (JSONObject, JSONObject) -> Bool = {
            ($0.str("name") ?? "").localizedStandardCompare($1.str("name") ?? "") == .orderedAscending
        }
        let parent = url.path == "/" ? "" : url.deletingLastPathComponent().path
        return .json(["path": url.path, "parent": parent, "entries": dirs.sorted(by: byName) + files.sorted(by: byName)])
    }

    static func download(_ req: HttpRequest) -> HttpResponse {
        guard let (path, deviceId) = AuthService.redeemEphemeral(req.query["t"], purpose: "download") else {
            return .json(["error": "link expired"], status: .unauthorized)
        }
        // File transfer may have been turned off for this session since the link was made.
        guard AuthService.allowed(deviceId)?.files == true else {
            return .json(["error": "file transfer isn't allowed"], status: .forbidden)
        }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue,
              let fh = FileHandle(forReadingAtPath: path) else { return .status(.notFound) }
        let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.uint64Value ?? 0
        Log.info("files", "download \(path) -> \(req.remoteIP ?? "?")")
        var h = HTTPHeaders()
        h.add(name: "Content-Type", value: "application/octet-stream")
        h.add(name: "Accept-Ranges", value: "bytes")
        let name = (path as NSString).lastPathComponent
        let ascii = name.unicodeScalars.map { $0.isASCII && $0.value >= 0x20 && $0 != "\"" && $0 != "\\" ? String($0) : "_" }.joined()
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ascii
        h.add(name: "Content-Disposition", value: "attachment; filename=\"\(ascii)\"; filename*=UTF-8''\(encoded)")
        if let range = req.headers.first(name: "range"), let (start, end) = parseRange(range, size: size) {
            h.add(name: "Content-Range", value: "bytes \(start)-\(end)/\(size)")
            return HttpResponse(status: .partialContent, headers: h, body: .file(fh, offset: start, length: end - start + 1))
        }
        return HttpResponse(status: .ok, headers: h, body: .file(fh, offset: 0, length: size))
    }

    /// Single "bytes=a-b" / "bytes=a-" / "bytes=-n" range.
    static func parseRange(_ header: String, size: UInt64) -> (UInt64, UInt64)? {
        guard size > 0, header.hasPrefix("bytes="), !header.contains(",") else { return nil }
        let spec = header.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard spec.count == 2 else { return nil }
        if spec[0].isEmpty {
            guard let n = UInt64(spec[1]), n > 0 else { return nil }
            return (size - min(n, size), size - 1)
        }
        guard let a = UInt64(spec[0]), a < size else { return nil }
        let b = spec[1].isEmpty ? size - 1 : min(UInt64(spec[1]) ?? (size - 1), size - 1)
        return a <= b ? (a, b) : nil
    }

    /// Each request owns its staging file until it publishes the completed upload.
    final class UploadSink: HttpBodySink {
        let dir: String
        let name: String
        let temp: String
        let handle: FileHandle
        let remote: String?
        /// Whose upload it is: it's kept only if they may still transfer files (not turned off, guest not stopped).
        let deviceId: String?
        private var checkedAt = Date.distantPast
        private var refused = false
        /// The mode a new file gets here (0666 less the umask: 0644 usually), as uploads had before staging: mkstemp
        /// makes its file owner-only, and the rename keeps that, so a file sent to a shared folder was unreadable to others.
        static let fileMode: mode_t = { let m = umask(0o022); umask(m); return 0o666 & ~m }()

        init(dir: String, name: String, remote: String?, deviceId: String? = nil) throws {
            self.dir = dir
            self.name = name
            self.remote = remote
            self.deviceId = deviceId
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            var template = Array((dir as NSString).appendingPathComponent(".headroom-upload-XXXXXX").utf8CString)
            let fd = mkstemp(&template)
            guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            fchmod(fd, Self.fileMode)
            temp = String(cString: template)
            handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        }

        /// File transfer was turned off for this session, or the guest stopped, since the upload began.
        private var revoked: Bool {
            if !refused, let deviceId, Date().timeIntervalSince(checkedAt) >= 0.25 {
                checkedAt = Date()
                refused = AuthService.allowed(deviceId)?.files != true
            }
            return refused
        }

        func write(_ bytes: [UInt8]) throws {
            if revoked { return } // the rest isn't written; finish() refuses it
            try handle.write(contentsOf: bytes)
        }

        /// Some external volumes do not implement RENAME_EXCL. Reserve an unused name there before replacing it.
        static func moveWithReservation(_ source: String, to destination: String) -> Int32 {
            let fd = open(destination, O_CREAT | O_EXCL | O_WRONLY, 0o600)
            guard fd >= 0 else { return errno }
            defer { close(fd) }
            if rename(source, destination) == 0 { return 0 }
            let failure = errno
            unlink(destination)
            // The name was free (reserved just now): a volume that won't rename over the reservation isn't "name taken",
            // or finish() would try the next name forever.
            return failure == EEXIST ? EIO : failure
        }

        func finish() -> HttpResponse {
            let fm = FileManager.default
            let ext = (name as NSString).pathExtension
            let stem = (name as NSString).deletingPathExtension
            checkedAt = .distantPast
            if revoked {
                abort()
                Log.info("files", "upload of \(name) from \(remote ?? "?") dropped: file transfer was turned off")
                return .json(["error": "file transfer isn't allowed"], status: .forbidden)
            }
            do {
                try handle.close()
                var i = 0
                while true {
                    let candidate = i == 0 ? name : "\(stem) (\(i))" + (ext.isEmpty ? "" : ".\(ext)")
                    let final = (dir as NSString).appendingPathComponent(candidate)
                    var failure: Int32 = 0
                    if renamex_np(temp, final, UInt32(RENAME_EXCL)) != 0 {
                        failure = errno
                        if failure == ENOTSUP { failure = Self.moveWithReservation(temp, to: final) }
                    }
                    if failure == EEXIST && i < 10_000 {
                        i += 1
                        continue
                    }
                    if failure != 0 { throw NSError(domain: NSPOSIXErrorDomain, code: Int(failure)) }
                    Log.info("files", "upload \(final) from \(remote ?? "?")")
                    return .json(["path": final, "name": candidate])
                }
            } catch {
                try? fm.removeItem(atPath: temp)
                return .json(["error": "could not save: \(error.localizedDescription)"], status: .internalServerError)
            }
        }

        func abort() {
            try? handle.close()
            try? FileManager.default.removeItem(atPath: temp)
        }
    }

    static func beginUpload(_ req: HttpRequest) -> HttpStreamDecision {
        let device: PairedDevice
        switch authorize(req) {
        case .failure(let err): return .respond(err.response)
        case .success(let dev): device = dev
        }
        let dirParam = req.query["dir"] ?? ""
        let dir = dirParam.trimmingCharacters(in: .whitespaces).isEmpty ? defaultUploadDir : dirParam
        guard let name = sanitizeName(req.query["name"]) else { return .respond(.json(["error": "bad target"], status: .badRequest)) }
        do {
            return .stream(try UploadSink(dir: dir, name: name, remote: req.remoteIP, deviceId: device.id))
        } catch {
            return .respond(.json(["error": "can't write there: \(error.localizedDescription)"], status: .forbidden))
        }
    }

    static func mkdir(_ req: HttpRequest) -> HttpResponse {
        if let err = denied(req) { return err }
        let body = req.json
        guard let parent = body.str("parent"), let name = sanitizeName(body.str("name")) else {
            return .json(["error": "bad name"], status: .badRequest)
        }
        let p = (parent as NSString).appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
        } catch {
            return .json(["error": error.localizedDescription], status: .forbidden)
        }
        return .json(["path": p])
    }

    struct Refusal: Error { let response: HttpResponse }

    /// Who's asking, if they may transfer files now.
    private static func authorize(_ req: HttpRequest) -> Result<PairedDevice, Refusal> {
        guard let dev = AuthService.validateToken(req.bearerToken, ip: req.remoteIP, touch: false) else {
            return .failure(Refusal(response: .json(["error": "unauthorized"], status: .unauthorized)))
        }
        guard AuthService.allowed(dev.id)?.files == true else {
            return .failure(Refusal(response: .json(["error": "file transfer isn't allowed"], status: .forbidden)))
        }
        return .success(dev)
    }

    private static func denied(_ req: HttpRequest) -> HttpResponse? {
        if case .failure(let err) = authorize(req) { return err.response }
        return nil
    }

    static func sanitizeName(_ name: String?) -> String? {
        guard var n = name?.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) else { return nil }
        n = n.replacingOccurrences(of: ":", with: "_").replacingOccurrences(of: "\0", with: "_").trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty || n == "." || n == ".." ? nil : n
    }

    /// Tests only (HEADROOM_TEST_HOME=<dir>, with the test pattern): the folders offered and the default upload folder
    /// are <dir> and its Desktop, Documents and Downloads, so a test engine never writes to this Mac user's folders.
    static let testHome: String? = {
        guard Displays.testPatternSize != nil, let dir = ProcessInfo.processInfo.environment["HEADROOM_TEST_HOME"], !dir.isEmpty else { return nil }
        Log.warn("files", "TEST: files go to \(dir), not this Mac user's folders")
        return URL(fileURLWithPath: dir).standardizedFileURL.path
    }()

    private static func userFolder(_ dir: FileManager.SearchPathDirectory) -> String? {
        if let home = testHome {
            let name = [FileManager.SearchPathDirectory.desktopDirectory: "Desktop", .documentDirectory: "Documents", .downloadsDirectory: "Downloads"][dir]
            return name.map { (home as NSString).appendingPathComponent($0) }
        }
        return FileManager.default.urls(for: dir, in: .userDomainMask).first?.path
    }

    static var defaultUploadDir: String {
        userFolder(.downloadsDirectory) ?? testHome ?? NSHomeDirectory()
    }

    private static func roots() -> [JSONObject] {
        var roots = [JSONObject]()
        let fm = FileManager.default
        func add(_ label: String, _ dir: FileManager.SearchPathDirectory) {
            if let path = userFolder(dir), fm.fileExists(atPath: path) {
                roots.append(["name": label, "path": path, "dir": true, "size": 0, "modified": NSNull()])
            }
        }
        add("Desktop", .desktopDirectory)
        add("Documents", .documentDirectory)
        add("Downloads", .downloadsDirectory)
        roots.append(["name": "Home", "path": testHome ?? NSHomeDirectory(), "dir": true, "size": 0, "modified": NSNull()])
        // Mounted volumes: the startup disk first, then external and network volumes.
        let vols = fm.mountedVolumeURLs(includingResourceValuesForKeys: [.volumeLocalizedNameKey, .volumeIsBrowsableKey], options: [.skipHiddenVolumes]) ?? []
        for v in vols {
            guard let rv = try? v.resourceValues(forKeys: [.volumeLocalizedNameKey, .volumeIsBrowsableKey]), rv.volumeIsBrowsable != false else { continue }
            let name = rv.volumeLocalizedName ?? v.lastPathComponent
            roots.append(["name": v.path == "/" ? "\(name) (startup disk)" : name, "path": v.path, "dir": true, "size": 0, "modified": NSNull()])
        }
        return roots
    }
}
