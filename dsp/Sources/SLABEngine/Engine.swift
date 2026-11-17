import Dispatch
import Foundation
import SLABCore
import SLABSound

/// The helper's sound, portable: the deck, the tape's color, then SLABSound's pitch, low-pass,
/// room, echo and trim. What the Windows helper plays Spotify through, the same chain the macOS
/// helper builds from AVAudioEngine nodes.
///
/// Rendering is pulled by one audio thread through `render`; everything else may be called from any
/// thread. The deck should report its cuts (`Deck(reportsCuts: true)`): the engine joins them
/// itself, so a chop is heard the moment the deck makes it rather than a stretcher's lead later.
public final class Engine: @unchecked Sendable {
    public let deck: Deck
    public let sampleRate: Double

    /// Called on the steering queue when a chop finds Spotify again, with how far behind live it rejoined.
    public var onRealign: ((Int) -> Void)?

    private let sound: OpaquePointer
    private let color: TapeColor
    /// The tape's color for what a cut reads from memory, so the moments either side of one have it too.
    private let sideColor: TapeColor
    private let paramsLock = NSLock()
    private var params = DSPParams.neutral

    private let steering = DispatchQueue(label: "com.slab.engine.deck", qos: .userInitiated)
    private var steerTimer: DispatchSourceTimer?

    // The audio thread's, allocated up front so rendering never allocates.
    private static let maxBlock = 512
    private static let maxCuts = 8
    private let inputCapacity: Int
    private let inL: UnsafeMutablePointer<Float>
    private let inR: UnsafeMutablePointer<Float>
    private var cuts: [Deck.Cut] = []
    private let orders: UnsafeMutablePointer<SlabCut>
    private let tailCapacity: Int
    private let tails: UnsafeMutablePointer<Float>
    private let rollCapacity: Int
    private let rolls: UnsafeMutablePointer<Float>
    private var peak: Float = 0

    /// `blockMs` is the stretcher's window: longer holds the bass together, and is how far ahead of
    /// what is heard it reads.
    public init(deck: Deck, sampleRate: Double, blockMs: Double = 120, intervalMs: Double = 30) {
        self.deck = deck
        self.sampleRate = sampleRate
        guard let sound = slab_sound_create(sampleRate, blockMs, intervalMs, Int32(deck.fadeFrames)) else {
            fatalError("could not build the sound engine at \(sampleRate) Hz")
        }
        self.sound = sound
        color = TapeColor(sampleRate: sampleRate)
        sideColor = TapeColor(sampleRate: sampleRate, seed: 0x5EED_C075)

        // The tape never runs faster than catch-up and wow together, well under twice speed.
        let inputCapacity = Self.maxBlock * 2 + 8
        self.inputCapacity = inputCapacity
        inL = Self.zeros(inputCapacity)
        inR = Self.zeros(inputCapacity)
        let orders = UnsafeMutablePointer<SlabCut>.allocate(capacity: Self.maxCuts)
        orders.initialize(repeating: SlabCut(), count: Self.maxCuts)
        self.orders = orders
        let tailCapacity = deck.fadeFrames * 2 + 8
        self.tailCapacity = tailCapacity
        tails = Self.zeros(Self.maxCuts * 2 * tailCapacity)
        // A cut's new sound is the stretcher's lead of it, a little more at catch-up speed.
        let rollCapacity = Int(slab_sound_latency(sound)) * 2 + 8
        self.rollCapacity = rollCapacity
        rolls = Self.zeros(Self.maxCuts * 2 * rollCapacity)
        cuts.reserveCapacity(Self.maxCuts)
    }

    private static func zeros(_ count: Int) -> UnsafeMutablePointer<Float> {
        let p = UnsafeMutablePointer<Float>.allocate(capacity: count)
        p.initialize(repeating: 0, count: count)
        return p
    }

    deinit {
        steerTimer?.cancel()
        slab_sound_destroy(sound)
        inL.deallocate()
        inR.deallocate()
        orders.deallocate()
        tails.deallocate()
        rolls.deallocate()
    }

    // MARK: Running

    /// Live use: drops the backlog capture built up while the output was being set up, so the first
    /// thing heard is current, and starts steering the deck back onto Spotify after each chop.
    public func start() {
        deck.trim(keep: 1_024)
        guard steerTimer == nil else { return }
        // Every 25 ms: while the deck plays from memory, look for Spotify's re-seeked audio. Once it
        // is back but further behind live than usual, the deck says so and `render` runs the tape
        // 4% fast until the gap is closed, pitch unchanged.
        let timer = DispatchSource.makeTimerSource(queue: steering)
        timer.schedule(deadline: .now() + .milliseconds(25), repeating: .milliseconds(25), leeway: .milliseconds(5))
        timer.setEventHandler { [weak self] in
            guard let self, self.deck.isDetached else { return }
            if case .aligned(let lag) = self.deck.realign() { self.onRealign?(lag) }
        }
        timer.resume()
        steerTimer = timer
    }

    public func stop() {
        steerTimer?.cancel()
        steerTimer = nil
    }

    // MARK: Settings

    public var current: DSPParams {
        paramsLock.lock()
        defer { paramsLock.unlock() }
        return params
    }

