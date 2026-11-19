import Foundation
import SLABCore
import SLABWindows

let slabVersion = "0.1.0"
let defaultPort = 47_832

struct Options {
    var port = defaultPort
    var processName = "Spotify.exe"
    var initial = DSPParams.neutral
    /// How long to run without the tray, for testing.
    var seconds: Double?
}

func parseArgs() -> Options {
    var options = Options()
    var iterator = CommandLine.arguments.dropFirst().makeIterator()
    while let arg = iterator.next() {
        switch arg {
        case "--port":
            if let value = iterator.next(), let port = Int(value), (1...65_535).contains(port) { options.port = port }
        case "--process":
            if let value = iterator.next() { options.processName = value }
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
        default:
            break
        }
    }
    return options
}

let options = parseArgs()

// Two helpers would tap Spotify twice and fight over the control port.
guard slab_claim_instance() != 0 else {
    slabLog("already running; exiting")
    exit(0)
}

slabTrimLog()
slabLog("SLAB DSP \(slabVersion) for Windows · control on http://127.0.0.1:\(options.port)")

let helper = Helper(processName: options.processName, initial: options.initial)
let context = Unmanaged.passUnretained(helper).toOpaque()

/// The control port opens before anything is tapped, so the panel can tell "waiting for Spotify"
/// from "not running". A restart can race the old helper for the port, so it keeps trying.
final class Port: @unchecked Sendable {
    private let lock = NSLock()
    private var server: OpaquePointer?
    private var closed = false

    func open(_ port: Int) {
        var error: CLong = 0
        let opened = slab_serve(Int32(port), controlServe, context, &error)
        lock.lock()
        let wanted = !closed
        if wanted { server = opened }
        lock.unlock()
        if let opened, !wanted { slab_serve_stop(opened) }
        guard wanted else { return }
        if opened != nil {
            slabLog("control server listening on 127.0.0.1:\(port)")
        } else {
            slabLog("control server could not open port \(port) (\(error)); retrying")
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in self?.open(port) }
        }
    }

    func close() {
        lock.lock()
        closed = true
        let open = server
        server = nil
        lock.unlock()
        if let open { slab_serve_stop(open) }
    }
}

let port = Port()
port.open(options.port)

// Letting go hands Spotify back its own level; this exits anyway if that hangs.
helper.onQuit = {
    DispatchQueue.global().asyncAfter(deadline: .now() + 3) { exit(0) }
    helper.shutdown { slab_tray_quit() }
}

helper.start()

if let seconds = options.seconds {
    Thread.sleep(forTimeInterval: seconds)
    let done = DispatchSemaphore(value: 0)
    helper.shutdown { done.signal() }
    _ = done.wait(timeout: .now() + 3)
} else if slab_tray_run("SLAB DSP", trayStatus, trayAction, context) != 0 {
    slabLog("could not add the tray icon")
}

port.close()
exit(0)
