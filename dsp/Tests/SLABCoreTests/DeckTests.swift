import XCTest
@testable import SLABCore

/// A song that never repeats: every frame's value is a hash of its position.
private func songSample(_ position: Int) -> Float {
    var x = UInt64(truncatingIfNeeded: position) &* 0x9E37_79B9_7F4A_7C15
    x ^= x >> 31
    x &*= 0xBF58_476D_1CE4_E5B9
    x ^= x >> 27
    return Float(x % 1_000_000) / 1_000_000 - 0.5
}

/// Spotify on one side of the deck, the speakers on the other, in 512-frame blocks.
private final class Rig {
    let deck: Deck
    let rate: Double
    let song: (Int) -> Float
    /// The song position Spotify writes next, or nil while it is silent.
    var spotify: Int?
    var silenceLeft = 0
    var resumeAt: Int?
    var heard: [Float] = []

    init(rate: Double = 48_000, start: Int = 0, prime: Int = 1_024, song: @escaping (Int) -> Float = songSample) {
        self.rate = rate
        self.song = song
        deck = Deck(sampleRate: rate, seconds: 45)
        spotify = start
        write(prime)
    }

    func ms(_ value: Double) -> Int { Int(rate * value / 1000) }

    func write(_ frames: Int) {
        var samples = [Float](repeating: 0, count: frames)
        for i in 0..<frames {
            if silenceLeft > 0 {
                silenceLeft -= 1
                if silenceLeft == 0, let resume = resumeAt {
                    spotify = resume
                    resumeAt = nil
                }
                continue
            }
            if let position = spotify {
                samples[i] = song(position)
                spotify = position + 1
            }
        }
        samples.withUnsafeBufferPointer { p in deck.write(p.baseAddress!, p.baseAddress!, frames: frames) }
    }

    func play(_ frames: Int) {
        var l = [Float](repeating: 0, count: frames)
        var r = [Float](repeating: 0, count: frames)
        l.withUnsafeMutableBufferPointer { lp in
            r.withUnsafeMutableBufferPointer { rp in
                _ = deck.read(into: lp.baseAddress!, rp.baseAddress!, frames: frames)
            }
        }
        heard.append(contentsOf: l)
    }

    /// Real time: Spotify writes a block, the speakers take a block, and every 25 ms the helper's
    /// steering looks for Spotify's audio when asked to.
    func run(_ frames: Int, realigning: Bool = false) {
        var left = frames
        var since = 0
        while left > 0 {
            let block = min(512, left)
            write(block)
            play(block)
            left -= block
            since += block
            if realigning, since >= ms(25) {
                since = 0
                deck.realign()
            }
        }
    }

    /// Spotify is sent to `position`: it plays on for `lateMs`, is silent for `gapMs`, then plays from there.
    func seek(to position: Int, lateMs: Double, gapMs: Double) {
        run(ms(lateMs), realigning: true)
        spotify = nil
        silenceLeft = max(1, ms(gapMs))
        resumeAt = position
    }

    /// Spotify stops sending anything at all.
    func silence() {
        spotify = nil
        silenceLeft = 0
        resumeAt = nil
    }

    /// The song position of `heard[index]`, found by its last eight frames, searched in `range`.
    func locate(_ index: Int, in range: ClosedRange<Int>) -> Int? {
        for p in range where (0..<8).allSatisfy({ abs(heard[index - $0] - song(p - $0)) < 1e-7 }) {
            return p
        }
        return nil
    }

    /// The first frame from `index` on that isn't the song played straight on from `position`, or nil.
    func seam(from index: Int, through end: Int? = nil, playing position: Int) -> Int? {
        let last = end ?? heard.count
        return (index..<last).first { abs(heard[$0] - song(position + $0 - index)) > 1e-6 }
    }
}

final class DeckTests: XCTestCase {
    func testRidesLiveAtTheTargetLag() {
        let rig = Rig(start: 10_000)
        rig.run(rig.ms(500))
        // Steady state: what is heard is what Spotify wrote, a fixed lag later.
        XCTAssertEqual(rig.heard[rig.heard.count - 1], songSample(10_000 + rig.deck.head - 1), accuracy: 1e-7)
        XCTAssertLessThanOrEqual(rig.deck.framesAvailable, rig.deck.maxLag)
    }

