// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SLABDSP",
    platforms: [.macOS("14.2")],
    targets: [
        // The deck: memory, jumps and realignment. Plain Swift, so it can be tested on its own.
        .target(
            name: "SLABCore",
            path: "Sources/SLABCore"
        ),
        .executableTarget(
            name: "SLABDSP",
            dependencies: ["SLABCore"],
            path: "Sources/SLABDSP",
            linkerSettings: [
                .linkedFramework("CoreAudio"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Network"),
                .linkedFramework("AppKit"),
                .linkedFramework("ServiceManagement"),
            ]
        ),
        .testTarget(
            name: "SLABCoreTests",
            dependencies: ["SLABCore"],
            path: "Tests/SLABCoreTests"
        ),
    ]
)
