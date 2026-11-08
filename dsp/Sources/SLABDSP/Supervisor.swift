import CoreAudio
import Foundation
import SLABCore

/// Keeps one live tap attached to the target process for as long as the helper runs.
///
/// A process tap belongs to a single pid, so restarting Spotify used to leave the
/// helper reporting `running` while it tapped a dead process. This polls instead:
/// when the pid goes away the session is torn down, and when a new one shows up it
/// is tapped again with the same params. Control-port clients talk to this rather
/// than a graph, so a mood set while Spotify is closed still lands on the next tap.
///
/// Attaching happens on a private queue because the Core Audio calls can stall.
/// That queue never waits on the main thread, so the menu stays responsive.
final class Supervisor {
    enum Link: Equatable {
        case waitingForProcess
        case waitingForAudio(pid_t)
        case tapping(pid_t)
        case failed(String)

        var name: String {
            switch self {
            case .waitingForProcess: return "waiting-for-process"
            case .waitingForAudio: return "waiting-for-audio"
            case .tapping: return "tapping"
            case .failed: return "failed"
            }
        }
    }

    private struct Session {
        let pid: pid_t
        let capture: TapCapture
        let graph: DSPGraph
        let sampleRate: Double
    }

    let processName: String

    /// Called on the supervisor's queue whenever `link` or `audioFlowing` changes.
    var onChange: (() -> Void)?

    private static let pollInterval = 2.0
    private static let retryDelay = 10.0

    private let queue = DispatchQueue(label: "com.slab.dsp.supervisor")
    private let lock = NSLock()
    private var session: Session?
    private var linkValue = Link.waitingForProcess
    private var params: DSPParams
    private var flowing = false
    private var timer: DispatchSourceTimer?
    private var lastCallbacks = 0
    private var nextAttempt = Date.distantPast

    init(processName: String, initial: DSPParams) {
        self.processName = processName
        self.params = initial
    }

    var link: Link {
        lock.lock(); defer { lock.unlock() }
        return linkValue
    }

    /// True while the tap is actually delivering audio. A tap can be attached and
    /// silent: Spotify paused, playing on another Connect device, or capture denied.
    var audioFlowing: Bool {
        lock.lock(); defer { lock.unlock() }
        return flowing
    }

    var graph: DSPGraph? {
        lock.lock(); defer { lock.unlock() }
        return session?.graph
    }

    var capture: TapCapture? {
        lock.lock(); defer { lock.unlock() }
        return session?.capture
    }

    var sampleRate: Double? {
        lock.lock(); defer { lock.unlock() }
        return session?.sampleRate
    }

    var currentParams: DSPParams {
        lock.lock(); defer { lock.unlock() }
        return params
    }

    func apply(_ new: DSPParams) {
        lock.lock()
        params = new
        let graph = session?.graph
        lock.unlock()
        graph?.apply(new)
    }

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: Self.pollInterval)
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
    }

    /// Drop the current tap and attach again on the spot.
    func reconnect() {
        queue.async { [weak self] in
            guard let self else { return }
            self.teardown()
            self.nextAttempt = .distantPast
            self.tick()
        }
    }

    /// Runs `completion` once the tap is released. Audio returns to Spotify then.
    func shutdown(completion: @escaping () -> Void) {
        queue.async { [weak self] in
            self?.timer?.cancel()
            self?.teardown()
            completion()
        }
    }

    private func tick() {
        let pids = TapCapture.pids(named: processName)

        if let current = lockedSession() {
            if pids.contains(current.pid) {
                updateFlow(current)
                return
            }
            slabLog("\(processName) (pid \(current.pid)) exited — releasing tap")
            teardown()
        }

        guard let pid = pids.first else {
            nextAttempt = .distantPast
            publish(.waitingForProcess)
            return
        }
        guard Date() >= nextAttempt else { return }
        guard let processObject = TapCapture.processObject(forPID: pid) else {
            publish(.waitingForAudio(pid))
            return
        }
        // Starting the tap can take seconds, and status must not claim the
        // process is missing in the meantime.
        publish(.waitingForAudio(pid))
        attach(pid: pid, processObject: processObject)
    }

    private func attach(pid: pid_t, processObject: AudioObjectID) {
        // The last 45 s of what Spotify played: what chops jump back into.
        let ring = Deck(seconds: 45)
        let capture = TapCapture(ring: ring)
        do {
            try capture.start(processObjectID: processObject, label: processName)
            guard let format = capture.format else { throw TapError.noStreamFormat }
            ring.sampleRate = format.sampleRate

            let graph = DSPGraph(ring: ring, sampleRate: format.sampleRate)
            graph.prepare(currentParams)
            try graph.start()

            lock.lock()
            session = Session(pid: pid, capture: capture, graph: graph, sampleRate: format.sampleRate)
            lock.unlock()
            lastCallbacks = 0
            slabLog("tapping \(processName) (pid \(pid)) @ \(Int(format.sampleRate)) Hz")
            publish(.tapping(pid))
        } catch {
            capture.stop()
            nextAttempt = Date().addingTimeInterval(Self.retryDelay)
            publish(.failed("\(error)"))
        }
    }

    private func teardown() {
        lock.lock()
        let old = session
        session = nil
        lock.unlock()
        old?.graph.stop()
        old?.capture.stop()
        DSPGraph.renderPeak = 0
        setFlowing(false)
    }

    private func lockedSession() -> Session? {
        lock.lock(); defer { lock.unlock() }
        return session
    }

    private func updateFlow(_ current: Session) {
        let callbacks = current.capture.ioCallbacks
        let moved = callbacks != lastCallbacks
        lastCallbacks = callbacks
        DSPGraph.renderPeak = 0
        setFlowing(moved)
    }

    private func setFlowing(_ value: Bool) {
        lock.lock()
        let changed = flowing != value
        flowing = value
        lock.unlock()
        if changed {
            slabLog(value ? "audio flowing" : "no audio from \(processName)")
            onChange?()
        }
    }

    private func publish(_ next: Link) {
        lock.lock()
        let changed = linkValue != next
        linkValue = next
        lock.unlock()
        guard changed else { return }
        switch next {
        case .waitingForProcess: slabLog("waiting for \(processName) to open")
        case .waitingForAudio(let pid): slabLog("\(processName) (pid \(pid)) has no audio client yet")
        case .tapping: break
        case .failed(let reason): slabLog("could not attach: \(reason)")
        }
        onChange?()
    }
}