    func testAChopIsSampleExactAndInstant() throws {
        let rig = Rig()
        rig.run(rig.ms(3_000))
        let back = rig.ms(1_500)
        let target = rig.deck.head - back
        let index = rig.heard.count
        try rig.deck.scheduleJump(backFrames: back, seekAheadFrames: 0, availableFrames: rig.ms(3_000))
        rig.run(512)
        // After the 6 ms crossfade the speakers play exactly 1.5 s earlier, from the very next block.
        let fade = rig.deck.fadeFrames
        XCTAssertNil(rig.seam(from: index + fade, playing: target + fade))
        XCTAssertTrue(rig.deck.isDetached)
    }

    func testAScheduledChopLandsExactlyWhenAsked() throws {
        let rig = Rig()
        rig.run(rig.ms(3_000))
        let headBefore = rig.deck.head
        let index = rig.heard.count
        // A loop's jump, set 300 ms ahead so it lands on the bar line, not whenever a clock ticks.
        let at = rig.ms(300)
        let back = rig.ms(1_000)
        try rig.deck.scheduleJump(backFrames: back, inFrames: at, seekAheadFrames: 0, availableFrames: rig.ms(3_000))
        rig.run(rig.ms(400))
        // Untouched up to the line, then a second back from there.
        XCTAssertNil(rig.seam(from: index, through: index + at, playing: headBefore))
        let fade = rig.deck.fadeFrames
        XCTAssertNil(rig.seam(from: index + at + fade, playing: headBefore + at + fade - back))
    }

    func testRejoinsSpotifyWithoutAnAudibleSeam() throws {
        let rig = Rig()
        rig.run(rig.ms(4_000))
        let back = rig.ms(2_000)
        let ahead = rig.ms(260)
        let target = rig.deck.head - back
        let index = rig.heard.count
        try rig.deck.scheduleJump(backFrames: back, seekAheadFrames: ahead, availableFrames: rig.ms(4_000))
        rig.run(512)
        // SLAB aims Spotify at what the deck now plays, plus its aim-ahead. Spotify plays on for
        // 30 ms, is silent for 180 ms, then comes back there.
        rig.seek(to: target + 512 + ahead, lateMs: 30, gapMs: 180)
        rig.run(rig.ms(1_500), realigning: true)

        XCTAssertFalse(rig.deck.isDetached, "realigned onto Spotify's audio")
        XCTAssertEqual(rig.deck.realignments, 1)
        XCTAssertEqual(rig.deck.fallbacks, 0)
        // Every frame after the jump's fade is the next frame of the song: no repeat, no skip, no silence.
        let fade = rig.deck.fadeFrames
        XCTAssertNil(rig.seam(from: index + fade, playing: target + fade), "a seam after the chop")
        // It measured what Spotify's restart cost: 30 ms playing on plus 180 ms silent.
        let gap = try XCTUnwrap(rig.deck.seekGapMs)
        XCTAssertEqual(gap, 210, accuracy: 15)
        XCTAssertLessThanOrEqual(rig.deck.framesAvailable, rig.deck.maxLag)
    }

    func testWaitsForSpotifysCopyWhenItComesBackFarAhead() throws {
        let rig = Rig()
        rig.run(rig.ms(4_000))
        let back = rig.ms(2_000)
        let ahead = rig.ms(400)
        let target = rig.deck.head - back
        let index = rig.heard.count
        try rig.deck.scheduleJump(backFrames: back, seekAheadFrames: ahead, availableFrames: rig.ms(4_000))
        rig.run(512)
        // Spotify only needed 60 ms, so its audio starts well ahead of what the deck is playing:
        // the deck plays memory until it reaches the first of Spotify's audio, then crosses over.
        rig.seek(to: target + 512 + ahead, lateMs: 10, gapMs: 50)
        rig.run(rig.ms(1_000), realigning: true)
        XCTAssertFalse(rig.deck.isDetached)
        let fade = rig.deck.fadeFrames
        XCTAssertNil(rig.seam(from: index + fade, playing: target + fade), "a seam after the chop")
        // Joined on the same sound, so further behind live than usual: catching up, not skipping.
        XCTAssertTrue(rig.deck.catchingUp)
        XCTAssertGreaterThan(rig.deck.framesAvailable, rig.deck.maxLag)
        XCTAssertEqual(try XCTUnwrap(rig.deck.seekGapMs), 60, accuracy: 15)
    }

