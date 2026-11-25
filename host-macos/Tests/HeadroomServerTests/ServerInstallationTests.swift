import Foundation
import XCTest
@testable import HeadroomServer

final class ServerInstallationTests: XCTestCase {
    func testLooseCopyOpensInstalledServerEvenWhenNobodyIsRunning() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let apps = root.appendingPathComponent("Applications", isDirectory: true)
        let loose = root.appendingPathComponent("Documents/project/dist/Headroom Server.app", isDirectory: true)
        let installed = apps.appendingPathComponent("Headroom Server.app", isDirectory: true)
        XCTAssertNil(ServerInstallation.preferredURL(for: loose, in: [apps]))
        let contents = installed.appendingPathComponent("Contents", isDirectory: true)
        let macos = contents.appendingPathComponent("MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macos, withIntermediateDirectories: true)
        let info = ["CFBundleIdentifier": "app.headroom.server", "CFBundleExecutable": "HeadroomServer", "CFBundlePackageType": "APPL"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
        let exe = macos.appendingPathComponent("HeadroomServer")
        XCTAssertTrue(FileManager.default.createFile(atPath: exe.path, contents: Data(), attributes: [.posixPermissions: 0o755]))
        XCTAssertEqual(ServerInstallation.preferredURL(for: loose, in: [apps])?.path, installed.path)
        XCTAssertNil(ServerInstallation.preferredURL(for: installed, in: [apps]))
        let alias = root.appendingPathComponent("app-link")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: installed)
        XCTAssertNil(ServerInstallation.preferredURL(for: alias, in: [apps]))
    }

    func testUpdateRequiresOwnershipOfTheLiveEngine() {
        XCTAssertTrue(ServerInstallation.canUpdate(ownEngine: 421, servingEngine: 421))
        XCTAssertFalse(ServerInstallation.canUpdate(ownEngine: 421, servingEngine: 733))
        XCTAssertFalse(ServerInstallation.canUpdate(ownEngine: nil, servingEngine: 733))
        XCTAssertTrue(ServerInstallation.canUpdate(ownEngine: nil, servingEngine: nil))
    }
}
