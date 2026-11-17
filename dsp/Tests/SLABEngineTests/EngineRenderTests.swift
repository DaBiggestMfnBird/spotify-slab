import Foundation
import SLABCore
import SLABSound
import XCTest
@testable import SLABEngine

private let rate = 48_000.0

/// The deck fed the way Spotify's tap feeds it, the engine pulling from it, and what comes out.
private final class Rig {
    let deck = Deck(sampleRate: rate, reportsCuts: true)
    let engine: Engine
    private let signal: (Int) -> Float
    private(set) var fed = 0
    private(set) var left: [Float] = []
    private(set) var right: [Float] = []
    /// How many frames of the record the deck played in each 10 ms block.
    private(set) var consumed: [Int] = []
    private let outL = UnsafeMutablePointer<Float>.allocate(capacity: 480)
    private let outR = UnsafeMutablePointer<Float>.allocate(capacity: 480)

    init(_ params: DSPParams = .neutral, signal: @escaping (Int) -> Float) {
        engine = Engine(deck: deck, sampleRate: rate)
        engine.apply(params)
        self.signal = signal
        feed(2_048)
    }

    deinit {
        outL.deallocate()
        outR.deallocate()
    }

    /// Seconds rendered so far.
    var rendered: Double { Double(left.count) / rate }

    private func feed(_ frames: Int) {
        guard frames > 0 else { return }
        let samples = (0..<frames).map { signal(fed + $0) }
        samples.withUnsafeBufferPointer { p in deck.write(p.baseAddress!, p.baseAddress!, frames: frames) }
        fed += frames
    }

    /// Renders `seconds` more, 10 ms at a time, with the deck kept about 2,048 frames ahead, as the tap keeps it.
    func render(_ seconds: Double) {
        var remaining = Int((seconds * rate).rounded())
        while remaining > 0 {
            let frames = min(480, remaining)
            feed(2_048 + frames - deck.framesAvailable)
            let before = deck.framesAvailable
            engine.render(outL, outR, frames: frames)
            consumed.append(before - deck.framesAvailable)
            left.append(contentsOf: UnsafeBufferPointer(start: outL, count: frames))
            right.append(contentsOf: UnsafeBufferPointer(start: outR, count: frames))
            remaining -= frames
        }
    }

    /// One channel, from `from` to `to` seconds into the render.
    func window(_ from: Double, _ to: Double, right: Bool = false) -> [Float] {
        let channel = right ? self.right : left
        let a = Int(from * rate)
        let b = min(Int(to * rate), channel.count)
        return Array(channel[a..<b])
    }

    /// `count` frames of the left channel from frame `from`.
    func frames(_ from: Int, _ count: Int) -> [Float] {
        Array(left[from..<min(left.count, from + count)])
    }

    /// 40 ms of the left channel, starting 5 ms before frame `at` plus `seconds`.
    func part(at frame: Int, plus seconds: Double) -> [Float] {
        let a = frame + Int(seconds * rate) - Int(0.005 * rate)
        return Array(left[a..<min(left.count, a + Int(0.04 * rate))])
    }
}

// MARK: Signals

private func sine(_ hz: Double, _ amplitude: Float = 0.5) -> (Int) -> Float {
    { Float(sin(2 * .pi * hz * Double($0) / rate)) * amplitude }
}

private func tones(_ parts: [(hz: Double, amplitude: Float)]) -> (Int) -> Float {
    { frame in
        var sum: Float = 0
        for part in parts {
            let phase: Double = 2 * .pi * part.hz * Double(frame) / rate
            sum += Float(sin(phase)) * part.amplitude
        }
        return sum
    }
}

/// A 30 ms hit of a 1 kHz tone at each of `times` (seconds), silence between.
private func hits(at times: [Double], amplitude: Float = 0.5) -> (Int) -> Float {
    let length = Int(0.03 * rate)
    let starts = times.map { Int($0 * rate) }
    return { frame in
        for start in starts where frame >= start && frame < start + length {
            let k = Double(frame - start)
            let shape: Double = 0.5 - 0.5 * cos(2 * .pi * k / Double(length))
            let tone: Double = sin(2 * .pi * 1_000 * k / rate)
            return Float(shape * tone) * amplitude
        }
        return 0
    }
}