    func testRejoinsLiveWhenSpotifyComesBackBehindTheDeck() throws {
        let rig = Rig()
        rig.run(rig.ms(4_000))
        let back = rig.ms(2_000)
        let ahead = rig.ms(100)
        let target = rig.deck.head - back
        try rig.deck.scheduleJump(backFrames: back, seekAheadFrames: ahead, availableFrames: rig.ms(4_000))
        rig.run(512)
        // Spotify needs 300 ms, more than SLAB aimed for: its audio comes back behind what memory plays.
        rig.seek(to: target + 512 + ahead, lateMs: 20, gapMs: 280)
        rig.run(rig.ms(1_500), realigning: true)
        XCTAssertFalse(rig.deck.isDetached)
        XCTAssertEqual(rig.deck.realignments, 1)
        XCTAssertEqual(rig.deck.fallbacks, 0)
        // It learns the seek cost 300 ms, so SLAB aims further ahead next time,
        XCTAssertEqual(try XCTUnwrap(rig.deck.seekGapMs), 300, accuracy: 15)
        // and rides live again at its usual lag.
        XCTAssertLessThanOrEqual(rig.deck.framesAvailable, rig.deck.maxLag)
    }

    func testFindsTheRightBarInMusicThatRepeats() throws {
        // A loop-based beat: every 1.2 s bar is the same audio.
        let bar = 57_600
        let rig = Rig(song: { songSample($0 % bar) })
        rig.run(rig.ms(5_000))
        let ahead = rig.ms(200)
        let target = rig.deck.head - bar
        let index = rig.heard.count
        try rig.deck.scheduleJump(backFrames: bar, seekAheadFrames: ahead, availableFrames: rig.ms(5_000))
        rig.run(512)
        rig.seek(to: target + 512 + ahead, lateMs: 20, gapMs: 150)
        rig.run(rig.ms(1_500), realigning: true)
        XCTAssertFalse(rig.deck.isDetached)
        // Every bar matches; the copy used is the one where Spotify actually came back.
        XCTAssertEqual(try XCTUnwrap(rig.deck.seekGapMs), 170, accuracy: 15)
        let fade = rig.deck.fadeFrames
        XCTAssertNil(rig.seam(from: index + fade, playing: target + fade), "a seam after the chop")
    }

    func testWaitsOutTheRecordPlayingOnBeforeTheSeekTakesHold() throws {
        // A one-bar loop, and a Spotify that plays on for 300 ms before its seek takes hold, with
        // no silence between. Those 300 ms match memory a bar back, but they are not the seek's audio.
        let bar = 57_600
        let rig = Rig(song: { songSample($0 % bar) })
        rig.run(rig.ms(5_000))
        let ahead = rig.ms(400)
        let target = rig.deck.head - bar
        let index = rig.heard.count
        try rig.deck.scheduleJump(backFrames: bar, seekAheadFrames: ahead, availableFrames: rig.ms(5_000))
        rig.run(512)
        rig.seek(to: target + 512 + ahead, lateMs: 300, gapMs: 0)
        rig.run(rig.ms(1_500), realigning: true)
        XCTAssertFalse(rig.deck.isDetached)
        XCTAssertEqual(rig.deck.fallbacks, 0)
        XCTAssertEqual(try XCTUnwrap(rig.deck.seekGapMs), 300, accuracy: 15)
        let fade = rig.deck.fadeFrames
        XCTAssertNil(rig.seam(from: index + fade, playing: target + fade), "a seam after the chop")
    }

