import Foundation
import AVFoundation
import SLABCore

struct DSPParams: Codable, Equatable {
    /// Pitch shift in cents. 0 = untouched. -1200 = one octave down.
    var pitch: Float = 0
    /// Reverb wet/dry, 0...100.
    var reverb: Float = 0
    /// Reverb character.
    var reverbPreset: String = "largeHall2"
    /// Delay time in seconds.
    var delayTime: Double = 0.36
    /// Delay feedback, 0...95.
    var delayFeedback: Float = 0
    /// Delay wet/dry, 0...100.
    var delayMix: Float = 0
    /// Low-pass cutoff in Hz. 20000 = bypass.
    var lowpass: Float = 20_000
    /// Output trim in dB.
    var gain: Float = 0
    /// Tape: a worn cassette's wow (the speed wandering), its hiss, a record's crackle, and a
    /// cheap sampler's crunch. Each 0...1, 0 = off.
    var wow: Float = 0
    var hiss: Float = 0
    var crackle: Float = 0
    var crush: Float = 0

    static let neutral = DSPParams()
}

/// A pad held on top of the mood: let it go and the mood is back. Each part ramps.
struct Hold: Equatable {
    /// Added to the mood's pitch, in cents.
    var pitchOffset: Float = 0
    /// The low-pass can't open past this, in Hz. 20000 = no cap.
    var lowpassCap: Float = 20_000
    /// Added to the output trim, in dB.
    var gainBoost: Float = 0
    /// An echo over the mood's own delay: wet 0...100, feedback 0...95, time in seconds.
    var echoMix: Float = 0
    var echoFeedback: Float = 0
    var echoTime: Double = 0.36

    static let none = Hold()
}

final class DSPGraph {
    private let engine: AVAudioEngine
    private let source: AVAudioSourceNode
    private let timePitch = AVAudioUnitTimePitch()
    /// The tape's speed, which wow sets wandering; pitch and time wander together, as on a tape.
    private let varispeed = AVAudioUnitVarispeed()
    private let reverb = AVAudioUnitReverb()
    /// The echo is a send: what goes in is the send's level, and it comes back fully wet. Cut
    /// the send and what's already in the echo rings on, the way a dub engineer throws one.
    private let send = AVAudioMixerNode()
    private let delay = AVAudioUnitDelay()
    /// Hiss, crackle and crush, on the samples straight out of the deck.
    private let color: TapeColor
    private let eq = AVAudioUnitEQ(numberOfBands: 1)
    private let ring: Deck
    /// Lines the output back up with Spotify after a chop, and closes any lag that left.
    private let steering = DispatchQueue(label: "com.slab.dsp.deck", qos: .userInitiated)
    private var steerTimer: DispatchSourceTimer?
    private var catchUpRate = false
    /// The last chop written to the log.
    private var loggedChop = 0
    /// A tape stop owns the time-stretcher's rate until this moment.
    private var tapeUntil = Date.distantPast
    private let sampleRate: Double
    private(set) var isRunning = false
    private let paramsLock = NSLock()
    private var params = DSPParams.neutral
    private var tapeToken = 0

    /// What is held on top of the mood right now, and the ramp it is on. Main thread only.
    private var holdNow = Hold.none
    private var holdFrom = Hold.none
    private var holdTo = Hold.none
    private var holdStart = Date()
    private var holdSeconds: Double = 0
    private var holdTimer: DispatchSourceTimer?
    /// A hold nobody refreshes lets go by itself: SLAB may have lost the key-up with the window.
    private var holdWatch: DispatchSourceTimer?
    static let holdLifetime: TimeInterval = 10
    /// A thrown echo ringing out: the time and feedback it keeps until it has died away.
    private var echoRing: (time: Double, feedback: Float)?
    private var echoRingUntil = Date.distantPast

    private var wowTimer: DispatchSourceTimer?
    private var wowStart = Date()
    private var wowDepth: Float = 0

    /// Peak of the last render block, for the panel's level readout.
    nonisolated(unsafe) static var renderPeak: Float = 0

    /// Rendering offline, as the tests do: as fast as the machine goes, with no audio device. What
    /// the live timers step on the clock (the hold's ramp, the wow, a thrown echo's end) steps on
    /// the audio rendered so far instead, in `renderOffline`.
    private let offline: Bool
    private var renderedFrames = 0
    private var holdRamping = false
    private var echoRingPending = false