/// A record with a 1.5 kHz tone up to 2 s in and a 1 kHz tone after: where a chop lands is plain to hear.
private func twoSides(_ frame: Int) -> Float {
    let hz: Double = frame < Int(2 * rate) ? 1_500 : 1_000
    return Float(sin(2 * .pi * hz * Double(frame) / rate)) * 0.4
}

// MARK: Measures

private func rms(_ x: [Float]) -> Float {
    (x.reduce(Float(0)) { $0 + $1 * $1 } / Float(max(1, x.count))).squareRoot()
}

private func db(_ value: Float) -> Float { 20 * log10(max(value, 1e-12)) }

private func peak(_ x: [Float]) -> Float { x.map(abs).max() ?? 0 }

/// A steady tone's frequency: from its rising zero crossings, each placed between samples.
private func frequency(_ x: [Float]) -> Double {
    var crossings: [Double] = []
    for i in 1..<x.count where x[i - 1] < 0 && x[i] >= 0 {
        crossings.append(Double(i - 1) + Double(-x[i - 1] / (x[i] - x[i - 1])))
    }
    guard crossings.count > 1, let first = crossings.first, let last = crossings.last else { return 0 }
    return Double(crossings.count - 1) / ((last - first) / rate)
}

/// The amplitude of the part of `x` at `hz` (Goertzel; with `hann`, through a Hann window, for a
/// short stretch that needn't hold whole cycles).
private func level(_ x: [Float], at hz: Double, hann: Bool = false) -> Float {
    let c = 2 * cos(2 * .pi * hz / rate)
    var s1 = 0.0
    var s2 = 0.0
    var weight = 0.0
    for (i, v) in x.enumerated() {
        let w = hann ? 0.5 - 0.5 * cos(2 * .pi * (Double(i) + 0.5) / Double(x.count)) : 1
        weight += w
        let s = Double(v) * w + c * s1 - s2
        s2 = s1
        s1 = s
    }
    let power = max(0, s1 * s1 + s2 * s2 - c * s1 * s2)
    return Float(2 * power.squareRoot() / weight)
}

private func correlation(_ a: [Float], _ b: [Float]) -> Float {
    let ab = zip(a, b).reduce(Float(0)) { $0 + $1.0 * $1.1 }
    return ab / (rms(a) * rms(b) * Float(min(a.count, b.count)))
}

/// The first frame after `seconds` louder than `threshold`.
private func onset(_ x: [Float], after seconds: Double, above threshold: Float) -> Int? {
    let start = Int(seconds * rate)
    guard start < x.count else { return nil }
    return (start..<x.count).first { abs(x[$0]) > threshold }
}

/// Everything in `x` that isn't its 1 kHz tone, in dB under the tone.
private func grit(_ x: [Float]) -> Float {
    let tone = level(x, at: 1_000) / Float(2).squareRoot()
    let all = rms(x)
    return db(max(all * all - tone * tone, 1e-12).squareRoot()) - db(tone)
}

/// The portable engine, the sound the Windows helper plays Spotify through, rendered and measured
/// against the same numbers as the macOS helper's graph (GraphRenderTests), and on chops, against
/// the moment the deck makes them.
final class EngineRenderTests: XCTestCase {
    // MARK: Pitch

    func testNeutralLeavesTheRecordAlone() {
        let rig = Rig(signal: sine(1_000))
        rig.render(1.5)
        let out = rig.window(0.5, 1.5)
        XCTAssertEqual(frequency(out), 1_000, accuracy: 2)
        XCTAssertEqual(db(rms(out)), db(0.5 / Float(2).squareRoot()), accuracy: 1)
    }

    func testTheMoodsPitchRidesTheRecordDown() {
        var full = DSPParams.neutral
        full.pitch = -700
        let rig = Rig(full, signal: sine(1_000))
        rig.render(1.5)
        XCTAssertEqual(frequency(rig.window(0.5, 1.5)), 1_000 * pow(2, -700.0 / 1_200), accuracy: 5)
    }