    func testChopsAgainBeforeSpotifyIsBack() throws {
        let rig = Rig()
        rig.run(rig.ms(6_000))
        let back = rig.ms(1_000)
        let ahead = rig.ms(250)
        try rig.deck.scheduleJump(backFrames: back, seekAheadFrames: ahead, availableFrames: rig.ms(6_000))
        rig.run(512)
        // Spotify goes quiet on the first seek; 150 ms in, a second pad, back another second.
        rig.silence()
        rig.run(rig.ms(150), realigning: true)
        let index = rig.heard.count
        let at = try XCTUnwrap(rig.locate(index - 1, in: (rig.deck.head - rig.ms(50))...rig.deck.head))
        try rig.deck.scheduleJump(backFrames: back, seekAheadFrames: ahead, availableFrames: rig.ms(6_000))
        rig.run(512)
        let second = at + 1 - back
        // Only the second seek counts: Spotify comes back 200 ms after it, aimed past the second chop.
        rig.seek(to: second + 512 + ahead, lateMs: 0, gapMs: 200)
        rig.run(rig.ms(1_500), realigning: true)
        XCTAssertFalse(rig.deck.isDetached)
        XCTAssertEqual(rig.deck.jumps, 2)
        XCTAssertEqual(rig.deck.realignments, 1)
        XCTAssertEqual(rig.deck.fallbacks, 0)
        let fade = rig.deck.fadeFrames
        XCTAssertNil(rig.seam(from: index + fade, playing: second + fade), "a seam after the second chop")
    }

    func testGivesUpAndGoesLiveIfSpotifyNeverComesBack() throws {
        let rig = Rig()
        rig.run(rig.ms(4_000))
        try rig.deck.scheduleJump(backFrames: rig.ms(2_000), seekAheadFrames: rig.ms(200), availableFrames: rig.ms(4_000))
        rig.run(512)
        rig.silence()
        rig.run(rig.ms(3_000), realigning: true)
        XCTAssertFalse(rig.deck.isDetached)
        XCTAssertEqual(rig.deck.fallbacks, 1)
        // Memory from before no longer lines up with what Spotify plays: no jumping back into it
        // (it went live a second ago, so two seconds back is before that).
        XCTAssertThrowsError(try rig.deck.scheduleJump(backFrames: rig.ms(2_000), seekAheadFrames: 0, availableFrames: rig.ms(10_000)))
    }

    func testACalledOffJumpNeverHappensOrStopsWaiting() throws {
        let rig = Rig()
        rig.run(rig.ms(3_000))
        // Still to come: called off, it never happens.
        let headBefore = rig.deck.head
        let index = rig.heard.count
        try rig.deck.scheduleJump(backFrames: rig.ms(1_000), inFrames: rig.ms(200), seekAheadFrames: 0, availableFrames: rig.ms(3_000))
        rig.deck.cancelJump()
        rig.run(rig.ms(400))
        XCTAssertNil(rig.seam(from: index, playing: headBefore))
        XCTAssertEqual(rig.deck.jumps, 0)
        // Already happened, and Spotify moved on to another track: back to live now, not after the wait.
        try rig.deck.scheduleJump(backFrames: rig.ms(1_000), seekAheadFrames: rig.ms(250), availableFrames: rig.ms(3_000))
        rig.run(512)
        XCTAssertTrue(rig.deck.isDetached)
        rig.deck.cancelJump()
        XCTAssertFalse(rig.deck.isDetached)
        rig.run(rig.ms(100))
        XCTAssertLessThanOrEqual(rig.deck.framesAvailable, rig.deck.maxLag)
    }

    func testRefusesToJumpPastWhatSLABKnowsIsContiguous() {
        let rig = Rig()
        rig.run(rig.ms(4_000))
        XCTAssertThrowsError(try rig.deck.scheduleJump(backFrames: rig.ms(3_000), seekAheadFrames: 0, availableFrames: rig.ms(2_000)))
        XCTAssertThrowsError(try rig.deck.scheduleJump(backFrames: rig.ms(60_000), seekAheadFrames: 0, availableFrames: rig.ms(60_000)))
        // Ahead of anything heard isn't in memory either.
        XCTAssertThrowsError(try rig.deck.scheduleJump(backFrames: -rig.ms(500), seekAheadFrames: 0, availableFrames: rig.ms(4_000)))
    }

    /// The first chop of several: two seconds back, Spotify found again 200 ms later.
    private func chopAndRealign(_ rig: Rig) throws -> Int {
        rig.run(rig.ms(6_000))
        let back = rig.ms(2_000)
        let ahead = rig.ms(250)
        let target = rig.deck.head - back
        try rig.deck.scheduleJump(backFrames: back, seekAheadFrames: ahead, availableFrames: rig.ms(6_000))
        rig.run(512)
        rig.seek(to: target + 512 + ahead, lateMs: 20, gapMs: 200)
        rig.run(rig.ms(1_000), realigning: true)
        XCTAssertFalse(rig.deck.isDetached)
        return target
    }

