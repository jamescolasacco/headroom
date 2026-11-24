import Foundation
import XCTest
@testable import HeadroomUpdate

private final class ReleaseProtocol: URLProtocol {
    static var files: [String: Data] = [:]
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "release.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let data = Self.files[url.lastPathComponent]
        let response = HTTPURLResponse(url: url, statusCode: data == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if let data { client?.urlProtocol(self, didLoad: data) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class UpdaterTests: XCTestCase {
    func testReadyArchiveIsCheckedAgainAndCanRecoverWithoutRestarting() async throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? fm.removeItem(at: dir); ReleaseProtocol.files = [:] }
        let package = dir.appendingPathComponent("Headroom")
        let installed = dir.appendingPathComponent("installed/Headroom Viewer.app")
        let staged = package.appendingPathComponent("Headroom Viewer.app")
        for (app, version) in [(installed, "1"), (staged, "2")] {
            let contents = app.appendingPathComponent("Contents")
            try fm.createDirectory(at: contents, withIntermediateDirectories: true)
            let info = ["CFBundleIdentifier": "app.headroom.viewer", "CFBundleShortVersionString": version]
            try PropertyListEncoder().encode(info).write(to: contents.appendingPathComponent("Info.plist"))
        }
        // A harmless test installer records only the installation directory it was given.
        try Data("echo complete > \"$HEADROOM_INSTALL_DIR/result\"\n".utf8).write(to: package.appendingPathComponent("install.sh"))
        let cache = dir.appendingPathComponent("updates")
        let release = cache.appendingPathComponent("2")
        try fm.createDirectory(at: release, withIntermediateDirectories: true)
        let zip = release.appendingPathComponent("Headroom-macOS.zip")
        let ditto = Process()
        ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        ditto.arguments = ["-c", "-k", "--keepParent", package.path, zip.path]
        try ditto.run()
        ditto.waitUntilExit()
        XCTAssertEqual(ditto.terminationStatus, 0)
        let archive = try Data(contentsOf: zip)
        let manifest = Data(#"{"version":"2"}"#.utf8)
        let sums = "\(Updater.sha256(manifest))  update.json\n\(Updater.sha256(archive))  Headroom-macOS.zip\n"
        ReleaseProtocol.files = ["SHA256SUMS.txt": Data(sums.utf8), "update.json": manifest]
        let session = URLSessionConfiguration.ephemeral
        session.protocolClasses = [ReleaseProtocol.self]
        let updater = Updater(config: .init(base: URL(string: "https://release.test")!, current: "1", appURL: installed,
                                            certificate: nil, cacheDir: cache), sessionConfiguration: session)
        func waitForReady() async throws {
            updater.check()
            for _ in 0..<250 {
                if [.ready, .failed].contains(updater.state.phase) { break }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            XCTAssertEqual(updater.state.phase, .ready, updater.state.message ?? "")
        }
        try await waitForReady()
        try Data("incomplete".utf8).write(to: zip)
        XCTAssertThrowsError(try updater.install())
        XCTAssertEqual(updater.state.phase, .failed)
        let result = installed.deletingLastPathComponent().appendingPathComponent("result")
        XCTAssertFalse(fm.fileExists(atPath: result.path))
        try archive.write(to: zip)
        try await waitForReady()
        try updater.install()
        for _ in 0..<100 where !fm.fileExists(atPath: result.path) { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(try String(contentsOf: result), "complete\n")
    }
}