    func testScrewRidesItDownWhileHeldAndBackWhenLetGo() {
        let rig = Rig(signal: sine(1_000))
        rig.render(0.5)
        rig.engine.hold(Hold(pitchOffset: -500), ms: 650)
        rig.render(1.5)
        rig.engine.hold(.none, ms: 220)
        rig.render(1.0)
        XCTAssertEqual(frequency(rig.window(1.5, 2.0)), 1_000 * pow(2, -500.0 / 1_200), accuracy: 5)
        XCTAssertEqual(frequency(rig.window(2.5, 3.0)), 1_000, accuracy: 5)
        let midway = frequency(rig.window(0.8, 0.86))
        XCTAssertLessThan(midway, 990)
        XCTAssertGreaterThan(midway, 760)
        XCTAssertFalse(rig.engine.holding, "let go and done ramping")
    }

    // MARK: Trunk

    func testTrunkKeepsTheLowEndInAndTheTopOut() {
        let rig = Rig(signal: tones([(100, 0.3), (3_000, 0.3)]))
        rig.render(1.0)
        rig.engine.hold(Hold(lowpassCap: 420, gainBoost: 3), ms: 90)
        rig.render(1.0)
        XCTAssertTrue(rig.engine.holding)
        let open = rig.window(0.5, 1.0)
        let shut = rig.window(1.5, 2.0)
        XCTAssertLessThan(db(level(shut, at: 3_000)) - db(level(open, at: 3_000)), -20)
        XCTAssertEqual(db(level(shut, at: 100)) - db(level(open, at: 100)), 3, accuracy: 1.5)
    }

    // MARK: Echo

    private let echo = Hold(echoMix: 38, echoFeedback: 48, echoTime: 60.0 / 140)

    func testEchoRepeatsOnTheBeatWithoutDoublingTheHit() throws {
        let dry = Rig(signal: hits(at: [0.6]))
        dry.render(2.0)
        let wet = Rig(signal: hits(at: [0.6]))
        wet.engine.hold(echo, ms: 40)
        wet.render(2.0)

        let start = try XCTUnwrap(onset(dry.left, after: 0.5, above: 0.01))
        let wetStart = try XCTUnwrap(onset(wet.left, after: 0.5, above: 0.01))
        XCTAssertEqual(Double(wetStart), Double(start), accuracy: 2)
        let beat = echo.echoTime
        XCTAssertEqual(db(rms(wet.part(at: start, plus: 0))), db(rms(dry.part(at: start, plus: 0))), accuracy: 0.5)
        XCTAssertLessThan(db(rms(dry.part(at: start, plus: beat))) - db(rms(dry.part(at: start, plus: 0))), -60)
        let first = db(rms(wet.part(at: start, plus: beat))) - db(rms(wet.part(at: start, plus: 0)))
        let second = db(rms(wet.part(at: start, plus: 2 * beat))) - db(rms(wet.part(at: start, plus: beat)))
        XCTAssertEqual(first, -8.4, accuracy: 2)
        XCTAssertEqual(second, -6.4, accuracy: 2)
    }

    func testAThrownEchoRingsOutAfterTheSendIsCut() throws {
        let beat = echo.echoTime
        let rig = Rig(signal: hits(at: [0.6, 2.0]))
        rig.engine.hold(echo, ms: 40)
        rig.render(0.5)
        while onset(rig.left, after: 0.5, above: 0.01) == nil, rig.rendered < 1.5 { rig.render(0.01) }
        let start = try XCTUnwrap(onset(rig.left, after: 0.5, above: 0.01))
        rig.render(0.05)
        rig.engine.hold(.none, ms: 60)
        rig.render(3.2 - rig.rendered)

        let hit = db(rms(rig.part(at: start, plus: 0)))
        let first = db(rms(rig.part(at: start, plus: beat))) - hit
        let second = db(rms(rig.part(at: start, plus: 2 * beat))) - db(rms(rig.part(at: start, plus: beat)))
        XCTAssertEqual(first, -8.4, accuracy: 2)
        XCTAssertEqual(second, -6.4, accuracy: 2)
        let later = start + Int(1.4 * rate)
        XCTAssertGreaterThan(db(rms(rig.part(at: later, plus: 0))), hit - 1, "the second hit is heard")
        XCTAssertLessThan(db(rms(rig.part(at: later, plus: beat))) - hit, -30)
    }

    // MARK: Tape

