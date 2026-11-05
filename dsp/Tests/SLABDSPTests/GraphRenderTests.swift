import AVFoundation
import SLABCore
import XCTest
@testable import SLABDSP

private let rate = 48_000.0

private enum RigError: Error {
    case noBuffer
    case render(Int)
}

/// The deck feeding the graph the way Spotify's tap feeds it, and what comes out of the other end.
private final class Rig {
    let deck = Deck(sampleRate: rate)
    let graph: DSPGraph
    private let buffer: AVAudioPCMBuffer
    private let signal: (Int) -> Float
    private var fed = 0
    private(set) var left: [Float] = []
    private(set) var right: [Float] = []

    init(_ params: DSPParams = .neutral, signal: @escaping (Int) -> Float) throws {
        graph = DSPGraph(ring: deck, sampleRate: rate, offline: true)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: graph.renderFormat, frameCapacity: 4_096) else { throw RigError.noBuffer }
        self.buffer = buffer
        self.signal = signal
        graph.prepare(params)
        feed(2_048)
        try graph.start()
    }

    /// Seconds rendered so far.
    var rendered: Double { Double(left.count) / rate }

    private func feed(_ frames: Int) {
        guard frames > 0 else { return }
        let samples = (0..<frames).map { signal(fed + $0) }
        samples.withUnsafeBufferPointer { p in deck.write(p.baseAddress!, p.baseAddress!, frames: frames) }
        fed += frames
    }

    /// Renders `seconds` more, 10 ms at a time (the step the live timers run on), with the deck
    /// kept about 2,048 frames ahead, as the tap keeps it.
    func render(_ seconds: Double) throws {
        var remaining = Int((seconds * rate).rounded())
        while remaining > 0 {
            let frames = min(480, remaining)
            feed(2_048 + frames - deck.framesAvailable)
            let status = try graph.renderOffline(frames, into: buffer)
            guard status == .success else { throw RigError.render(status.rawValue) }
            guard let data = buffer.floatChannelData else { throw RigError.noBuffer }
            left.append(contentsOf: UnsafeBufferPointer(start: data[0], count: frames))
            right.append(contentsOf: UnsafeBufferPointer(start: data[1], count: frames))
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

/// The amplitude of the part of `x` at `hz` (Goertzel; `x` should hold whole cycles of it).
private func level(_ x: [Float], at hz: Double) -> Float {
    let c = 2 * cos(2 * .pi * hz / rate)
    var s1 = 0.0
    var s2 = 0.0
    for v in x {
        let s = Double(v) + c * s1 - s2
        s2 = s1
        s1 = s
    }
    let power = max(0, s1 * s1 + s2 * s2 - c * s1 * s2)
    return Float(2 * power.squareRoot() / Double(x.count))
}

private func correlation(_ a: [Float], _ b: [Float]) -> Float {
    let ab = zip(a, b).reduce(Float(0)) { $0 + $1.0 * $1.1 }
    return ab / (rms(a) * rms(b) * Float(a.count))
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

/// The helper's own audio graph, the nodes SLAB DSP plays Spotify through, rendered offline on the
/// runner and measured: what a mood, a pad or the tape does to real audio, in numbers.
final class GraphRenderTests: XCTestCase {
    // MARK: Pitch

    func testNeutralLeavesTheRecordAlone() throws {
        let rig = try Rig(signal: sine(1_000))
        try rig.render(1.5)
        let out = rig.window(0.5, 1.5)
        XCTAssertEqual(frequency(out), 1_000, accuracy: 2)
        XCTAssertEqual(db(rms(out)), db(0.5 / Float(2).squareRoot()), accuracy: 1)
    }

    func testTheMoodsPitchRidesTheRecordDown() throws {
        // DJ mode's full screw: seven semitones down.
        var full = DSPParams.neutral
        full.pitch = -700
        let rig = try Rig(full, signal: sine(1_000))
        try rig.render(1.5)
        XCTAssertEqual(frequency(rig.window(0.5, 1.5)), 1_000 * pow(2, -700.0 / 1_200), accuracy: 5)
    }

    func testScrewRidesItDownWhileHeldAndBackWhenLetGo() throws {
        let rig = try Rig(signal: sine(1_000))
        try rig.render(0.5)
        // The Screw pad as SLAB sends it: 500 cents down, ridden in over 650 ms, back over 220.
        rig.graph.hold(Hold(pitchOffset: -500), ms: 650)
        try rig.render(1.5)
        rig.graph.hold(.none, ms: 220)
        try rig.render(1.0)
        XCTAssertEqual(frequency(rig.window(1.5, 2.0)), 1_000 * pow(2, -500.0 / 1_200), accuracy: 5)
        XCTAssertEqual(frequency(rig.window(2.5, 3.0)), 1_000, accuracy: 5)
        // It rides down rather than stepping: half way through the ride it's in between.
        let midway = frequency(rig.window(0.8, 0.86))
        XCTAssertLessThan(midway, 990)
        XCTAssertGreaterThan(midway, 760)
    }

    // MARK: Trunk

    func testTrunkKeepsTheLowEndInAndTheTopOut() throws {
        let rig = try Rig(signal: tones([(100, 0.3), (3_000, 0.3)]))
        try rig.render(1.0)
        // The Trunk pad as SLAB sends it: nothing through past 420 Hz, and 3 dB back for what it keeps in.
        rig.graph.hold(Hold(lowpassCap: 420, gainBoost: 3), ms: 90)
        try rig.render(1.0)
        let open = rig.window(0.5, 1.0)
        let shut = rig.window(1.5, 2.0)
        XCTAssertLessThan(db(level(shut, at: 3_000)) - db(level(open, at: 3_000)), -20)
        XCTAssertEqual(db(level(shut, at: 100)) - db(level(open, at: 100)), 3, accuracy: 1.5)
    }

    // MARK: Echo

    /// The Echo pad as SLAB sends it on a 140 BPM record: 38% into the echo, 48% feedback, on the beat.
    private let echo = Hold(echoMix: 38, echoFeedback: 48, echoTime: 60.0 / 140)

    func testEchoRepeatsOnTheBeatWithoutDoublingTheHit() throws {
        let dry = try Rig(signal: hits(at: [0.6]))
        try dry.render(2.0)
        let wet = try Rig(signal: hits(at: [0.6]))
        wet.graph.hold(echo, ms: 40)
        try wet.render(2.0)

        let start = try XCTUnwrap(onset(dry.left, after: 0.5, above: 0.01))
        let wetStart = try XCTUnwrap(onset(wet.left, after: 0.5, above: 0.01))
        XCTAssertEqual(Double(wetStart), Double(start), accuracy: 2)
        let beat = echo.echoTime
        // The hit is the same with the echo on: the echo is a send, so it adds repeats and leaves the
        // hit alone. Not doubled, and not gone.
        XCTAssertEqual(db(rms(wet.part(at: start, plus: 0))), db(rms(dry.part(at: start, plus: 0))), accuracy: 0.5)
        // With no echo held, nothing comes after it.
        XCTAssertLessThan(db(rms(dry.part(at: start, plus: beat))) - db(rms(dry.part(at: start, plus: 0))), -60)
        // Held: a repeat a beat later at the send's level (38%, -8.4 dB), the next 48% of that (-6.4 dB).
        let first = db(rms(wet.part(at: start, plus: beat))) - db(rms(wet.part(at: start, plus: 0)))
        let second = db(rms(wet.part(at: start, plus: 2 * beat))) - db(rms(wet.part(at: start, plus: beat)))
        XCTAssertEqual(first, -8.4, accuracy: 2)
        XCTAssertEqual(second, -6.4, accuracy: 2)
    }

    func testAThrownEchoRingsOutAfterTheSendIsCut() throws {
        // Two hits, the echo thrown between them: the first rings on, the second goes out dry.
        let beat = echo.echoTime
        let rig = try Rig(signal: hits(at: [0.6, 2.0]))
        rig.graph.hold(echo, ms: 40)
        try rig.render(0.5)
        while onset(rig.left, after: 0.5, above: 0.01) == nil, rig.rendered < 1.5 { try rig.render(0.01) }
        let start = try XCTUnwrap(onset(rig.left, after: 0.5, above: 0.01))
        // Once the hit is in the echo, let go: SLAB throws it in 60 ms.
        try rig.render(0.05)
        rig.graph.hold(.none, ms: 60)
        try rig.render(3.2 - rig.rendered)

        let hit = db(rms(rig.part(at: start, plus: 0)))
        let first = db(rms(rig.part(at: start, plus: beat))) - hit
        let second = db(rms(rig.part(at: start, plus: 2 * beat))) - db(rms(rig.part(at: start, plus: beat)))
        // The first hit's repeats ring on at the echo's own time and feedback.
        XCTAssertEqual(first, -8.4, accuracy: 2)
        XCTAssertEqual(second, -6.4, accuracy: 2)
        // The second hit sends nothing into it: a beat after it, there's nothing of its own.
        let later = start + Int(1.4 * rate)
        XCTAssertGreaterThan(db(rms(rig.part(at: later, plus: 0))), hit - 1, "the second hit is heard")
        XCTAssertLessThan(db(rms(rig.part(at: later, plus: beat))) - hit, -30)
    }

    // MARK: Tape

    func testWowWandersTheTapeSpeedAFractionOfAPercent() throws {
        var worn = DSPParams.neutral
        worn.wow = 1
        let rig = try Rig(worn, signal: sine(1_000))
        try rig.render(4.0)
        let speeds = stride(from: 0.5, to: 3.7, by: 0.05).map { frequency(rig.window($0, $0 + 0.05)) / 1_000 }
        let swing = ((speeds.max() ?? 0) - (speeds.min() ?? 0)) / 2
        // Designed for ±0.28%, a worn cassette's speed, heard as a slow warble.
        XCTAssertGreaterThan(swing, 0.0015)
        XCTAssertLessThan(swing, 0.0045)
    }

    func testWithoutWowTheSpeedHolds() throws {
        let rig = try Rig(signal: sine(1_000))
        try rig.render(2.0)
        let speeds = stride(from: 0.5, to: 1.9, by: 0.05).map { frequency(rig.window($0, $0 + 0.05)) / 1_000 }
        XCTAssertLessThan(((speeds.max() ?? 0) - (speeds.min() ?? 0)) / 2, 0.0003)
    }

    func testHissSitsUnderTheRecordOnEachSide() throws {
        var tape = DSPParams.neutral
        tape.hiss = 1
        let rig = try Rig(tape, signal: { _ in 0 })
        try rig.render(2.0)
        let l = rig.window(0.5, 2.0)
        let r = rig.window(0.5, 2.0, right: true)
        for side in [l, r] {
            XCTAssertGreaterThan(rms(side), 0.0008)
            XCTAssertLessThan(rms(side), 0.006)
        }
        XCTAssertLessThan(abs(correlation(l, r)), 0.2, "a cassette's hiss is its own on each side")
    }

    func testCrushCrunchesTheRecord() throws {
        let clean = try Rig(signal: sine(1_000))
        try clean.render(1.0)
        var lofi = DSPParams.neutral
        lofi.crush = 1
        let crushed = try Rig(lofi, signal: sine(1_000))
        try crushed.render(1.0)
        XCTAssertGreaterThan(grit(crushed.window(0.5, 1.0)) - grit(clean.window(0.5, 1.0)), 15)
    }

    // MARK: All of it

    func testFullScrewStaysCleanAndAtLevel() throws {
        // DJ mode's full screw: the Screwed mood seven semitones down, on worn tape.
        var full = DSPParams.neutral
        full.pitch = -700
        full.reverb = 16
        full.reverbPreset = "largeRoom"
        full.lowpass = 8_000
        full.wow = 1
        let record = tones([(55, 0.25), (110, 0.15), (440, 0.08), (1_320, 0.05), (2_640, 0.03)])
        let rig = try Rig(full, signal: record)
        try rig.render(3.0)
        let out = rig.window(1.0, 3.0)
        let input = (Int(1.0 * rate)..<Int(3.0 * rate)).map(record)
        XCTAssertLessThan(peak(out), 0.95, "no clipping")
        XCTAssertEqual(db(rms(out)), db(rms(input)), accuracy: 3)
    }
}
