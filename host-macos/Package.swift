// swift-tools-version:5.10
// Headroom for macOS — the host engine/CLI (`headroom`) and the menu-bar app (`HeadroomServer`).
// Build: tools/build-macos.sh (assembles dist/Headroom Server.app). Development: `swift run headroom run`.
import PackageDescription

let package = Package(
    name: "Headroom",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "headroom", targets: ["headroom"]),
        .executable(name: "HeadroomServer", targets: ["HeadroomServer"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.80.0"),
        .package(url: "https://github.com/apple/swift-nio-ssl.git", from: "2.30.0"),
        .package(url: "https://github.com/apple/swift-certificates.git", from: "1.10.0"),
        .package(url: "https://github.com/apple/swift-asn1.git", from: "1.3.0"),
    ],
    targets: [
        // The engine: HTTPS/WSS server, pairing, capture, encode, input, clipboard, audio, files.
        .target(
            name: "HeadroomKit",
            dependencies: [
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
                .product(name: "NIOWebSocket", package: "swift-nio"),
                .product(name: "NIOSSL", package: "swift-nio-ssl"),
                .product(name: "X509", package: "swift-certificates"),
                .product(name: "SwiftASN1", package: "swift-asn1"),
            ]
        ),
        .executableTarget(name: "headroom", dependencies: ["HeadroomKit"]),
        // Menu-bar app: status item, notifications, settings window (the engine's admin page in a WKWebView).
        .executableTarget(name: "HeadroomServer"),
    ]
)