    func testWowWandersTheTapeSpeedAFractionOfAPercent() {
        var worn = DSPParams.neutral
        worn.wow = 1
        let rig = Rig(worn, signal: sine(1_000))
        rig.render(4.0)
        let speeds = stride(from: 0.5, to: 3.7, by: 0.05).map { frequency(rig.window($0, $0 + 0.05)) / 1_000 }
        let swing = ((speeds.max() ?? 0) - (speeds.min() ?? 0)) / 2
        XCTAssertGreaterThan(swing, 0.0015)
        XCTAssertLessThan(swing, 0.0045)
    }

    func testWithoutWowTheSpeedHolds() {
        let rig = Rig(signal: sine(1_000))
        rig.render(2.0)
        let speeds = stride(from: 0.5, to: 1.9, by: 0.05).map { frequency(rig.window($0, $0 + 0.05)) / 1_000 }
        XCTAssertLessThan(((speeds.max() ?? 0) - (speeds.min() ?? 0)) / 2, 0.0003)
    }

    func testHissSitsUnderTheRecordOnEachSide() {
        var tape = DSPParams.neutral
        tape.hiss = 1
        let rig = Rig(tape, signal: { _ in 0 })
        rig.render(2.0)
        let l = rig.window(0.5, 2.0)
        let r = rig.window(0.5, 2.0, right: true)
        for side in [l, r] {
            XCTAssertGreaterThan(rms(side), 0.0008)
            XCTAssertLessThan(rms(side), 0.006)
        }
        XCTAssertLessThan(abs(correlation(l, r)), 0.2, "a cassette's hiss is its own on each side")
    }

    func testCrushCrunchesTheRecord() {
        let clean = Rig(signal: sine(1_000))
        clean.render(1.0)
        var lofi = DSPParams.neutral
        lofi.crush = 1
        let crushed = Rig(lofi, signal: sine(1_000))
        crushed.render(1.0)
        XCTAssertGreaterThan(grit(crushed.window(0.5, 1.0)) - grit(clean.window(0.5, 1.0)), 15)
    }

    func testATapeStopSlowsTheRecordToAlmostNothingAndWindsItBack() {
        let rig = Rig(signal: sine(1_000))
        rig.render(0.5)
        let before = rig.consumed.count
        rig.engine.tapeStop(downMs: 420, holdMs: 300, upMs: 260)
        rig.render(1.5)
        // From 450 to 700 ms in, it sits at its floor: a thirty-second of the record a frame.
        let floor = rig.consumed[(before + 45)..<(before + 70)]
        let speed = Double(floor.reduce(0, +)) / Double(floor.count * 480)
        XCTAssertEqual(speed, 1.0 / 32, accuracy: 0.01)
        // Slowing down, the tone keeps its pitch: the stretcher has the speed, not the tape's motor.
        XCTAssertEqual(frequency(rig.window(1.0, 1.1)), 1_000, accuracy: 10)
        XCTAssertEqual(rig.consumed.last, 480, "back up to speed")
    }

    // MARK: Rooms

    func testEveryRoomComesBackAboutAsLoudAsItWentIn() {
        // Noise with music's tilt: most of its energy low.
        var seed: UInt64 = 0x5EED
        var smooth: Float = 0
        let noise: [Float] = (0..<Int(rate * 3)).map { _ in
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            let white = Float(Int64(bitPattern: seed) >> 40) / Float(1 << 23)
            smooth += 0.15 * (white - smooth)
            return smooth * 0.3
        }
        let input = rms(Array(noise[Int(rate)...]))
        for room in ["largeHall2", "smallRoom", "mediumRoom", "largeRoom", "mediumHall", "largeHall", "plate",
                     "cathedral", "mediumChamber", "largeChamber"] {
            var wet = DSPParams.neutral
            wet.reverb = 100
            wet.reverbPreset = room
            let rig = Rig(wet, signal: { noise[$0 % noise.count] })
            rig.render(3.0)
            XCTAssertEqual(db(rms(rig.window(1.2, 3.0))), db(input), accuracy: 4, room)
        }
        XCTAssertEqual(Engine.room(named: "cathedral"), Int(SLAB_ROOM_CATHEDRAL))
        XCTAssertEqual(Engine.room(named: "nothing like it"), Int(SLAB_ROOM_LARGE_HALL_2), "an unknown room is the default")
    }

    // MARK: All of it

