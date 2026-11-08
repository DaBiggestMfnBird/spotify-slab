import AppKit
import Foundation
import ServiceManagement

let slabVersion = "0.6.2"
let defaultPort: UInt16 = 47_832

struct Options {
    var port: UInt16 = defaultPort
    var processName: String = "Spotify"
    var recordPath: String?
    var seconds: Double?
    var initial: DSPParams = .neutral
    var loginItem: String?
}

func parseArgs() -> Options {
    var options = Options()
    var iterator = CommandLine.arguments.dropFirst().makeIterator()
    while let arg = iterator.next() {
        switch arg {
        case "--port":
            if let value = iterator.next(), let port = UInt16(value) { options.port = port }
        case "--process":
            if let value = iterator.next() { options.processName = value }
        case "--record":
            if let value = iterator.next() { options.recordPath = value }
        case "--seconds":
            if let value = iterator.next(), let seconds = Double(value) { options.seconds = seconds }
        case "--set":
            if let value = iterator.next() {
                for pair in value.split(separator: ",") {
                    let kv = pair.split(separator: "=", maxSplits: 1)
                    guard kv.count == 2, let number = Float(kv[1]) else { continue }
                    switch kv[0] {
                    case "pitch": options.initial.pitch = number
                    case "reverb": options.initial.reverb = number
                    case "delayTime": options.initial.delayTime = Double(number)
                    case "delayFeedback": options.initial.delayFeedback = number
                    case "delayMix": options.initial.delayMix = number
                    case "lowpass": options.initial.lowpass = number
                    case "gain": options.initial.gain = number
                    default: break
                    }
                }
            }
        case "--login-item":
            options.loginItem = iterator.next()
        case "--help", "-h":
            print("""
            SLABDSP \(slabVersion) — real pitch / reverb / delay for Spotify on macOS

              --port <n>        control port (default \(defaultPort))
              --process <name>  process to tap (default Spotify)
              --set k=v,...     initial params (pitch, reverb, delayMix, ...)
              --record <file>   record processed output to a WAV, then exit
              --seconds <n>     how long to run (no menu bar item)
              --login-item <on|off|status>  manage Start at Login, then exit
            """)
            exit(0)
        default:
            break
        }
    }
    return options
}

let options = parseArgs()

if let wanted = options.loginItem {
    do {
        if wanted != "status" { try StatusMenu.setLoginItem(wanted == "on") }
        print("login item: \(SMAppService.mainApp.status.rawValue) (0 not registered, 1 enabled, 2 needs approval, 3 not found)")
        exit(0)
    } catch {
        print("login item failed: \(error)")
        exit(8)
    }
}

// Two helpers would tap Spotify twice and fight over the control port.
if let id = Bundle.main.bundleIdentifier {
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: id)
        .filter { $0.processIdentifier != getpid() }
    if !others.isEmpty {
        slabLog("already running as pid \(others[0].processIdentifier) — exiting")
        exit(0)
    }
}

slabTrimLog()

let supervisor = Supervisor(processName: options.processName, initial: options.initial)

// The port opens before anything is tapped, so the panel can tell "helper is
// waiting for Spotify" apart from "helper is not running".
var server: ControlServer?
if options.recordPath == nil {
    do {
        let s = try ControlServer(port: options.port, supervisor: supervisor)
        s.start()
        server = s
    } catch {
        slabLog("error: control server failed: \(error)")
        exit(7)
    }
}

// Shut down cleanly. Releasing the tap hands the audio back to Spotify; the
// fallback covers a Core Audio call that never returns.
let shutdown: () -> Void = {
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { exit(0) }
    supervisor.shutdown { exit(0) }
}
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigint.setEventHandler(handler: shutdown)
sigterm.setEventHandler(handler: shutdown)
sigint.resume()
sigterm.resume()
server?.onQuit = shutdown

slabLog("SLAB DSP \(slabVersion) · control on http://127.0.0.1:\(options.port)")

if options.recordPath == nil && options.seconds == nil {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let menu = StatusMenu(supervisor: supervisor, server: server, onQuit: shutdown)
    app.delegate = menu
    supervisor.start()
    withExtendedLifetime(menu) { app.run() }
} else {
    // Dev flags: no menu bar, and a missing target is an error rather than a wait.
    var recorder: Recorder?
    var armed = false
    supervisor.onChange = {
        DispatchQueue.main.async {
            switch supervisor.link {
            case .waitingForProcess:
                slabLog("error: \(options.processName) is not running.")
                exit(2)
            case .waitingForAudio(let pid):
                slabLog("error: \(options.processName) (pid \(pid)) is not an audio process yet — start playback and retry.")
                exit(3)
            case .failed(let reason):
                slabLog("error: \(reason)")
                exit(4)
            case .tapping:
                guard !armed, let graph = supervisor.graph else { return }
                armed = true
                if let path = options.recordPath {
                    let rec = Recorder(path: path, graph: graph)
                    do {
                        try rec.start()
                        recorder = rec
                    } catch {
                        slabLog("error: could not record: \(error)")
                    }
                }
                if let seconds = options.seconds {
                    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                        recorder?.stop()
                        shutdown()
                    }
                }
            }
        }
    }
    supervisor.start()
    withExtendedLifetime(server) { RunLoop.main.run() }
}
