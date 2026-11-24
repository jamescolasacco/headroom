// swift-tools-version:5.10
// Headroom's updater for the Mac apps (Headroom Server and Headroom Viewer both use it). No dependencies.
//   HeadroomUpdate   the library: check the latest release, download and verify it, install it and relaunch
//   update-check     a test harness for it (debug builds can point it at a local "release" with HEADROOM_UPDATE_BASE)
import PackageDescription

let package = Package(
    name: "HeadroomUpdate",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "HeadroomUpdate", targets: ["HeadroomUpdate"]),
        .executable(name: "update-check", targets: ["update-check"]),
    ],
    targets: [
        .target(name: "HeadroomUpdate"),
        .testTarget(name: "HeadroomUpdateTests", dependencies: ["HeadroomUpdate"]),
        .executableTarget(name: "update-check", dependencies: ["HeadroomUpdate"]),
    ]
)
