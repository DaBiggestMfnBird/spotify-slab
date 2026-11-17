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
    // The sound after the deck in portable C++: pitch and tape speed (Signalsmith Stretch, vendored),
    // low-pass, room, echo, trim, and the joins at chops.
    .target(
        name: "SLABSound",
        path: "Sources/SLABSound",
        exclude: [
            "vendor/README.md",
            "vendor/LICENSE-signalsmith-stretch.txt",
            "vendor/signalsmith-linear/LICENSE.txt",
        ],
        cxxSettings: [.headerSearchPath("vendor")]
    ),
    // The deck, the tape's color and SLABSound as one engine: what the Windows helper plays through.
    .target(
        name: "SLABEngine",
        dependencies: ["SLABCore", "SLABSound"],
        path: "Sources/SLABEngine"
    ),
    // The engine rendered and measured, the same checks the macOS graph is held to.
    .testTarget(
        name: "SLABEngineTests",
        dependencies: ["SLABEngine", "SLABCore", "SLABSound"],
        path: "Tests/SLABEngineTests"
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
    targets: targets,
    cxxLanguageStandard: .cxx17
)
