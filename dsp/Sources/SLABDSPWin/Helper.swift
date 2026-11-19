import Foundation
import SLABControl
import SLABCore
import SLABEngine
import SLABWindows

/// One tap: Spotify on the way in, the speakers on the way out, and the deck and engine between.
final class Session {
    let pid: CUnsignedLong
    let sampleRate: Double
    let deck: Deck
    let engine: Engine
    fileprivate var tap: OpaquePointer?
    fileprivate var speaker: OpaquePointer?

    init(pid: CUnsignedLong, sampleRate: Double, params: DSPParams) {
        self.pid = pid
        self.sampleRate = sampleRate
        deck = Deck(sampleRate: sampleRate, seconds: 45, reportsCuts: true)
        engine = Engine(deck: deck, sampleRate: sampleRate)
        engine.apply(params)
    }
}

// What the capture and render threads call, with the session as their context.
private let tapSink: SlabTapSink = { context, left, right, frames in
    guard let context, let left, let right, frames > 0 else { return }
    Unmanaged<Session>.fromOpaque(context).takeUnretainedValue().deck.write(left, right, frames: Int(frames))
}

private let speakerSource: SlabSpeakerSource = { context, left, right, frames in
    guard let context, let left, let right, frames > 0 else { return }
    Unmanaged<Session>.fromOpaque(context).takeUnretainedValue().engine.render(left, right, frames: Int(frames))
}

/// What the control port's threads call, with the helper as their context.
let controlServe: SlabServe = { context, data, length, reply in
    guard let context, let data, let reply else { return 0 }
    let bytes = Data(bytes: data, count: Int(length))
    guard let request = ControlRequest.parse(bytes) else {
        return bytes.count > ControlRequest.maxBytes ? 0 : -1
    }
    let helper = Unmanaged<Helper>.fromOpaque(context).takeUnretainedValue()
    let response = ControlRoutes.respond(to: request, helper: helper)
    guard let memory = malloc(response.count) else { return 0 }
    response.copyBytes(to: memory.assumingMemoryBound(to: UInt8.self), count: response.count)
    reply.pointee = memory.assumingMemoryBound(to: CChar.self)
    return CLong(response.count)
}

/// What the tray menu's first line says, and what its items do.
let trayStatus: SlabTrayStatus = { context, text, size in
    guard let context, let text, size > 1 else { return }
    let line = Unmanaged<Helper>.fromOpaque(context).takeUnretainedValue().menuLine
    var bytes = Array(line.utf8.prefix(Int(size) - 1))
    bytes.append(0)
    for (i, byte) in bytes.enumerated() { text[i] = CChar(bitPattern: byte) }
}

let trayAction: SlabTrayAction = { context, action in
    guard let context else { return }
    let helper = Unmanaged<Helper>.fromOpaque(context).takeUnretainedValue()
    switch action {
    case Int32(SLAB_TRAY_LOGIN): _ = slab_login_item(slab_login_item(-1) == 0 ? 1 : 0)
    case Int32(SLAB_TRAY_RECONNECT): helper.reconnect()
    case Int32(SLAB_TRAY_QUIT): helper.onQuit?()
    case Int32(SLAB_TRAY_ENDING): helper.ending()
    default: break
    }
}

/// Keeps one tap on Spotify for as long as the helper runs, as the macOS helper's Supervisor does:
/// polls for the process, taps it when it appears, lets go when it goes, and keeps the mood across.
///
/// Spotify's own output is turned down to -60 dB while SLAB plays it, and the capture made up by as
/// much, in float, so nothing is lost and only SLAB's version is heard. Windows remembers an app's
/// volume, so SLAB keeps Spotify's own level on disk until it has given it back: on letting go, on
/// quitting, at logoff, and at the next start after one that couldn't.
final class Helper: ControlHelper {
    enum Link: Equatable {
        case waitingForProcess
        case waitingForAudio(CUnsignedLong)
        case tapping(CUnsignedLong)
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

    let processName: String
    /// Set by main: what quitting from the tray, or `/quit`, does.
    var onQuit: (() -> Void)?

    /// How far Spotify's own output is turned down while SLAB plays it.
    static let duck: Float = 0.001
    private static let pollInterval = 2.0
    private static let retryDelay = 10.0

    private let queue = DispatchQueue(label: "com.slab.dsp.supervisor")
    private let lock = NSLock()
    private var session: Session?
    private var linkValue = Link.waitingForProcess
    private var mood: DSPParams
    private var flowing = false
    private var lastPackets: Int64 = 0
    private var lastAsItCame: Int64 = 0
    private var nextAttempt = Date.distantPast
    private var timer: DispatchSourceTimer?
    private var peak: Float = 0

    /// Spotify's own level, as whoever set it last set it, while SLAB has it turned down.
    private var spotifyLevel: Float?
    private let levelFile = slabFolder?.appendingPathComponent("spotify-volume.txt")

