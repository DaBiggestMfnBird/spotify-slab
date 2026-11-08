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

    static let neutral = DSPParams()
}

final class DSPGraph {
    private let engine = AVAudioEngine()
    private let source: AVAudioSourceNode
    private let timePitch = AVAudioUnitTimePitch()
    private let reverb = AVAudioUnitReverb()
    private let delay = AVAudioUnitDelay()
    private let eq = AVAudioUnitEQ(numberOfBands: 1)
    private let ring: Deck
    /// Lines the output back up with Spotify after a chop, and closes any lag that left.
    private let steering = DispatchQueue(label: "com.slab.dsp.deck", qos: .userInitiated)
    private var steerTimer: DispatchSourceTimer?
    private var catchUpRate = false
    /// A tape stop owns the time-stretcher's rate until this moment.
    private var tapeUntil = Date.distantPast
    private let sampleRate: Double
    private(set) var isRunning = false
    private let paramsLock = NSLock()
    private var params = DSPParams.neutral
    private var tapeToken = 0

    /// Peak of the last render block, for the panel's level readout.
    nonisolated(unsafe) static var renderPeak: Float = 0

    init(ring: Deck, sampleRate: Double) {
        self.ring = ring
        self.sampleRate = sampleRate

        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2) else {
            fatalError("could not build audio format")
        }

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
        engine.attach(reverb)
        engine.attach(delay)
        engine.attach(eq)

        let band = eq.bands[0]
        band.filterType = .lowPass
        band.frequency = 20_000
        band.bypass = true
        band.bandwidth = 0.5

        engine.connect(source, to: timePitch, format: format)
        engine.connect(timePitch, to: eq, format: format)
        engine.connect(eq, to: reverb, format: format)
        engine.connect(reverb, to: delay, format: format)
        engine.connect(delay, to: engine.mainMixerNode, format: format)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)

        timePitch.rate = 1.0
        timePitch.pitch = 0
        timePitch.overlap = 8
        reverb.loadFactoryPreset(.largeHall2)
        reverb.wetDryMix = 0
        delay.delayTime = 0.36
        delay.feedback = 0
        delay.wetDryMix = 0
        delay.lowPassCutoff = 12_000
        engine.mainMixerNode.outputVolume = 1.0
    }

    func start() throws {
        guard !isRunning else { return }
        engine.prepare()
        try engine.start()
        isRunning = true
        // Capture runs while the engine is being prepared. Drop that backlog so
        // the first thing heard is current, not a second stale.
        ring.trim(keep: 1_024)
        startSteering()
    }

    func stop() {
        guard isRunning else { return }
        steerTimer?.cancel()
        steerTimer = nil
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
                if case .aligned(let lag) = self.ring.realign() {
                    slabLog("chop realigned, \(Int(Double(lag) / self.sampleRate * 1000)) ms behind live")
                }
            }
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
        timePitch.pitch = max(-2400, min(2400, p.pitch))
        reverb.loadFactoryPreset(Self.preset(named: p.reverbPreset))
        reverb.wetDryMix = max(0, min(100, p.reverb))
        delay.delayTime = max(0.01, min(2.0, p.delayTime))
        delay.feedback = max(0, min(95, p.delayFeedback))
        delay.wetDryMix = max(0, min(100, p.delayMix))
        let band = eq.bands[0]
        let cutoff = max(200, min(20_000, p.lowpass))
        band.bypass = cutoff >= 19_900
        band.frequency = cutoff
        engine.mainMixerNode.outputVolume = pow(10, max(-24, min(12, p.gain)) / 20)
    }

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
