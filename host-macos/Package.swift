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
        .package(path: "../update-macos"),
    ],
    targets: [
        // The engine: HTTPS/WSS server, pairing, capture, encode, input, clipboard, audio, files.
        .target(
            name: "HeadroomKit",
            dependencies: [
                "COpus",
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
                .product(name: "NIOWebSocket", package: "swift-nio"),
                .product(name: "NIOSSL", package: "swift-nio-ssl"),
                .product(name: "X509", package: "swift-certificates"),
                .product(name: "SwiftASN1", package: "swift-asn1"),
            ]
        ),
        // libopus 1.6.1 (BSD-3-Clause; Sources/COpus/libopus/SOURCE.txt), the sound's Opus encoder: floating point,
        // portable C only (no CPU-specific code, no deep-learning parts), so it builds for arm64 and x86_64 alike.
        .target(
            name: "COpus",
            path: "Sources/COpus",
            exclude: ["libopus/COPYING", "libopus/AUTHORS", "libopus/SOURCE.txt"],
            cSettings: [
                .headerSearchPath("libopus/include"),
                .headerSearchPath("libopus/celt"),
                .headerSearchPath("libopus/silk"),
                .headerSearchPath("libopus/silk/float"),
                .headerSearchPath("libopus/src"),
                .define("OPUS_BUILD"),
                .define("VAR_ARRAYS"),
                .define("HAVE_LRINT"),
                .define("HAVE_LRINTF"),
                .define("PACKAGE_VERSION", to: "\"1.6.1\""),
            ]
        ),
        .testTarget(name: "HeadroomKitTests", dependencies: ["HeadroomKit", "COpus"]),
        .executableTarget(name: "headroom", dependencies: ["HeadroomKit"]),
        .testTarget(name: "HeadroomServerTests", dependencies: ["HeadroomServer"]),
        // Menu-bar app: status item, notifications, settings window (the engine's admin page in a WKWebView),
        // and updates (../update-macos).
        .executableTarget(name: "HeadroomServer", dependencies: [.product(name: "HeadroomUpdate", package: "update-macos")]),
    ]
)