    func testFullScrewStaysCleanAndAtLevel() {
        var full = DSPParams.neutral
        full.pitch = -700
        full.reverb = 16
        full.reverbPreset = "largeRoom"
        full.lowpass = 8_000
        full.wow = 1
        let record = tones([(55, 0.25), (110, 0.15), (440, 0.08), (1_320, 0.05), (2_640, 0.03)])
        let rig = Rig(full, signal: record)
        rig.render(3.0)
        let out = rig.window(1.0, 3.0)
        let input = (Int(1.0 * rate)..<Int(3.0 * rate)).map(record)
        XCTAssertLessThan(peak(out), 0.95, "no clipping")
        XCTAssertEqual(db(rms(out)), db(rms(input)), accuracy: 3)
    }

    // MARK: Chops

    /// What is heard trails the deck by the stretcher's lead, and the panel is told the whole of it.
    func testTheLatencyCountsTheStretchersLead() {
        let rig = Rig(signal: sine(1_000))
        rig.render(0.5)
        XCTAssertEqual(rig.engine.leadFrames, 5_760, "120 ms at 48 kHz")
        XCTAssertEqual(rig.engine.latencyMs, Double(rig.deck.lagFrames + 5_760) / rate * 1_000, accuracy: 0.01)
    }

    /// The deck plays the 1 kHz side; a chop sends it back to the 1.5 kHz side. Returns the rig and
    /// the frame the chop fires on, and where on the record what is heard right after it comes from.
    private func chop(pitch: Float) throws -> (rig: Rig, at: Int, landing: Int) {
        var mood = DSPParams.neutral
        mood.pitch = pitch
        let rig = Rig(mood, signal: twoSides)
        rig.render(3.0)
        let at = rig.left.count + 9_600
        let lead = rig.engine.leadFrames
        // Fired 200 ms from now, two seconds back.
        try rig.deck.scheduleJump(backFrames: 96_000, inFrames: 9_600, seekAheadFrames: 0, availableFrames: 144_000)
        rig.render(0.5)
        // The deck plays the record one frame per frame, so it is at `at` when the chop fires; what is
        // heard trails it by the lead.
        return (rig, at, at - 96_000 - lead)
    }

    func testAChopIsHeardTheMomentTheDeckMakesIt() throws {
        let shift = pow(2, -500.0 / 1_200)
        let (rig, at, _) = try chop(pitch: -500)
        let oldHz = 1_000 * shift
        let newHz = 1_500 * shift
        let span = Int(0.02 * rate)
        // Up to the chop, the record as it was, with nothing of where it's going in it.
        let before = rig.frames(at - span - Int(0.005 * rate), span)
        XCTAssertLessThan(db(level(before, at: newHz, hann: true)) - db(level(before, at: oldHz, hann: true)), -40)
        // Through the 6 ms crossfade and it's only where it went: not 120 ms later, and nothing left over.
        let after = rig.frames(at + rig.deck.fadeFrames + Int(0.005 * rate), span)
        XCTAssertLessThan(db(level(after, at: oldHz, hann: true)) - db(level(after, at: newHz, hann: true)), -40)
        XCTAssertEqual(db(level(after, at: newHz, hann: true)), db(0.4), accuracy: 1, "at full level at once")
    }

    func testAChopLandsExactlyWhereItWasSent() throws {
        let (rig, at, landing) = try chop(pitch: 0)
        let heard = rig.frames(at + 400, 4_800)
        let record = (0..<4_800).map { twoSides(landing + 400 + $0) }
        XCTAssertGreaterThan(correlation(heard, record), 0.9999)
    }

    func testASpinLandsCleanOutOfItsOwnSilence() throws {
        var mood = DSPParams.neutral
        mood.pitch = -500
        let rig = Rig(mood, signal: twoSides)
        rig.render(3.0)
        let spin = 14_400
        let at = rig.left.count + spin
        try rig.deck.scheduleSpin(backFrames: 96_000, spinFrames: spin, seekAheadFrames: 0, availableFrames: 144_000)
        rig.render(0.6)
        let newHz = 1_500 * pow(2, -500.0 / 1_200)
        let after = rig.frames(at + rig.deck.fadeFrames + Int(0.005 * rate), Int(0.02 * rate))
        XCTAssertEqual(db(level(after, at: newHz, hann: true)), db(0.4), accuracy: 1)
        XCTAssertLessThan(db(level(after, at: 1_000 * pow(2, -500.0 / 1_200), hann: true)) - db(0.4), -40)
    }
}