    init(processName: String, initial: DSPParams) {
        self.processName = processName
        mood = initial
        // A SLAB DSP that couldn't give it back left it here.
        if let url = levelFile, let text = try? String(contentsOf: url, encoding: .utf8),
           let level = Float(text.trimmingCharacters(in: .whitespacesAndNewlines)) {
            spotifyLevel = max(0, min(1, level))
        }
    }

    var link: Link {
        lock.lock(); defer { lock.unlock() }
        return linkValue
    }

    var audioFlowing: Bool {
        lock.lock(); defer { lock.unlock() }
        return flowing
    }

    private func lockedSession() -> Session? {
        lock.lock(); defer { lock.unlock() }
        return session
    }

    // MARK: Running

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: Self.pollInterval)
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
    }

    /// Lets go of Spotify, gives it back its own level, then runs `completion`.
    func shutdown(completion: @escaping () -> Void) {
        queue.async { [weak self] in
            self?.timer?.cancel()
            self?.teardown()
            completion()
        }
    }

    /// Windows is logging off: give Spotify its level back now, on this thread, before anything else.
    func ending() {
        guard let pid = lockedSession()?.pid else { return }
        giveSpotifyBack(pid)
    }

    private func tick() {
        let pid = processName.withCString { slab_find_process($0) }
        if let current = lockedSession() {
            if pid == current.pid, slab_speaker_lost(current.speaker) == 0 {
                updateFlow(current)
                turnSpotifyDown(current.pid)
                slab_tap_set_level(current.tap, spotifyLevel ?? 1)
                return
            }
            slabLog(pid == current.pid ? "the output device went away; starting again" : "\(processName) (pid \(current.pid)) exited; letting go")
            teardown()
        }
        guard pid != 0 else {
            nextAttempt = .distantPast
            publish(.waitingForProcess)
            return
        }
        guard Date() >= nextAttempt else { return }
        publish(.waitingForAudio(pid))
        attach(pid)
    }

    private func attach(_ pid: CUnsignedLong) {
        let rate = Int(slab_output_rate())
        guard rate > 0 else { return fail(pid, "no output device") }
        let session = Session(pid: pid, sampleRate: Double(rate), params: params)
        let context = Unmanaged.passUnretained(session).toOpaque()
        // Spotify down first, so what the tap hears from the start is what it makes up for.
        turnSpotifyDown(pid)
        var error: CLong = 0
        guard let tap = slab_tap_start(pid, Int32(rate), spotifyLevel ?? 1, Self.duck, tapSink, context, &error) else {
            return fail(pid, "could not hear \(processName) (\(hex(error))); this needs Windows 10 version 2004 or newer")
        }
        session.tap = tap
        var played: Int32 = 0
        guard let speaker = slab_speaker_start(speakerSource, context, &played, &error) else {
            slab_tap_stop(tap)
            return fail(pid, "could not play to the speakers (\(hex(error)))")
        }
        session.speaker = speaker
        guard Int(played) == rate else {
            // The default device changed in between: the next poll starts again at its rate.
            slab_speaker_stop(speaker)
            slab_tap_stop(tap)
            giveSpotifyBack(pid)
            slabLog("the output device's rate changed to \(played) Hz while starting; starting again")
            return
        }
        session.engine.onRealign = { lag in
            slabLog("chop realigned, \(Int(Double(lag) / Double(rate) * 1000)) ms behind live")
        }
        session.engine.start()
        lock.lock()
        self.session = session
        lock.unlock()
        lastPackets = 0
        lastAsItCame = 0
        slabLog("tapping \(processName) (pid \(pid)) @ \(rate) Hz")
        publish(.tapping(pid))
    }

    private func fail(_ pid: CUnsignedLong, _ reason: String) {
        nextAttempt = Date().addingTimeInterval(Self.retryDelay)
        // Turned down, here or by an earlier run, and nothing to play it now: give it back.
        if spotifyLevel != nil { giveSpotifyBack(pid) }
        publish(.failed(reason))
    }

    private func teardown() {
        lock.lock()
        let old = session
        session = nil
        lock.unlock()
        if let old {
            slab_speaker_stop(old.speaker)
            slab_tap_stop(old.tap)
            old.engine.stop()
            giveSpotifyBack(old.pid)
        }
        peak = 0
        setFlowing(false)
    }

    func reconnect() {
        queue.async { [weak self] in
            guard let self else { return }
            self.teardown()
            self.nextAttempt = .distantPast
            self.tick()
        }
    }

    // MARK: Spotify's own output

    /// Keeps Spotify's own output down while SLAB plays it; a session Spotify opens later goes down too.
    /// Spotify's slider moved in the volume mixer is its new level, and SLAB plays at it.
    private func turnSpotifyDown(_ pid: CUnsignedLong) {
        var previous: Float = -1
        let sessions = slab_app_volume(pid, Self.duck, &previous)
        guard sessions > 0 else { return }
        if previous >= 0, abs(previous - Self.duck) > 1e-4 {
            remember(previous)
        } else if spotifyLevel == nil {
            // Already down, with no record of what it was: as Windows starts an app.
            remember(1)
        }
    }

    private func remember(_ level: Float) {
        spotifyLevel = level
        if let url = levelFile { try? Data("\(level)".utf8).write(to: url) }
    }

    /// Spotify's own level back. If Spotify has gone, there's nothing to set it on: the record stays
    /// for whenever SLAB next sees it.
    private func giveSpotifyBack(_ pid: CUnsignedLong) {
        guard let level = spotifyLevel else { return }
        guard slab_app_volume(pid, level, nil) > 0 else { return }
        spotifyLevel = nil
        if let url = levelFile { try? FileManager.default.removeItem(at: url) }
    }

    // MARK: State

    private func updateFlow(_ current: Session) {
        let packets = slab_tap_packets(current.tap)
        let moved = packets != lastPackets
        lastPackets = packets
        // A few as Spotify opens a session; a steady stream means this Windows hears Spotify before its volume.
        let asItCame = slab_tap_as_it_came(current.tap)
        if asItCame > lastAsItCame {
            slabLog("\(asItCame - lastAsItCame) packets from \(processName) came in not turned down, and played as they came")
            lastAsItCame = asItCame
        }
        peak = current.engine.level
        current.engine.resetLevel()
        setFlowing(moved)
    }

    private func setFlowing(_ value: Bool) {
        lock.lock()
        let changed = flowing != value
        flowing = value
        lock.unlock()
        if changed { slabLog(value ? "audio flowing" : "no audio from \(processName)") }
    }

    private func publish(_ next: Link) {
        lock.lock()
        let changed = linkValue != next
        linkValue = next
        lock.unlock()
        guard changed else { return }
        switch next {
        case .waitingForProcess: slabLog("waiting for \(processName) to open")
        case .waitingForAudio(let pid): slabLog("\(processName) (pid \(pid)) found; tapping it")
        case .tapping: break
        case .failed(let reason): slabLog("could not attach: \(reason)")
        }
    }

    /// The tray menu's first line.
    var menuLine: String {
        switch link {
        case .waitingForProcess: return "Waiting for Spotify to open"
        case .waitingForAudio: return "Connecting to Spotify"
        case .tapping: return audioFlowing ? "Playing Spotify through SLAB" : "Connected; Spotify is quiet"
        case .failed(let reason): return "Couldn't connect: \(reason)"
        }
    }

    private func hex(_ error: CLong) -> String {
        "0x" + String(UInt32(truncatingIfNeeded: Int64(error)), radix: 16, uppercase: true)
    }

    // MARK: ControlHelper

    func status() -> [String: Any] {
        let link = self.link
        let current = lockedSession()
        var payload: [String: Any] = [
            "ok": true,
            "service": "slab-dsp",
            "version": slabVersion,
            "platform": "windows",
            "process": processName,
            "link": link.name,
            "tapping": current != nil,
            "audio": audioFlowing,
            "running": current != nil,
            "engine": current != nil,
            "level": max(peak, current?.engine.level ?? 0),
            "params": ControlRoutes.dictionary(params),
            "features": ControlRoutes.features,
        ]
        switch link {
        case .tapping(let pid), .waitingForAudio(let pid): payload["pid"] = Int(pid)
        case .failed(let reason): payload["error"] = reason
        case .waitingForProcess: break
        }
        if let current {
            payload["latencyMs"] = (current.engine.latencyMs * 10).rounded() / 10
            payload["droppedFrames"] = current.deck.droppedFrames
            for (key, value) in ControlRoutes.deckStatus(current.deck) { payload[key] = value }
            // Before a seek has been measured: about what one costs Spotify, plus how far ahead of what
            // is heard this helper's stretcher reads, which a chop's seek has to clear as well.
            if payload["seekGapMs"] == nil {
                payload["seekGapMs"] = 250 + (Double(current.engine.leadFrames) / current.sampleRate * 1000).rounded()
            }
            payload["sampleRate"] = current.sampleRate
            payload["callbacks"] = Int(slab_tap_packets(current.tap))
            payload["asItCame"] = Int(slab_tap_as_it_came(current.tap))
        }
        return payload
    }

    var params: DSPParams {
        lock.lock(); defer { lock.unlock() }
        return mood
    }

    func apply(_ new: DSPParams) {
        lock.lock()
        mood = new
        let current = session
        lock.unlock()
        current?.engine.apply(new)
    }

    var tapped: (deck: Deck, sampleRate: Double)? {
        guard let current = lockedSession() else { return nil }
        return (current.deck, current.sampleRate)
    }

    func tapeStop(downMs: Int, holdMs: Int, upMs: Int) -> Bool {
        guard let current = lockedSession() else { return false }
        current.engine.tapeStop(downMs: downMs, holdMs: holdMs, upMs: upMs)
        return true
    }

    func hold(_ hold: Hold, ms: Int) -> Bool {
        guard let current = lockedSession() else { return false }
        current.engine.hold(hold, ms: ms)
        return true
    }

    func quit() {
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.onQuit?() }
    }

    func refused(_ what: String, error: Error, backMs: Double, availableMs: Double) {
        slabLog("\(what) refused (\(error)): \(Int(backMs)) ms back, \(Int(availableMs)) ms of song behind it")
    }
}