    init(ring: Deck, sampleRate: Double, offline: Bool = false) {
        self.ring = ring
        self.sampleRate = sampleRate
        self.offline = offline

        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2) else {
            fatalError("could not build audio format")
        }
        let engine = AVAudioEngine()
        if offline {
            // Before anything is connected, so the graph never looks for an output device.
            do {
                try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4_096)
            } catch {
                fatalError("could not render offline: \(error)")
            }
        }
        self.engine = engine
        let color = TapeColor(sampleRate: sampleRate)
        self.color = color

        source = AVAudioSourceNode(format: format) { _, _, frameCount, ablPtr -> OSStatus in
            let abl = UnsafeMutableAudioBufferListPointer(ablPtr)
            let frames = Int(frameCount)
            guard abl.count > 0, let l = abl[0].mData?.assumingMemoryBound(to: Float.self) else {
                return noErr
            }
            let r = abl.count > 1
                ? (abl[1].mData?.assumingMemoryBound(to: Float.self) ?? l)
                : l
            _ = ring.read(into: l, r, frames: frames)
            if r != l { color.process(l, r, frames: frames) }

            var peak: Float = 0
            for i in 0..<frames {
                let v = abs(l[i])
                if v > peak { peak = v }
            }
            if peak > DSPGraph.renderPeak { DSPGraph.renderPeak = peak }
            return noErr
        }

        engine.attach(source)
        engine.attach(timePitch)
        engine.attach(varispeed)
        engine.attach(reverb)
        engine.attach(send)
        engine.attach(delay)
        engine.attach(eq)

        let band = eq.bands[0]
        band.filterType = .lowPass
        band.frequency = 20_000
        band.bypass = true
        band.bandwidth = 0.5

        engine.connect(source, to: timePitch, format: format)
        engine.connect(timePitch, to: varispeed, format: format)
        engine.connect(varispeed, to: eq, format: format)
        engine.connect(eq, to: reverb, format: format)
        // Dry to the mixer, and a send to the echo, which comes back on its own input.
        let main = engine.mainMixerNode
        engine.connect(
            reverb,
            to: [AVAudioConnectionPoint(node: main, bus: 0), AVAudioConnectionPoint(node: send, bus: 0)],
            fromBus: 0,
            format: format
        )
        engine.connect(send, to: delay, format: format)
        engine.connect(delay, to: main, fromBus: 0, toBus: main.nextAvailableInputBus, format: format)
        engine.connect(main, to: engine.outputNode, format: nil)

        timePitch.rate = 1.0
        timePitch.pitch = 0
        timePitch.overlap = 8
        reverb.loadFactoryPreset(.largeHall2)
        reverb.wetDryMix = 0
        delay.delayTime = 0.36
        delay.feedback = 0
        delay.wetDryMix = 100
        delay.lowPassCutoff = 12_000
        send.outputVolume = 0
        varispeed.rate = 1
        varispeed.bypass = true
        engine.mainMixerNode.outputVolume = 1.0
    }

    func start() throws {
        guard !isRunning else { return }
        engine.prepare()
        try engine.start()
        isRunning = true
        // Offline, the deck is fed as the graph renders: no backlog to drop, and no Spotify to steer by.
        guard !offline else { return }
        // Capture runs while the engine is being prepared. Drop that backlog so
        // the first thing heard is current, not a second stale.
        ring.trim(keep: 1_024)
        startSteering()
    }

    /// The graph's clock: the wall clock live, the audio rendered so far offline.
    private func now() -> Date {
        offline ? Date(timeIntervalSinceReferenceDate: Double(renderedFrames) / sampleRate) : Date()
    }

    /// The format `renderOffline` fills.
    var renderFormat: AVAudioFormat { engine.manualRenderingFormat }

    /// Offline only: renders the next `frames` (at most 4096) into `buffer`, then moves the clock on
    /// by as much and steps what the live timers would have.
    func renderOffline(_ frames: Int, into buffer: AVAudioPCMBuffer) throws -> AVAudioEngineManualRenderingStatus {
        precondition(offline, "renderOffline is for a graph built offline")
        let status = try engine.renderOffline(AVAudioFrameCount(frames), to: buffer)
        renderedFrames += frames
        if holdRamping { stepHold() }
        if wowDepth > 0 { stepWow() }
        if echoRingPending, now() >= echoRingUntil {
            echoRingPending = false
            mix(current, holdNow)
        }
        return status
    }

    func stop() {
        guard isRunning else { return }
        steerTimer?.cancel()
        steerTimer = nil
        holdTimer?.cancel()
        holdTimer = nil
        holdWatch?.cancel()
        holdWatch = nil
        wowTimer?.cancel()
        wowTimer = nil
        engine.stop()
        isRunning = false
    }

    /// The deck: chops jump back in it, and the panel reads its state.
    var deck: Deck { ring }

    /// Every 25 ms: while the deck plays from memory, look for Spotify's re-seeked audio; once
    /// it is back but further behind live than usual, run the time-stretcher 4% fast until the
    /// gap is closed (pitch unchanged), unless a tape stop has the rate.
    private func startSteering() {
        let timer = DispatchSource.makeTimerSource(queue: steering)
        timer.schedule(deadline: .now() + .milliseconds(25), repeating: .milliseconds(25), leeway: .milliseconds(5))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if self.ring.isDetached {
                self.ring.realign()
            }
            if self.ring.jumps > self.loggedChop { self.logChops() }
            let want = self.ring.catchingUp
            guard want != self.catchUpRate else { return }
            self.catchUpRate = want
            DispatchQueue.main.async { [weak self] in
                guard let self, Date() >= self.tapeUntil else { return }
                self.timePitch.rate = want ? 1.04 : 1.0
            }
        }
        timer.resume()
        steerTimer = timer
    }

    /// Each chop, once it has gone one way or another, as a line in the log: what makes chops sound
    /// off on a real record is in these.
    private func logChops() {
        for chop in ring.recentChops where chop.number > loggedChop {
            guard let outcome = chop.outcome else { break }
            loggedChop = chop.number
            slabLog(Self.describe(chop, outcome: outcome, sampleRate: sampleRate, behindMs: latencyMs))
        }
    }

    static func describe(_ chop: Deck.ChopRecord, outcome: Deck.Outcome, sampleRate: Double, behindMs: Double) -> String {
        let ms = { (frames: Int) in Int((Double(frames) / sampleRate * 1000).rounded()) }
        var line = "chop \(chop.number): \(ms(chop.madeFrames)) ms back"
        if chop.madeFrames != chop.askedFrames {
            line += " (tightened from \(ms(chop.askedFrames)) to the record's own beat)"
        }
        let took = Int((chop.tookMs ?? 0).rounded())
        let seek = chop.gapMs.map { "; Spotify's seek took \(Int($0.rounded())) ms" } ?? ""
        let score = String(format: "%.3f", chop.bestScore)
        switch outcome {
        case .realigned:
            line += ", back on Spotify after \(took) ms\(seek), now \(Int(behindMs.rounded())) ms behind live"
        case .behind:
            line += ", Spotify came back behind memory: \(Int((chop.repeatMs ?? 0).rounded())) ms heard twice\(seek)"
        case .wentLive:
            line += ", Spotify's audio not found in \(took) ms, went live with a skip (best match \(score))"
        case .cancelled:
            line += ", called off by a pause or a new track"
        case .chopped:
            line += ", another chop came \(took) ms later"
        }
        return line
    }

    var current: DSPParams {
        paramsLock.lock(); defer { paramsLock.unlock() }
        return params
    }

    func apply(_ new: DSPParams) {
        paramsLock.lock()
        params = new
        paramsLock.unlock()
        applyOnMain(new)
    }

    /// For a graph nothing else can see yet: set params on the calling thread so
    /// the first sample out is already pitched. Use `apply` once it is running.
    func prepare(_ new: DSPParams) {
        paramsLock.lock()
        params = new
        paramsLock.unlock()
        push(new)
    }

    private func applyOnMain(_ p: DSPParams) {
        if Thread.isMainThread {
            push(p)
        } else {
            DispatchQueue.main.async { [weak self] in self?.push(p) }
        }
    }

    private func push(_ p: DSPParams) {
        reverb.loadFactoryPreset(Self.preset(named: p.reverbPreset))
        reverb.wetDryMix = max(0, min(100, p.reverb))
        color.set(TapeColor.Settings(hiss: p.hiss, crackle: p.crackle, crush: p.crush))
        setWow(p.wow)
        mix(p, holdNow)
    }

    /// Wow: the tape's speed wandering a fraction of a percent, slow and never quite the same twice.
    private func setWow(_ amount: Float) {
        let wasOn = wowDepth > 0
        wowDepth = max(0, min(1, amount))
        if wowDepth == 0 {
            wowTimer?.cancel()
            wowTimer = nil
            varispeed.rate = 1
            varispeed.bypass = true
            return
        }
        varispeed.bypass = false
        guard !wasOn else { return }
        wowStart = now()
        guard !offline else { return }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in self?.stepWow() }
        timer.resume()
        wowTimer = timer
    }

    private func stepWow() {
        let t = now().timeIntervalSince(wowStart)
        let wander = 0.78 * sin(2 * .pi * 0.62 * t) + 0.22 * sin(2 * .pi * 1.73 * t + 1.1)
        varispeed.rate = Float(1 + 0.0028 * Double(wowDepth) * wander)
    }

    /// The parts a hold can move, as the mood sets them with the hold on top. Cheap enough to run
    /// every step of a ramp: no reverb preset reload, which would click.
    private func mix(_ p: DSPParams, _ h: Hold) {
        timePitch.pitch = max(-2400, min(2400, p.pitch + h.pitchOffset))
        // While a thrown echo rings out it keeps its own time and feedback; only the send was cut.
        let echo = h.echoMix > 0
        let ringing = !echo && now() < echoRingUntil ? echoRing : nil
        delay.delayTime = max(0.01, min(2.0, echo ? h.echoTime : ringing?.time ?? p.delayTime))
        delay.feedback = max(0, min(95, echo ? max(p.delayFeedback, h.echoFeedback) : ringing?.feedback ?? p.delayFeedback))
        send.outputVolume = max(0, min(1, max(p.delayMix, h.echoMix) / 100))
        let band = eq.bands[0]
        let cutoff = max(200, min(20_000, min(p.lowpass, h.lowpassCap)))
        band.bypass = cutoff >= 19_900
        band.frequency = cutoff
        engine.mainMixerNode.outputVolume = pow(10, max(-24, min(12, p.gain + h.gainBoost)) / 20)
    }

    /// Ramps what is held to `target` over `ms`: the Screw pad's pitch ride, the Trunk pad's
    /// filter, the Echo pad's echo. `Hold.none` lets go. A hold has to be refreshed within
    /// `holdLifetime` or it lets go by itself.
    func hold(_ target: Hold, ms: Int) {
        if Thread.isMainThread {
            startHold(target, ms: ms)
        } else {
            DispatchQueue.main.async { [weak self] in self?.startHold(target, ms: ms) }
        }
    }

    private func startHold(_ target: Hold, ms: Int) {
        // The same hold again is SLAB saying it's still down: keep it, and whatever ramp it's on.
        if target == holdTo, target != .none {
            armHoldWatch()
            return
        }
        holdFrom = holdNow
        holdTo = target
        // An echo coming in takes its time and feedback at once and only its level ramps.
        if target.echoMix > 0 {
            holdFrom.echoTime = target.echoTime
            holdFrom.echoFeedback = target.echoFeedback
        } else if holdFrom.echoMix > 0 {
            // Let go: the send is cut and what's in the echo rings out, until it's under -60 dB.
            let feedback = max(0.05, Double(holdFrom.echoFeedback) / 100)
            let seconds = min(8, max(1, holdFrom.echoTime * log(0.001) / log(feedback)))
            echoRing = (holdFrom.echoTime, holdFrom.echoFeedback)
            echoRingUntil = now().addingTimeInterval(seconds)
            if offline {
                echoRingPending = true
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + seconds + 0.05) { [weak self] in
                    guard let self, Date() >= self.echoRingUntil else { return }
                    self.mix(self.current, self.holdNow)
                }
            }
        }
        holdStart = now()
        holdSeconds = max(0, Double(ms) / 1000)
        holdRamping = true
        if holdTimer == nil, !offline {
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + .milliseconds(10), repeating: .milliseconds(10), leeway: .milliseconds(2))
            timer.setEventHandler { [weak self] in self?.stepHold() }
            timer.resume()
            holdTimer = timer
        }
        stepHold()
        armHoldWatch()
    }

    private func armHoldWatch() {
        holdWatch?.cancel()
        holdWatch = nil
        guard holdTo != .none, !offline else { return }
        let watch = DispatchSource.makeTimerSource(queue: .main)
        watch.schedule(deadline: .now() + Self.holdLifetime)
        watch.setEventHandler { [weak self] in
            slabLog("a hold went unrefreshed; letting go")
            self?.startHold(.none, ms: 300)
        }
        watch.resume()
        holdWatch = watch
    }

    private func stepHold() {
        let t = holdSeconds > 0 ? min(1, now().timeIntervalSince(holdStart) / holdSeconds) : 1
        let s = Float(t)
        var h = Hold.none
        h.pitchOffset = holdFrom.pitchOffset + (holdTo.pitchOffset - holdFrom.pitchOffset) * s
        // The filter sweeps evenly to the ear: in octaves, not hertz.
        h.lowpassCap = holdFrom.lowpassCap * pow(holdTo.lowpassCap / holdFrom.lowpassCap, s)
        h.gainBoost = holdFrom.gainBoost + (holdTo.gainBoost - holdFrom.gainBoost) * s
        h.echoMix = holdFrom.echoMix + (holdTo.echoMix - holdFrom.echoMix) * s
        // Going out, the echo keeps its time and feedback until it has faded away.
        let echoing = t < 1 && holdTo.echoMix == 0 ? holdFrom : holdTo
        h.echoTime = echoing.echoTime
        h.echoFeedback = echoing.echoFeedback
        holdNow = t >= 1 ? holdTo : h
        mix(current, holdNow)
        if t >= 1 {
            holdRamping = false
            holdTimer?.cancel()
            holdTimer = nil
        }
    }

    /// Something is held on top of the mood right now.
    var holding: Bool { holdNow != .none || holdTo != .none }

    static func preset(named name: String) -> AVAudioUnitReverbPreset {
        switch name {
        case "smallRoom": return .smallRoom
        case "mediumRoom": return .mediumRoom
        case "largeRoom": return .largeRoom
        case "mediumHall": return .mediumHall
        case "largeHall": return .largeHall
        case "plate": return .plate
        case "cathedral": return .cathedral
        case "mediumChamber": return .mediumChamber
        case "largeChamber": return .largeChamber
        default: return .largeHall2
        }
    }

    /// Transient tape-style spin-down: rate falls to near zero, holds, then winds back up.
    func tapeStop(downMs: Int, holdMs: Int, upMs: Int) {
        tapeToken += 1
        let token = tapeToken
        let down = max(80, downMs)
        let hold = max(0, holdMs)
        let up = max(80, upMs)
        let steps = 36
        let stepMs = down / steps
        let floor: Float = 0.03125
        tapeUntil = Date().addingTimeInterval(Double(down + hold + up) / 1000 + 0.05)
        catchUpRate = false

        DispatchQueue.main.async { [weak self] in
            guard let self, self.tapeToken == token else { return }
            for i in 1...steps {
                let curve = pow(Float(i) / Float(steps), 2.2)
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(stepMs * i)) {
                    guard self.tapeToken == token else { return }
                    self.timePitch.rate = 1.0 - (1.0 - floor) * curve
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(down + hold)) {
                guard self.tapeToken == token else { return }
                for i in 1...steps {
                    let curve = 1 - pow(1 - Float(i) / Float(steps), 2.2)
                    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(up * i / steps)) {
                        guard self.tapeToken == token else { return }
                        self.timePitch.rate = floor + (1.0 - floor) * curve
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(up)) {
                    guard self.tapeToken == token else { return }
                    self.timePitch.rate = 1.0
                }
            }
        }
    }

    var engineForRecording: AVAudioEngine { engine }

    var bufferFrames: Int { ring.framesAvailable }

    var droppedFrames: Int { ring.droppedFrames }

    var latencyMs: Double {
        Double(ring.lagFrames) / sampleRate * 1000
    }
}
