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
        cxxSettings: [
            .headerSearchPath("vendor"),
            // Visual Studio's C++ library refuses a clang older than the one it was released with,
            // and Swift's bundled clang can trail a fresh Visual Studio by a version.
            .define("_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH", .when(platforms: [.windows])),
        ]
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
    // The control port's requests, who may make them, and its routes: what SLAB sends a helper.
    .target(
        name: "SLABControl",
        dependencies: ["SLABCore"],
        path: "Sources/SLABControl"
    ),
    .testTarget(
        name: "SLABControlTests",
        dependencies: ["SLABControl", "SLABCore"],
        path: "Tests/SLABControlTests"
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

#if os(Windows)
// The Windows helper: Spotify heard through WASAPI process loopback, played through SLABEngine, with
// the same control port and a tray icon.
targets += [
    .target(
        name: "SLABWindows",
        path: "Sources/SLABWindows",
        cxxSettings: [.define("_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH")],
        linkerSettings: [
            .linkedLibrary("ole32"),
            .linkedLibrary("mmdevapi"),
            .linkedLibrary("avrt"),
            .linkedLibrary("ws2_32"),
            .linkedLibrary("user32"),
            .linkedLibrary("shell32"),
            .linkedLibrary("advapi32"),
            .linkedLibrary("gdi32"),
        ]
    ),
    .executableTarget(
        name: "SLABDSP",
        dependencies: ["SLABCore", "SLABEngine", "SLABControl", "SLABWindows"],
        path: "Sources/SLABDSPWin",
        // A tray app: no console window when it starts.
        linkerSettings: [.unsafeFlags(["-Xlinker", "/SUBSYSTEM:WINDOWS", "-Xlinker", "/ENTRY:mainCRTStartup"])]
    ),
]
#endif

let package = Package(
    name: "SLABDSP",
    platforms: [.macOS("14.2")],
    targets: targets,
    cxxLanguageStandard: .cxx17
)
