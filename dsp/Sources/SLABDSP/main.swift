import Foundation
import AVFoundation
import CoreAudio

let version = "0.2.0"
let defaultPort: UInt16 = 47_832

struct Options {
    var port: UInt16 = defaultPort
    var processName: String = "Spotify"
    var recordPath: String?
    var seconds: Double?
    var initial: DSPParams = .neutral
    var quiet = false
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
        case "--quiet":
            options.quiet = true
        case "--help", "-h":
            print("""
            SLABDSP \(version) — real pitch / reverb / delay for Spotify on macOS

              --port <n>        control port (default \(defaultPort))
              --process <name>  process to tap (default Spotify)
              --set k=v,...     initial params (pitch, reverb, delayMix, ...)
              --record <file>   record processed output to a WAV, then exit
              --seconds <n>     how long to run
              --quiet           no status logging
            """)
            exit(0)
        default:
            break
        }
    }
    return options
}

let options = parseArgs()

// 1. Locate the process to tap.
let pids = TapCapture.pids(named: options.processName)
guard let pid = pids.first else {
    slabLog("error: \(options.processName) is not running.")
    exit(2)
}

guard let processObject = TapCapture.processObject(forPID: pid) else {
    slabLog("error: \(options.processName) (pid \(pid)) is not an audio process yet — start playback and retry.")
    exit(3)
}

// 2. Build capture + DSP.
let ring = StereoRing(capacity: 48_000 * 2)
let capture = TapCapture(ring: ring)

do {
    try capture.start(processObjectID: processObject, label: options.processName)
} catch {
    slabLog("error: \(error)")
    exit(4)
}

guard let tapFormat = capture.format else {
    slabLog("error: tap reported no format")
    capture.stop()
    exit(5)
}

let graph = DSPGraph(ring: ring, sampleRate: tapFormat.sampleRate)
graph.apply(options.initial)

do {
    try graph.start()
} catch {
    slabLog("error: audio engine failed to start: \(error)")
    capture.stop()
    exit(6)
}

if !options.quiet {
    slabLog("tapping \(options.processName) (pid \(pid)) @ \(Int(tapFormat.sampleRate)) Hz · control on http://127.0.0.1:\(options.port)")
}

// 3. Optional recording mode for verification.
var recorder: Recorder?
if let path = options.recordPath {
    let rec = Recorder(path: path, graph: graph)
    do {
        try rec.start()
        recorder = rec
    } catch {
        slabLog("error: could not record: \(error)")
    }
}

var server: ControlServer?
if options.recordPath == nil {
    do {
        let s = try ControlServer(port: options.port) { [weak capture, weak graph] in
            [
                "ok": true,
                "service": "slab-dsp",
                "version": version,
                "process": options.processName,
                "pid": pid,
                "sampleRate": tapFormat.sampleRate,
                "engine": graph?.isRunning ?? false,
                "level": DSPGraph.renderPeak,
            ] as [String: Any]
        }
        s.attach(graph: graph)
        s.start()
        server = s
    } catch {
        slabLog("error: control server failed: \(error)")
        capture.stop()
        exit(7)
    }
}

// 4. Shut down cleanly.
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let shutdown: () -> Void = {
    recorder?.stop()
    graph.stop()
    capture.stop()
    exit(0)
}
sigint.setEventHandler(handler: shutdown)
sigterm.setEventHandler(handler: shutdown)
sigint.resume()
sigterm.resume()

var statusTimer: DispatchSourceTimer?
if !options.quiet {
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 2, repeating: 5.0)
    timer.setEventHandler {
        slabLog("alive · callbacks=\(capture.ioCallbacks) buffered=\(graph.bufferFrames)")
        DSPGraph.renderPeak = 0
    }
    timer.resume()
    statusTimer = timer
}

if let seconds = options.seconds {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { shutdown() }
}

withExtendedLifetime((server, statusTimer)) {
    RunLoop.main.run()
}
