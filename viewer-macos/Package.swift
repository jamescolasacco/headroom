// swift-tools-version:5.10
// Headroom Viewer for macOS — the web client in a WKWebView shell, with the native pieces a browser can't do:
// per-computer certificate pinning, system-shortcut capture (⌘Tab, ⌘Space…), WebCodecs audio, windows.
// Build: tools/build-macos.sh (assembles dist/Headroom Viewer.app).
import PackageDescription

let package = Package(
    name: "HeadroomViewer",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "HeadroomViewer", targets: ["HeadroomViewer"])],
    targets: [.executableTarget(name: "HeadroomViewer")]
)
