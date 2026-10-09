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
        guard ConfigStore.current.permissions.fileTransfer else { return .status(.forbidden) }
        guard let (path, deviceId) = AuthService.redeemEphemeral(req.query["t"], purpose: "download") else {
            return .json(["error": "link expired"], status: .unauthorized)
        }
        // The device may have been made view-only (or input turned off) since the link was minted.
        guard let status = AuthService.deviceStatus(deviceId), !status.viewOnly else {
            return .json(["error": "view-only device"], status: .forbidden)
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

    /// Uploads stream straight to "<name>.headroom-part", renamed when complete.
    final class UploadSink: HttpBodySink {
        let final: String
        let temp: String
        let handle: FileHandle
        let remote: String?

        init(dir: String, name: String, remote: String?) throws {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            final = FileApi.uniquePath((dir as NSString).appendingPathComponent(name))
            temp = final + ".headroom-part"
            guard FileManager.default.createFile(atPath: temp, contents: nil), let h = FileHandle(forWritingAtPath: temp) else {
                throw CocoaError(.fileWriteNoPermission)
            }
            handle = h
            self.remote = remote
        }

        func write(_ bytes: [UInt8]) throws { try handle.write(contentsOf: bytes) }

        func finish() -> HttpResponse {
            try? handle.close()
            do {
                try FileManager.default.moveItem(atPath: temp, toPath: final)
            } catch {
                try? FileManager.default.removeItem(atPath: temp)
                return .json(["error": "could not save: \(error.localizedDescription)"], status: .internalServerError)
            }
            let size = (try? FileManager.default.attributesOfItem(atPath: final)[.size] as? NSNumber)?.intValue ?? 0
            Log.info("files", "upload \(final) (\(size) bytes) from \(remote ?? "?")")
            return .json(["path": final, "name": (final as NSString).lastPathComponent])
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
        guard ConfigStore.current.permissions.fileTransfer else { return .json(["error": "file transfer disabled on host"], status: .forbidden) }
        guard let dev = AuthService.validateToken(req.bearerToken, ip: req.remoteIP, touch: false) else { return .json(["error": "unauthorized"], status: .unauthorized) }
        if dev.viewOnly { return .json(["error": "view-only device"], status: .forbidden) }
        return nil
    }

    static func sanitizeName(_ name: String?) -> String? {
        guard var n = name?.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) else { return nil }
        n = n.replacingOccurrences(of: ":", with: "_").replacingOccurrences(of: "\0", with: "_").trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty || n == "." || n == ".." ? nil : n
    }

    static func uniquePath(_ path: String) -> String {
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) { return path }
        let dir = (path as NSString).deletingLastPathComponent
        let ext = (path as NSString).pathExtension
        let stem = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        var i = 1
        while true {
            let p = (dir as NSString).appendingPathComponent(ext.isEmpty ? "\(stem) (\(i))" : "\(stem) (\(i)).\(ext)")
            if !fm.fileExists(atPath: p) { return p }
            i += 1
        }
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
