import Foundation
import XCTest
@testable import HeadroomUpdate

final class InstalledApplicationTests: XCTestCase {
    func testPortableInstalledAndSymlinkedCopiesForBothApps() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        for product in InstalledApplication.allCases {
            let apps = root.appendingPathComponent("Applications", isDirectory: true)
            let name = product.rawValue + ".app"
            let loose = root.appendingPathComponent("Downloads/" + name, isDirectory: true)
            let installed = apps.appendingPathComponent(name, isDirectory: true)
            XCTAssertNil(product.preferredURL(for: loose, in: [apps]))
            let contents = installed.appendingPathComponent("Contents", isDirectory: true)
            let macos = contents.appendingPathComponent("MacOS", isDirectory: true)
            try FileManager.default.createDirectory(at: macos, withIntermediateDirectories: true)
            let info = ["CFBundleIdentifier": product.bundleID, "CFBundleExecutable": "fixture", "CFBundlePackageType": "APPL"]
            try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
                .write(to: contents.appendingPathComponent("Info.plist"))
            XCTAssertNil(product.preferredURL(for: loose, in: [apps]))
            XCTAssertTrue(FileManager.default.createFile(atPath: macos.appendingPathComponent("fixture").path,
                                                         contents: Data(), attributes: [.posixPermissions: 0o755]))
            XCTAssertEqual(product.preferredURL(for: loose, in: [apps])?.path, installed.path)
            XCTAssertNil(product.preferredURL(for: installed, in: [apps]))
            let alias = root.appendingPathComponent("link-" + name)
            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: installed)
            XCTAssertNil(product.preferredURL(for: alias, in: [apps]))
        }
    }
}