    public func apply(_ new: DSPParams) {
        paramsLock.lock()
        params = new
        paramsLock.unlock()
        let tape = TapeColor.Settings(hiss: new.hiss, crackle: new.crackle, crush: new.crush)
        color.set(tape)
        sideColor.set(tape)
        slab_sound_set_mood(sound, Self.mood(new))
    }

    /// Ramps what is held to `target` over `ms`: the Screw pad's pitch ride, the Trunk pad's filter,
    /// the Echo pad's echo. `Hold.none` lets go. A hold has to be refreshed within 10 s or it lets go
    /// by itself.
    public func hold(_ target: Hold, ms: Int) {
        let h = SlabHold(
            pitchOffset: target.pitchOffset, lowpassCap: target.lowpassCap, gainBoost: target.gainBoost,
            echoMix: target.echoMix, echoFeedback: target.echoFeedback, echoTime: target.echoTime
        )
        slab_sound_hold(sound, h, Int32(clamping: ms))
    }

    /// The tape slows to almost nothing, holds, then winds back up.
    public func tapeStop(downMs: Int, holdMs: Int, upMs: Int) {
        slab_sound_tape_stop(sound, Int32(clamping: downMs), Int32(clamping: holdMs), Int32(clamping: upMs))
    }

    /// Something is held on top of the mood right now.
    public var holding: Bool { slab_sound_holding(sound) != 0 }

    /// How far behind the deck what is heard is, in frames: the stretcher reads this far ahead.
    public var leadFrames: Int { Int(slab_sound_latency(sound)) }

    /// How far behind live what is heard is, in milliseconds: the deck's lag and the stretcher's lead.
    public var latencyMs: Double { Double(deck.lagFrames + leadFrames) / sampleRate * 1000 }

    /// The loudest sample the deck has played since `resetLevel`, for the panel's level readout.
    public var level: Float { peak }

    public func resetLevel() { peak = 0 }

    static func mood(_ p: DSPParams) -> SlabMood {
        SlabMood(
            pitch: p.pitch, reverb: p.reverb, reverbPreset: Int32(room(named: p.reverbPreset)),
            delayTime: p.delayTime, delayFeedback: p.delayFeedback, delayMix: p.delayMix,
            lowpass: p.lowpass, gain: p.gain, wow: p.wow
        )
    }

    static func room(named name: String) -> Int {
        switch name {
        case "smallRoom": return Int(SLAB_ROOM_SMALL_ROOM)
        case "mediumRoom": return Int(SLAB_ROOM_MEDIUM_ROOM)
        case "largeRoom": return Int(SLAB_ROOM_LARGE_ROOM)
        case "mediumHall": return Int(SLAB_ROOM_MEDIUM_HALL)
        case "largeHall": return Int(SLAB_ROOM_LARGE_HALL)
        case "plate": return Int(SLAB_ROOM_PLATE)
        case "cathedral": return Int(SLAB_ROOM_CATHEDRAL)
        case "mediumChamber": return Int(SLAB_ROOM_MEDIUM_CHAMBER)
        case "largeChamber": return Int(SLAB_ROOM_LARGE_CHAMBER)
        default: return Int(SLAB_ROOM_LARGE_HALL_2)
        }
    }

    // MARK: Rendering

    /// Fills `frames` of stereo output. Audio thread only.
    public func render(_ outL: UnsafeMutablePointer<Float>, _ outR: UnsafeMutablePointer<Float>, frames: Int) {
        var done = 0
        while done < frames {
            let n = min(Self.maxBlock, frames - done)
            let wanted = Int(slab_sound_begin(sound, Int32(n), deck.catchingUp ? 1 : 0))
            precondition(wanted <= inputCapacity, "the tape ran at \(Double(wanted) / Double(n))x")
            deck.read(into: inL, inR, frames: wanted, cuts: &cuts)
            color.process(inL, inR, frames: wanted)
            for i in 0..<wanted {
                let v = abs(inL[i])
                if v > peak { peak = v }
            }
            let count = min(cuts.count, Self.maxCuts)
            if count > 0 { prepare(count) }
            slab_sound_render(sound, inL, inR, orders, Int32(count), outL + done, outR + done)
            done += n
        }
    }

    /// For each cut, the old sound carrying on past it and the new sound from where it is heard first,
    /// out of the deck's memory, with the tape's color on them as on everything else.
    private func prepare(_ count: Int) {
        let tail = min(Int(slab_sound_tail_frames(sound)), tailCapacity)
        let roll = min(Int(slab_sound_roll_frames(sound)), rollCapacity)
        for i in 0..<count {
            let cut = cuts[i]
            let tl = tails + i * 2 * tailCapacity
            let tr = tl + tailCapacity
            let rl = rolls + i * 2 * rollCapacity
            let rr = rl + rollCapacity
            var hasTail = false
            if let from = cut.from {
                deck.recall(from: from, count: tail, into: tl, tr)
                sideColor.process(tl, tr, frames: tail)
                hasTail = true
            }
            deck.recall(from: cut.to - roll, count: roll, notBefore: cut.start, into: rl, rr)
            sideColor.process(rl, rr, frames: roll)
            orders[i] = SlabCut(
                frame: Int32(cut.frame),
                tailLeft: hasTail ? UnsafePointer(tl) : nil,
                tailRight: hasTail ? UnsafePointer(tr) : nil,
                rollLeft: UnsafePointer(rl),
                rollRight: UnsafePointer(rr)
            )
        }
    }
}