    func testASecondChopAfterARealignLandsOnTheSong() throws {
        let rig = Rig()
        let target = try chopAndRealign(rig)
        // Two seconds back again: the sound now lives on the far side of a seek in the ring,
        // and the content clock still finds it.
        let index = rig.heard.count
        let at = try XCTUnwrap(rig.locate(index - 1, in: target...(target + rig.ms(2_500))), "the speakers are on the song")
        let back = rig.ms(2_000)
        try rig.deck.scheduleJump(backFrames: back, seekAheadFrames: rig.ms(250), availableFrames: rig.ms(6_000))
        rig.run(512)
        let fade = rig.deck.fadeFrames
        XCTAssertNil(rig.seam(from: index + fade, playing: at + 1 - back + fade), "a seam after the second chop")
    }

    func testCarriesOnInAnOlderCopyWhenTheNewerOneRunsOut() throws {
        let rig = Rig()
        let target = try chopAndRealign(rig)
        // Half a second back: that sound is in Spotify's new copy, which ends where this chop leaves
        // it. Past that the song carries on in the copy from before the first chop.
        let index = rig.heard.count
        let at = try XCTUnwrap(rig.locate(index - 1, in: target...(target + rig.ms(2_500))))
        let back = rig.ms(500)
        try rig.deck.scheduleJump(backFrames: back, seekAheadFrames: rig.ms(250), availableFrames: rig.ms(6_000))
        rig.run(512)
        rig.silence()
        rig.run(rig.ms(1_200))
        XCTAssertTrue(rig.deck.isDetached, "still playing the song from memory")
        XCTAssertEqual(rig.deck.fallbacks, 0)
        let fade = rig.deck.fadeFrames
        XCTAssertNil(rig.seam(from: index + fade, playing: at + 1 - back + fade), "a seam where one copy hands to the other")
    }

    func testJumpsForwardIntoSoundItHasAlreadyPlayed() throws {
        let rig = Rig()
        let target = try chopAndRealign(rig)
        // Half a second forward: still short of where the record was before the chop, so in memory.
        let index = rig.heard.count
        let at = try XCTUnwrap(rig.locate(index - 1, in: target...(target + rig.ms(2_500))))
        let forward = rig.ms(500)
        try rig.deck.scheduleJump(backFrames: -forward, seekAheadFrames: rig.ms(250), availableFrames: rig.ms(6_000))
        rig.run(512)
        let fade = rig.deck.fadeFrames
        XCTAssertNil(rig.seam(from: index + fade, playing: at + 1 + forward + fade))
        // Nothing ahead of what has been heard can be played from memory.
        XCTAssertThrowsError(try rig.deck.scheduleJump(backFrames: -rig.ms(5_000), seekAheadFrames: 0, availableFrames: rig.ms(6_000)))
    }

    func testMatchPicksTheCopyNearestWhereItShouldBe() {
        let probe = (0..<4_096).map { songSample($0 + 1_000) }
        var region = (0..<20_000).map { songSample($0 + 50_000) }
        // The same sound twice: at 3,000 and at 12,000.
        for i in 0..<4_096 {
            region[3_000 + i] = probe[i]
            region[12_000 + i] = probe[i]
        }
        XCTAssertEqual(Match.best(probe: probe, region: region, expected: 11_500)?.offset, 12_000)
        XCTAssertEqual(Match.best(probe: probe, region: region, expected: 2_000)?.offset, 3_000)
        XCTAssertNil(Match.best(probe: [Float](repeating: 0, count: 4_096), region: region, expected: 0))
    }

    func testMatchFindsSoundOffTheCoarseGrid() {
        // Not on a multiple of the coarse step: the sample-accurate pass still lands exactly.
        let probe = (0..<4_096).map { songSample($0 + 1_000) }
        var region = (0..<20_000).map { songSample($0 + 50_000) }
        for i in 0..<4_096 { region[7_003 + i] = probe[i] }
        let found = Match.best(probe: probe, region: region, expected: 7_000)
        XCTAssertEqual(found?.offset, 7_003)
        XCTAssertEqual(found?.score ?? 0, 1, accuracy: 1e-4)
    }
}
