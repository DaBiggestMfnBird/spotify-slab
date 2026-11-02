// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SLABDSP",
    platforms: [.macOS("14.2")],
    targets: [
        .executableTarget(
            name: "SLABDSP",
            path: "Sources/SLABDSP",
            linkerSettings: [
                .linkedFramework("CoreAudio"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Network"),
                .linkedFramework("AppKit"),
                .linkedFramework("ServiceManagement"),
            ]
        )
    ]
)
