// swift-tools-version: 5.9
import PackageDescription

// The deck (memory, jumps and realignment) is plain Swift, so it builds and is tested on its own,
// on Windows as well as macOS: both helpers share it, and a fix to chops lands on both at once.
var targets: [Target] = [
    .target(
        name: "SLABCore",
        path: "Sources/SLABCore"
    ),
    .testTarget(
        name: "SLABCoreTests",
        dependencies: ["SLABCore"],
        path: "Tests/SLABCoreTests"
    ),
]

#if os(macOS)
// The macOS helper: a Core Audio process tap and an AVAudioEngine graph.
targets += [
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
    // The helper's own audio graph, rendered offline: the nodes it plays Spotify through, measured.
    .testTarget(
        name: "SLABDSPTests",
        dependencies: ["SLABDSP", "SLABCore"],
        path: "Tests/SLABDSPTests"
    ),
]
#endif

let package = Package(
    name: "SLABDSP",
    platforms: [.macOS("14.2")],
    targets: targets
)
