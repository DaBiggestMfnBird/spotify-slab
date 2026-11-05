import XCTest
@testable import SLABCore

final class TapeColorTests: XCTestCase {
    private let rate = 48_000.0

    private func run(_ settings: TapeColor.Settings, seconds: Double, input: (Int) -> Float = { _ in 0 }) -> ([Float], [Float]) {
        let color = TapeColor(sampleRate: rate)
        color.set(settings)
        let frames = Int(rate * seconds)
        var l = (0..<frames).map(input)
        var r = l
        // In render-sized blocks, as the audio thread hands them over.
        var at = 0
        while at < frames {
            let n = min(512, frames - at)
            l.withUnsafeMutableBufferPointer { lp in
                r.withUnsafeMutableBufferPointer { rp in
                    color.process(lp.baseAddress! + at, rp.baseAddress! + at, frames: n)
                }
            }
            at += n
        }
        return (l, r)
    }

    func testCleanLeavesEverySampleAlone() {
        let input: (Int) -> Float = { Float(sin(Double($0) * 0.01)) * 0.7 }
        let (l, r) = run(.clean, seconds: 0.5, input: input)
        for i in stride(from: 0, to: l.count, by: 97) {
            XCTAssertEqual(l[i], input(i))
            XCTAssertEqual(r[i], input(i))
        }
    }

    func testHissIsQuietButThere() {
        let (l, r) = run(.init(hiss: 1), seconds: 1)
        let rms = (l.map { $0 * $0 }.reduce(0, +) / Float(l.count)).squareRoot()
        // Under the music, where a cassette's hiss sits: about −50 dBFS.
        XCTAssertGreaterThan(rms, 0.0008)
        XCTAssertLessThan(rms, 0.006)
        XCTAssertLessThan(abs(l.reduce(0, +) / Float(l.count)), 0.0005, "no offset")
        // The two channels hiss on their own, the way two tape tracks do.
        let together = zip(l, r).map { $0 * $1 }.reduce(0, +) / Float(l.count)
        XCTAssertLessThan(abs(together) / (rms * rms), 0.2)
    }

    func testCrackleTicksAboutSevenTimesASecond() {
        let (l, _) = run(.init(crackle: 1), seconds: 20)
        var ticks = 0
        var quiet = 0
        for v in l {
            if abs(v) > 0.015 {
                if quiet > 240 { ticks += 1 }
                quiet = 0
            } else {
                quiet += 1
            }
        }
        let perSecond = Double(ticks) / 20
        XCTAssertGreaterThan(perSecond, 3)
        XCTAssertLessThan(perSecond, 9)
        XCTAssertLessThan(l.map(abs).max() ?? 0, 0.5, "a pop, not a gunshot")
    }

    func testCrushHoldsAndCutsTheBits() {
        // A signal that moves every frame, so every hold shows.
        let input: (Int) -> Float = { Float(sin(Double($0) * 1.3)) * 0.5 }
        let (l, _) = run(.init(crush: 1), seconds: 0.2, input: input)
        // Full crush: each value held for five frames,
        for start in stride(from: 0, to: 2_000, by: 5) {
            for k in 1..<5 { XCTAssertEqual(l[start + k], l[start], "frame \(start + k)") }
        }
        XCTAssertNotEqual(l[0], l[5])
        // on a 7-bit ladder,
        for v in l.prefix(2_000) { XCTAssertEqual(v * 128, (v * 128).rounded(), accuracy: 1e-3) }
        // and still the same signal underneath.
        for start in stride(from: 0, to: 2_000, by: 5) { XCTAssertEqual(l[start], input(start), accuracy: 1 / 128) }
    }

    func testTheSameSeedIsTheSameNoise() {
        let a = run(.init(hiss: 1, crackle: 1), seconds: 0.3).0
        let b = run(.init(hiss: 1, crackle: 1), seconds: 0.3).0
        XCTAssertEqual(a, b)
    }
}
