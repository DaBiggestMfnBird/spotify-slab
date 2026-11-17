import XCTest
@testable import SLABCore

/// A song that never repeats: every frame's value is a hash of its position.
private func hashed(_ position: Int) -> Float {
    var x = UInt64(truncatingIfNeeded: position) &* 0x9E37_79B9_7F4A_7C15
    x ^= x >> 31
    x &*= 0xBF58_476D_1CE4_E5B9
    x ^= x >> 27
    return Float(x % 1_000_000) / 1_000_000 - 0.5
}

/// The tap writing the song a block ahead of the output, and the output reading it with its cuts.
private final class Turntable {
    let deck: Deck
    private(set) var written = 0
    private(set) var played = 0
    var cuts: [Deck.Cut] = []
    private var left = [Float](repeating: 0, count: 512)
    private var right = [Float](repeating: 0, count: 512)

    init(reportsCuts: Bool) {
        deck = Deck(sampleRate: 48_000, seconds: 45, reportsCuts: reportsCuts)
        write(2_048)
    }

    func write(_ frames: Int) {
        let samples = (written..<(written + frames)).map(hashed)
        samples.withUnsafeBufferPointer { p in deck.write(p.baseAddress!, p.baseAddress!, frames: frames) }
        written += frames
    }

    /// Reads a block, writes as much again, and returns what was read.
    @discardableResult
    func play(_ frames: Int = 512) -> [Float] {
        left.withUnsafeMutableBufferPointer { l in
            right.withUnsafeMutableBufferPointer { r in
                _ = deck.read(into: l.baseAddress!, r.baseAddress!, frames: frames, cuts: &cuts)
            }
        }
        played += frames
        write(frames)
        return Array(left.prefix(frames))
    }

    func play(seconds: Double) {
        for _ in 0..<Int(seconds * 48_000 / 512) { play() }
    }
}

final class DeckCutTests: XCTestCase {
    func testAChopIsReportedAndLeftUncrossfaded() throws {
        let table = Turntable(reportsCuts: true)
        table.play(seconds: 2)
        let head = table.played
        try table.deck.scheduleJump(backFrames: 48_000, inFrames: 100, seekAheadFrames: 0, availableFrames: 96_000)
        let out = table.play()

        XCTAssertEqual(table.cuts.count, 1)
        let cut = try XCTUnwrap(table.cuts.first)
        XCTAssertEqual(cut.frame, 100)
        XCTAssertEqual(cut.from, head + 100)
        XCTAssertEqual(cut.to, head + 100 - 48_000)
        XCTAssertEqual(cut.start, 0, "the song has run unbroken since the deck began")
        // Up to the cut the song as it was, and from the cut the song a second back: nothing between.
        for k in 0..<100 { XCTAssertEqual(out[k], hashed(head + k)) }
        for k in 100..<512 { XCTAssertEqual(out[k], hashed(cut.to + k - 100)) }
        // The next block plays on with no cut.
        table.play()
        XCTAssertTrue(table.cuts.isEmpty)
    }

    func testADeckThatDoesntReportCrossfadesAsBefore() throws {
        let table = Turntable(reportsCuts: false)
        table.play(seconds: 2)
        let head = table.played
        try table.deck.scheduleJump(backFrames: 48_000, inFrames: 100, seekAheadFrames: 0, availableFrames: 96_000)
        let out = table.play()
        XCTAssertTrue(table.cuts.isEmpty)
        // Half way through its crossfade, the old sound and the new one are both in it.
        let mid = 100 + table.deck.fadeFrames / 2
        XCTAssertNotEqual(out[mid], hashed(head + mid - 48_000))
        // Once it's done, only the new.
        let after = 100 + table.deck.fadeFrames + 1
        XCTAssertEqual(out[after], hashed(head + after - 48_000))
    }

    func testASpinLandsOutOfSilence() throws {
        let table = Turntable(reportsCuts: true)
        table.play(seconds: 2)
        let head = table.played
        try table.deck.scheduleSpin(backFrames: 48_000, spinFrames: 4_800, seekAheadFrames: 0, availableFrames: 96_000)
        var landing: Deck.Cut?
        for _ in 0..<12 {
            table.play()
            if let cut = table.cuts.first { landing = cut }
        }
        let cut = try XCTUnwrap(landing)
        XCTAssertNil(cut.from, "the spin wound down to nothing: there is no old sound to fade out")
        XCTAssertEqual(cut.to, head - 48_000)
    }

    func testGoingBackToLiveIsACutFromWhereSpotifyWasSent() throws {
        let table = Turntable(reportsCuts: true)
        table.deck.patienceSeconds = 0.2
        table.play(seconds: 2)
        try table.deck.scheduleJump(backFrames: 48_000, inFrames: 0, seekAheadFrames: 0, availableFrames: 96_000)
        table.play()
        let jumpedAt = table.written - 512
        var live: (cut: Deck.Cut, written: Int)?
        for _ in 0..<40 where live == nil {
            let before = table.written
            table.play()
            if let cut = table.cuts.first { live = (cut, before) }
        }
        let found = try XCTUnwrap(live, "Spotify never came back: after its patience the deck goes live")
        XCTAssertEqual(found.cut.start, jumpedAt, "what Spotify sent since the jump is all that follows on from live")
        XCTAssertEqual(found.cut.to, found.written - table.deck.targetLag)
    }

    func testRecallGivesWhatTheTapWroteAndSilenceElsewhere() {
        let table = Turntable(reportsCuts: true)
        table.play(seconds: 1)
        var l = [Float](repeating: 9, count: 40)
        var r = [Float](repeating: 9, count: 40)
        let end = table.written
        l.withUnsafeMutableBufferPointer { lp in
            r.withUnsafeMutableBufferPointer { rp in
                table.deck.recall(from: end - 20, count: 40, notBefore: end - 10, into: lp.baseAddress!, rp.baseAddress!)
            }
        }
        for i in 0..<10 { XCTAssertEqual(l[i], 0, "before the copy it belongs to") }
        for i in 10..<20 { XCTAssertEqual(l[i], hashed(end - 20 + i)) }
        for i in 20..<40 { XCTAssertEqual(l[i], 0, "not written yet") }
        XCTAssertEqual(l, r)
    }
}
