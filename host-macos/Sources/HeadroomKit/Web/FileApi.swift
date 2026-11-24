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

        init(dir: String, name: String, remote: String?) throws {
            self.dir = dir
            self.name = name
            self.remote = remote
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            var template = Array((dir as NSString).appendingPathComponent(".headroom-upload-XXXXXX").utf8CString)
            let fd = mkstemp(&template)
            guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            temp = String(cString: template)
            handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        }

        func write(_ bytes: [UInt8]) throws { try handle.write(contentsOf: bytes) }

        func finish() -> HttpResponse {
            let fm = FileManager.default
            let ext = (name as NSString).pathExtension
            let stem = (name as NSString).deletingPathExtension
            do {
                try handle.close()
                var i = 0
                while true {
                    let candidate = i == 0 ? name : "\(stem) (\(i))" + (ext.isEmpty ? "" : ".\(ext)")
                    let final = (dir as NSString).appendingPathComponent(candidate)
                    do {
                        try fm.moveItem(atPath: temp, toPath: final)
                    } catch let error as CocoaError where error.code == .fileWriteFileExists {
                        i += 1
                        continue
                    }
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
        if let err = denied(req) { return .respond(err) }
        let dirParam = req.query["dir"] ?? ""
        let dir = dirParam.trimmingCharacters(in: .whitespaces).isEmpty ? defaultUploadDir : dirParam
        guard let name = sanitizeName(req.query["name"]) else { return .respond(.json(["error": "bad target"], status: .badRequest)) }
        do {
            return .stream(try UploadSink(dir: dir, name: name, remote: req.remoteIP))
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

    private static func denied(_ req: HttpRequest) -> HttpResponse? {
        guard let dev = AuthService.validateToken(req.bearerToken, ip: req.remoteIP, touch: false) else { return .json(["error": "unauthorized"], status: .unauthorized) }
        guard AuthService.allowed(dev.id)?.files == true else { return .json(["error": "file transfer isn't allowed"], status: .forbidden) }
        return nil
    }

    static func sanitizeName(_ name: String?) -> String? {
        guard var n = name?.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) else { return nil }
        n = n.replacingOccurrences(of: ":", with: "_").replacingOccurrences(of: "\0", with: "_").trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty || n == "." || n == ".." ? nil : n
    }

    static var defaultUploadDir: String {
        FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first?.path ?? NSHomeDirectory()
    }

    private static func roots() -> [JSONObject] {
        var roots = [JSONObject]()
        let fm = FileManager.default
        func add(_ label: String, _ dir: FileManager.SearchPathDirectory) {
            if let u = fm.urls(for: dir, in: .userDomainMask).first, fm.fileExists(atPath: u.path) {
                roots.append(["name": label, "path": u.path, "dir": true, "size": 0, "modified": NSNull()])
            }
        }
        add("Desktop", .desktopDirectory)
        add("Documents", .documentDirectory)
        add("Downloads", .downloadsDirectory)
        roots.append(["name": "Home", "path": NSHomeDirectory(), "dir": true, "size": 0, "modified": NSNull()])
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
