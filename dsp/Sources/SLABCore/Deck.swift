import Foundation
#if canImport(Accelerate)
import Accelerate
#endif

/// The helper's copy of the record.
///
/// Everything the tap captures goes into a ring that remembers the last `seconds` of
/// audio, and the output reads it back a few milliseconds later. Riding live, the read
/// head trails the write head by about `targetLag` frames and never more than `maxLag`.
///
/// A chop moves the read head inside one render block, so the jump is sample-exact and
/// there is no gap: the listener hears the bar again at once. SLAB then seeks Spotify
/// there in the background. Until Spotify's audio comes back the deck plays from memory
/// (it is "detached"); once it does, `realign()` finds the same sound in what arrived,
/// and the output crosses onto Spotify's copy where the two meet. It rides live again
/// and nobody hears Spotify restart.
///
/// Memory is only trusted where its content is known. Each realignment shows that the
/// new audio is a copy of older audio at a fixed offset, so the deck keeps one content
/// clock across seeks: `segments` map ring positions to that clock, and a jump of N
/// frames back is N frames back on the clock, wherever in the ring that sound now lives.
public final class Deck: @unchecked Sendable {
    /// Set once the tap reports its format; timing (fades, waits, search windows) follows it.
    public var sampleRate: Double
    public let capacity: Int
    /// Where the output rides behind the tap, and the most it may fall behind before it skips ahead.
    public let targetLag: Int
    public let maxLag: Int
    public let fadeFrames: Int
    /// How long the deck plays from memory waiting for Spotify's audio before it goes back to live.
    public var patienceSeconds: Double = 2

    private let left: UnsafeMutablePointer<Float>
    private let right: UnsafeMutablePointer<Float>
    /// Equal-power crossfade, `fadeFrames + 1` steps from all-old to all-new, for joining two
    /// different sounds. Two copies of the same sound are joined straight (`fadeLinear`), since
    /// equal power would make identical audio 3 dB louder halfway through.
    private let fadeIn: [Float]
    private let fadeOut: [Float]
    private var fadeLinear = false
    private let lock = NSLock()

    /// Frames ever written, and the next frame the output plays: ring positions, never wrapped.
    private(set) var written = 0
    private(set) var head = 0
    /// Frames handed to the output: the clock scheduled jumps and the patience run on.
    private(set) var played = 0

    /// The copy of the song the head is playing: its place on the content clock
    /// (`clock = position - headDelta`) and where its known audio ends (`Int.max` while the
    /// tap is still writing it).
    private var headDelta = 0
    private var headEnd = Int.max

    /// A crossfade in progress: the old stream keeps going from `fadeFrom` while the new one comes up.
    private var fadeFrom = 0
    private var fadeLeft = 0

    private var pending: Jump?
    private var detached: Detached?
    private var rejoin: Rejoin?
    private var catching = false
    /// A backspin in progress: the record runs backwards until the jump it lands on fires.
    private(set) var spin: Spin?
    /// The lag before the spin, which is what the panel shows; the head stands still while it turns.
    private var spinLag = 0

    /// Stretches of ring whose place on the content clock is known, oldest first.
    private(set) var segments: [Segment] = []
    private static let maxSegments = 64

    private var dropped = 0
    private var jumpCount = 0
    private var realignCount = 0
    private var fallbackCount = 0
    /// What Spotify's restart cost on recent seeks, in milliseconds.
    private var gaps: [Double] = []
    /// The last few chops and how each went, oldest first.
    private var chopLog: [ChopRecord] = []
    private static let chopLogSize = 8
    /// The last tightening, so every pass of a loop jumps the same distance, even the passes asked
    /// for while the deck plays from memory.
    private var lastTight: (asked: Int, made: Int, alike: Bool, at: Int)?

    struct Jump {
        let at: Int
        let back: Int
        /// What SLAB asked for, before the deck tightened it to the record's own beat.
        let asked: Int
        let seekAhead: Int
        /// Both sides of the cut are the same sound (a loop, a beat jumped by its own length): they
        /// are crossed straight, since equal power would swell identical audio 3 dB at the join.
        let alike: Bool
    }

    struct Detached {
        /// `written` when the jump happened: what the tap writes from here on is Spotify being re-seeked.
        let since: Int
        /// The lag the output had riding live before the jump: what the panel shows meanwhile.
        let lag: Int
        let seekAhead: Int
        /// The output frame at which the deck stops waiting for Spotify and goes back to live.
        let deadline: Int
        /// Which jump this is, so a match worked out for an earlier one is never applied to a later one.
        let episode: Int
    }

    /// Spotify's re-seeked audio, found: from ring position `from` on, it is the song at
    /// `position - delta` on the content clock.
    struct Rejoin {
        let delta: Int
        let from: Int
        /// What Spotify's restart cost on this seek, in ms.
        let gapMs: Double
    }

    /// The record turning backwards under a hand: `position` is where the stylus is, between frames.
    struct Spin {
        var position: Double
        var elapsed: Int
        let frames: Int
        /// The fastest it runs backwards, in times normal speed.
        let speed: Double
        /// It never runs back past where this copy of the song begins.
        let floor: Double
    }

    /// A stretch of the ring whose content sits on the content clock at `position - delta`.
    struct Segment {
        var start: Int
        var end: Int?
        var delta: Int
    }

    private struct Copy {
        let position: Int
        let delta: Int
        let end: Int?
    }

    /// What became of a chop.
    public enum Outcome: String, Sendable {
        /// Crossed onto Spotify's copy where the two met: nothing to hear.
        case realigned
        /// Spotify came back behind what memory was playing: rejoined live, a moment heard twice.
        case behind
        /// Spotify's audio wasn't found in time: back to live, with a skip.
        case wentLive
        /// A pause or a new track called it off.
        case cancelled
        /// Another chop came before Spotify was found.
        case chopped
    }

    /// One chop, as it went.
    public struct ChopRecord: Sendable {
        public let number: Int
        /// The jump SLAB asked for, and the one made after tightening it to the record's own beat.
        public let askedFrames: Int
        public let madeFrames: Int
        public var outcome: Outcome?
        /// What Spotify's restart cost, once its audio was found.
        public var gapMs: Double?
        /// The best match to memory seen while waiting for Spotify (1 is the same sound).
        public var bestScore: Float
        /// From the jump to its outcome.
        public var tookMs: Double?
        /// For `behind`: how much was heard twice.
        public var repeatMs: Double?
        let startedAt: Int
    }

    public enum Realign: Equatable {
        case notDetached
        case waiting
        /// Spotify's audio is found; the output crosses onto it as soon as it reaches the first of it.
        case locked
        case aligned(lagFrames: Int)
    }

    public enum JumpRefusal: Error, Equatable {
        /// Further back than SLAB knows the song runs unbroken, or than the ring holds.
        case tooFarBack
        /// That part of the song is not in memory: ahead of anything heard, or lost to a seek.
        case notInMemory
        case nothingPlaying
    }

    public init(sampleRate: Double = 48_000, seconds: Double = 45, targetLag: Int = 1_024, maxLag: Int = 3_072, fadeMs: Double = 6) {
        self.sampleRate = sampleRate
        capacity = max(Int(sampleRate * seconds), 8_192)
        self.targetLag = targetLag
        self.maxLag = max(maxLag, targetLag + 256)
        let fade = max(16, Int(sampleRate * fadeMs / 1000))
        fadeFrames = fade
        fadeIn = (0...fade).map { Float(sin(Double($0) / Double(fade) * .pi / 2)) }
        fadeOut = (0...fade).map { Float(cos(Double($0) / Double(fade) * .pi / 2)) }
        left = .allocate(capacity: capacity)
        right = .allocate(capacity: capacity)
        left.initialize(repeating: 0, count: capacity)
        right.initialize(repeating: 0, count: capacity)
        // Room reserved up front: the audio thread adds and drops segments and must never allocate.
        segments.reserveCapacity(Self.maxSegments + 4)
        segments.append(Segment(start: 0, end: nil, delta: 0))
        gaps.reserveCapacity(8)
        chopLog.reserveCapacity(Self.chopLogSize + 1)
    }

    deinit {
        left.deallocate()
        right.deallocate()
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    // MARK: Tap side

    public func write(_ srcL: UnsafePointer<Float>, _ srcR: UnsafePointer<Float>, frames: Int) {
        guard frames > 0 else { return }
        lock.lock()
        var w = written
        var i = 0
        while i < frames {
            let at = w % capacity
            let chunk = min(frames - i, capacity - at)
            (left + at).update(from: srcL + i, count: chunk)
            (right + at).update(from: srcR + i, count: chunk)
            w += chunk
            i += chunk
        }
        written = w
        lock.unlock()
    }

    // MARK: Output side

    /// Fills the output. Plays silence while there is nothing new to play, and never reads ahead of the tap.
    @discardableResult
    public func read(into dstL: UnsafeMutablePointer<Float>, _ dstR: UnsafeMutablePointer<Float>, frames: Int) -> Int {
        lock.lock()
        defer { lock.unlock() }
        if detached == nil, spin == nil { ride() }
        var produced = 0
        for k in 0..<frames {
            if let jump = pending, played >= jump.at {
                pending = nil
                let landing = spin != nil
                spin = nil
                perform(jump, lag: landing ? spinLag : nil)
                // The spin has wound down to nothing: the chop comes up out of silence, not out of it.
                if landing { fadeFrom = Int.max / 2 }
            }
            if var turning = spin {
                let (l, r) = spinSample(&turning)
                spin = turning
                dstL[k] = l
                dstR[k] = r
                played += 1
                produced += 1
                continue
            }
            if let state = detached { steer(state) }
            if head >= written {
                dstL[k] = 0
                dstR[k] = 0
                played += 1
                continue
            }
            var l = left[head % capacity]
            var r = right[head % capacity]
            if fadeLeft > 0 {
                let step = fadeFrames - fadeLeft
                let ol = fadeFrom < written ? left[fadeFrom % capacity] : 0
                let or = fadeFrom < written ? right[fadeFrom % capacity] : 0
                let up: Float
                let down: Float
                if fadeLinear {
                    up = Float(step) / Float(fadeFrames)
                    down = 1 - up
                } else {
                    up = fadeIn[step]
                    down = fadeOut[step]
                }
                l = l * up + ol * down
                r = r * up + or * down
                fadeFrom += 1
                fadeLeft -= 1
            }
            dstL[k] = l
            dstR[k] = r
            head += 1
            played += 1
            produced += 1
        }
        return produced
    }

    /// Riding live: a backlog beyond `maxLag` is skipped with a crossfade, not dropped raw.
    /// While catching up after a realignment the skip waits, unless the gap is huge.
    private func ride() {
        let lag = written - head
        if catching {
            if lag <= targetLag + 64 {
                catching = false
            } else if lag < Int(sampleRate * 0.75) {
                return
            } else {
                catching = false
            }
        }
        guard lag > maxLag, fadeLeft == 0 else { return }
        dropped += lag - targetLag
        crossfade(to: written - targetLag)
    }

    /// One frame of a backspin. The hand catches the record and drags it back, fast, then it slows
    /// under the hand and fades as it stops: the jump it lands on comes in on the beat.
    private func spinSample(_ turning: inout Spin) -> (Float, Float) {
        let x = Double(turning.elapsed) / Double(turning.frames)
        let velocity: Double
        if x < 0.12 {
            // From playing forward to running back at full speed, smoothly: no click where it turns.
            let s = x / 0.12
            velocity = 1 - (1 + turning.speed) * (s * s * (3 - 2 * s))
        } else {
            velocity = -turning.speed * pow(1 - (x - 0.12) / 0.88, 1.4)
        }
        let gain = Float(x < 0.8 ? 1 : max(0, 1 - (x - 0.8) / 0.2))
        let p = max(turning.floor, min(Double(written - 2), turning.position))
        let i = Int(p.rounded(.down))
        let f = Float(p - Double(i))
        let a = i % capacity
        let b = (i + 1) % capacity
        let l = (left[a] * (1 - f) + left[b] * f) * gain
        let r = (right[a] * (1 - f) + right[b] * f) * gain
        turning.position = max(turning.floor, turning.position + velocity)
        turning.elapsed += 1
        return (l, r)
    }

    private func crossfade(to target: Int, sameSound: Bool = false) {
        fadeFrom = head
        fadeLeft = fadeFrames
        fadeLinear = sameSound
        head = target
    }

    /// Drops everything but the newest `keep` frames, so capture from engine setup isn't heard late.
    public func trim(keep: Int) {
        lock.lock()
        defer { lock.unlock() }
        let target = max(head, written - max(0, keep))
        guard target > head else { return }
        dropped += target - head
        head = target
    }

    // MARK: State, for the panel and the steering

    /// Frames between the tap and the output: what the output is behind live.
    public var framesAvailable: Int { locked { max(0, written - head) } }

    /// How far behind live the output really is, for the panel: while playing from memory after a
    /// jump the distance to the tap is the jump itself, not latency, so the lag from before it stands.
    public var lagFrames: Int { locked { detached?.lag ?? max(0, written - head) } }

    public var isDetached: Bool { locked { detached != nil } }

    /// Back on Spotify's audio but further behind live than it should be: the time-stretcher runs a
    /// little fast until it isn't.
    public var catchingUp: Bool { locked { catching } }

    public var droppedFrames: Int { locked { dropped } }
    public var jumps: Int { locked { jumpCount } }
    public var realignments: Int { locked { realignCount } }
    public var fallbacks: Int { locked { fallbackCount } }

    /// What Spotify's restart cost on recent seeks (the median), in milliseconds: how far past a
    /// jump SLAB should seek it. Nil until one has been measured.
    public var seekGapMs: Double? {
        locked {
            guard !gaps.isEmpty else { return nil }
            let sorted = gaps.sorted()
            return sorted[sorted.count / 2]
        }
    }

    /// The slow end of what Spotify's restart cost on recent seeks, in ms: the second slowest of the
    /// last seven, so one stall doesn't set it. Aimed by, Spotify's audio comes back ahead of the
    /// deck nearly every time, and the deck never has to rejoin it repeating a moment.
    public var seekGapHighMs: Double? {
        locked {
            guard !gaps.isEmpty else { return nil }
            let sorted = gaps.sorted()
            return sorted.count >= 4 ? sorted[sorted.count - 2] : sorted[sorted.count - 1]
        }
    }

    /// The last few chops, oldest first, and how each went.
    public var recentChops: [ChopRecord] {
        // A copy of its own, so the audio thread's next entry never has to copy the log.
        locked { chopLog.map { $0 } }
    }

    // MARK: Jumps

    /// Schedules a jump `backFrames` back on the content clock (forward, when negative) from what
    /// plays `inFrames` from now. `seekAheadFrames` is how far past the jump target SLAB will seek
    /// Spotify, so its audio comes back a little ahead of what the deck plays from memory.
    /// `availableFrames` is how much song SLAB knows runs unbroken behind what is heard (since the
    /// track started, the user moved the record, or play resumed); the deck never goes further back.
    public func scheduleJump(backFrames: Int, inFrames: Int = 0, seekAheadFrames: Int, availableFrames: Int) throws {
        let tight = backFrames > 0 ? tightened(backFrames) : (frames: backFrames, alike: false)
        lock.lock()
        defer { lock.unlock() }
        let back = tight.frames <= availableFrames ? tight.frames : backFrames
        let alike = back == tight.frames && tight.alike
        guard written > 0 else { throw JumpRefusal.nothingPlaying }
        guard back != 0, back <= availableFrames, abs(back) < capacity - Int(sampleRate * 2) else {
            throw JumpRefusal.tooFarBack
        }
        let delay = max(0, inFrames)
        // Where it lands, seen from here. A sound that will only have played by the time the jump
        // fires can't be checked yet; the jump checks again when it fires.
        let behind = back - delay
        if !(back > 0 && behind <= 0), target(back: behind) == nil {
            throw JumpRefusal.notInMemory
        }
        pending = Jump(at: played + delay, back: back, asked: backFrames, seekAhead: max(0, seekAheadFrames), alike: alike)
    }

    /// A backspin into a chop: the record spins back for `spinFrames` from now, then lands
    /// `backFrames` before where the spin began on the content clock, and waits for Spotify there
    /// as a jump does. `backFrames` of a bar less the spin keeps the landing on the beat.
    public func scheduleSpin(backFrames: Int, spinFrames: Int, seekAheadFrames: Int, availableFrames: Int, speed: Double = 3.5) throws {
        lock.lock()
        defer { lock.unlock() }
        guard written > 0, head < written else { throw JumpRefusal.nothingPlaying }
        guard backFrames > 0, backFrames <= availableFrames, backFrames < capacity - Int(sampleRate * 2) else {
            throw JumpRefusal.tooFarBack
        }
        guard target(back: backFrames) != nil else { throw JumpRefusal.notInMemory }
        // The spin runs back over what was just heard, never past where this copy of the song begins.
        var floor = Double(max(0, written - capacity + fadeFrames))
        for segment in segments.reversed() where head >= segment.start && head < (segment.end ?? Int.max) {
            floor = max(floor, Double(segment.start))
            break
        }
        let frames = max(fadeFrames * 4, spinFrames)
        spinLag = detached?.lag ?? max(0, written - head)
        spin = Spin(position: Double(head), elapsed: 0, frames: frames, speed: max(1, speed), floor: floor)
        pending = Jump(at: played + frames, back: backFrames, asked: backFrames, seekAhead: max(0, seekAheadFrames), alike: false)
    }

    /// Where a backspin's stylus is, while one turns.
    var spinPosition: Double? { locked { spin?.position } }

    /// Calls a jump off: one still to come never happens, and one that has happened stops waiting
    /// for Spotify and goes back to live at once. For a new track or a pause, where Spotify's
    /// audio is never coming back to meet it.
    public func cancelJump() {
        lock.lock()
        defer { lock.unlock() }
        pending = nil
        spin = nil
        if detached != nil {
            settle(.cancelled)
            goLive()
        }
    }

    /// Where the sound `back` frames before what plays now is (after it, for a negative `back`).
    private func target(back: Int) -> Copy? {
        copy(ofClock: head - headDelta - back, room: 2 * fadeFrames)
    }

    /// The newest stretch of ring holding the moment `clock` with `room` frames to play after it,
    /// leaving out the stretch that holds ring position `outside`.
    private func copy(ofClock clock: Int, room: Int, outside: Int? = nil) -> Copy? {
        let oldest = written - capacity + room
        for segment in segments.reversed() {
            let end = segment.end ?? written
            if let outside, outside >= segment.start, outside < end { continue }
            let position = clock + segment.delta
            if position >= segment.start, position + room < end, position > oldest {
                return Copy(position: position, delta: segment.delta, end: segment.end)
            }
        }
        return nil
    }

    private func perform(_ jump: Jump, lag lagBefore: Int? = nil) {
        guard let to = target(back: jump.back) else { return }
        let lag = lagBefore ?? detached?.lag ?? max(0, written - head)
        // What the tap writes from here on is Spotify being re-seeked: unknown until it is found again.
        if let open = segments.indices.last, segments[open].end == nil {
            segments[open].end = written
        }
        crossfade(to: to.position, sameSound: jump.alike)
        headDelta = to.delta
        headEnd = to.end ?? written
        settle(.chopped)
        jumpCount += 1
        if chopLog.count >= Self.chopLogSize { chopLog.removeFirst() }
        chopLog.append(ChopRecord(
            number: jumpCount, askedFrames: jump.asked, madeFrames: jump.back, outcome: nil,
            gapMs: nil, bestScore: 0, tookMs: nil, repeatMs: nil, startedAt: played
        ))
        catching = false
        rejoin = nil
        detached = Detached(
            since: written,
            lag: lag,
            seekAhead: jump.seekAhead,
            deadline: played + Int(sampleRate * patienceSeconds),
            episode: jumpCount
        )
    }

    /// Playing from memory: onto Spotify's copy once the output reaches it; on into another copy of
    /// the song at the end of this one; back to live when Spotify takes too long or memory runs out.
    private func steer(_ state: Detached) {
        if rejoin != nil {
            if tryRejoin() { return }
        } else if played >= state.deadline {
            giveUp()
            return
        }
        guard head + fadeFrames >= headEnd, fadeLeft == 0 || head >= headEnd else { return }
        if !hop() { giveUp() }
    }

    /// The same moment of the song in another stretch of the ring, joined seamlessly. False when there is none.
    private func hop() -> Bool {
        guard let next = copy(ofClock: head - headDelta, room: 2 * fadeFrames, outside: head) else { return false }
        crossfade(to: next.position, sameSound: true)
        headDelta = next.delta
        headEnd = next.end ?? .max
        return true
    }

    private func giveUp() {
        fallbackCount += 1
        settle(.wentLive)
        goLive()
    }

    /// The chop still waiting on Spotify, if there is one, as it ends.
    private func settle(_ outcome: Outcome, repeatFrames: Int? = nil, gapMs: Double? = nil) {
        guard let i = chopLog.indices.last, chopLog[i].outcome == nil else { return }
        chopLog[i].outcome = outcome
        chopLog[i].tookMs = Double(played - chopLog[i].startedAt) / sampleRate * 1000
        if let repeatFrames { chopLog[i].repeatMs = Double(repeatFrames) / sampleRate * 1000 }
        if let gapMs { chopLog[i].gapMs = gapMs }
    }

    /// Back to whatever Spotify is playing now. Memory no longer lines up with it, so the content
    /// clock starts over and nothing before this point can be jumped to.
    private func goLive() {
        let to = max(0, written - targetLag)
        if to != head { crossfade(to: to) }
        segments.removeAll(keepingCapacity: true)
        segments.append(Segment(start: to, end: nil, delta: 0))
        headDelta = 0
        headEnd = .max
        detached = nil
        rejoin = nil
        catching = false
    }

    /// Crosses onto Spotify's copy once the output reaches the first of it. False while still short of it.
    private func tryRejoin() -> Bool {
        guard let found = rejoin else { return false }
        let live = head - headDelta + found.delta
        guard live >= found.from else { return false }
        if live <= written - fadeFrames {
            crossfade(to: live, sameSound: true)
            settle(.realigned, gapMs: found.gapMs)
        } else {
            // Spotify came back behind what memory is playing: rejoin live, repeating a moment.
            let to = max(found.from, written - targetLag)
            crossfade(to: to)
            settle(.behind, repeatFrames: live - to, gapMs: found.gapMs)
        }
        if segments.count >= Self.maxSegments {
            segments.removeFirst(segments.count - Self.maxSegments + 1)
        }
        segments.append(Segment(start: found.from, end: nil, delta: found.delta))
        headDelta = found.delta
        headEnd = .max
        rejoin = nil
        detached = nil
        realignCount += 1
        catching = written - head > maxLag
        return true
    }

    // MARK: Realignment

    /// Called off the audio thread every few tens of milliseconds while detached. Looks for the
    /// newest audio in the memory the output is playing from; once it is found, the output crosses
    /// onto Spotify's copy of the same sound where the two meet.
    @discardableResult
    public func realign() -> Realign {
        lock.lock()
        guard let state = detached else {
            lock.unlock()
            return .notDetached
        }
        guard rejoin == nil else {
            lock.unlock()
            return .locked
        }
        // Mid-spin the head stands still; what Spotify sends is matched once the spin has landed.
        guard spin == nil else {
            lock.unlock()
            return .waiting
        }
        let w = written
        let deckClock = head - headDelta
        let known = segments.filter { $0.end != nil }
        lock.unlock()

        let probeLength = 4_096
        guard w - state.since >= Int(sampleRate * 0.05) + probeLength else { return .waiting }
        // Everything is compared below 4 kHz: see `bandKernel`.
        let kernel = Self.bandKernel(sampleRate: sampleRate)
        let mono = { (start: Int, count: Int) in self.monoCopy(from: start, count: count, upTo: w, kernel: kernel) }

        // The newest audio, and the moment of the song the deck was playing when it began to
        // arrive. Spotify, aimed a little ahead of the jump, comes back somewhere near that.
        let probeStart = w - probeLength
        let probe = mono(probeStart, probeLength)
        let deckAtProbe = deckClock - probeLength
        let lowClock = deckAtProbe - Int(sampleRate * 0.5)
        let highClock = deckAtProbe + Int(sampleRate * 0.8)
        // Well clear of where the tap is overwriting the ring.
        let oldest = w - capacity + Int(sampleRate)

        var best: (clock: Int, distance: Int)?
        var seen: Float = 0
        for segment in known {
            guard let end = segment.end else { continue }
            let lo = max(segment.start, lowClock + segment.delta, oldest)
            let hi = min(end - probeLength, highClock + segment.delta)
            guard hi > lo else { continue }
            let region = mono(lo, hi - lo + probeLength)
            guard let match = Match.best(probe: probe, region: region, expected: deckAtProbe + segment.delta - lo) else { continue }
            seen = max(seen, match.score)
            guard match.score >= 0.97 else { continue }
            let clock = lo + match.offset - segment.delta
            let distance = abs(clock - deckAtProbe)
            if let current = best, current.distance <= distance { continue }
            best = (clock, distance)
        }
        lock.lock()
        if detached?.episode == state.episode, let i = chopLog.indices.last, chopLog[i].outcome == nil {
            chopLog[i].bestScore = max(chopLog[i].bestScore, seen)
        }
        lock.unlock()
        guard let match = best else { return .waiting }

        // Spotify's copy at a steady level: a fade-in after its seek, or its silence still in the
        // probe, is waited out, and the level it settles at is the level the rest of it must have.
        guard let memoryAtProbe = Self.position(ofClock: match.clock, length: probeLength, in: known, oldest: oldest) else { return .waiting }
        let memoryProbe = mono(memoryAtProbe, probeLength)
        let quarter = probeLength / 4
        guard let level = Self.gain(Array(probe.suffix(quarter)), Array(memoryProbe.suffix(quarter))),
              let overall = Self.gain(probe, memoryProbe),
              Self.within(overall, of: level, db: 0.5)
        else { return .waiting }

        // How far ahead of the deck Spotify came back, against how far ahead it was aimed, is what
        // its restart cost.
        let ahead = match.clock - deckAtProbe
        let gapFrames = state.seekAhead - ahead
        // Further ahead than SLAB aimed: not this seek's audio.
        guard gapFrames > -Int(sampleRate * 0.03) else { return .waiting }
        let delta = probeStart - match.clock

        // How far back Spotify's copy runs, a block at a time: the same sound, at the same level.
        let alike = { (theirs: [Float], ours: [Float]) -> Bool in
            Match.similarity(theirs, ours) >= 0.97 && Self.gain(theirs, ours).map { Self.within($0, of: level, db: 1) } == true
        }
        var from = probeStart
        while from - state.since >= 64 {
            let start = max(state.since, from - 1_024)
            let length = from - start
            guard let memory = Self.position(ofClock: start - delta, length: length, in: known, oldest: oldest),
                  alike(mono(start, length), mono(memory, length))
            else { break }
            from = start
        }
        // All the way back to the chop: that is the record still playing on from before Spotify's
        // seek took hold, matching only because the music repeats. Wait for the seek itself.
        guard from - state.since >= 64 else { return .waiting }
        // A block that matched can begin with a few frames of what came before it: start where a
        // short window matches too.
        for _ in 0..<16 {
            guard from + 64 <= probeStart,
                  let memory = Self.position(ofClock: from - delta, length: 64, in: known, oldest: oldest),
                  !alike(mono(from, 64), mono(memory, 64))
            else { break }
            from += 64
        }

        lock.lock()
        defer { lock.unlock() }
        // A chop since the snapshot: this match was for a seek that no longer counts.
        guard let current = detached, current.episode == state.episode, rejoin == nil else { return .waiting }
        if gaps.count >= 7 { gaps.removeFirst(gaps.count - 6) }
        gaps.append(Double(gapFrames) / sampleRate * 1000)
        rejoin = Rejoin(delta: delta, from: from, gapMs: Double(gapFrames) / sampleRate * 1000)
        if tryRejoin() { return .aligned(lagFrames: max(0, written - head)) }
        return .locked
    }

    /// Where in the known stretches of ring the moment `clock` sits with `length` frames after it.
    private static func position(ofClock clock: Int, length: Int, in segments: [Segment], oldest: Int) -> Int? {
        for segment in segments.reversed() {
            guard let end = segment.end else { continue }
            let at = clock + segment.delta
            if at >= segment.start, at + length <= end, at >= oldest { return at }
        }
        return nil
    }

    /// The two channels mixed to one and filtered through `kernel`, centred: `count` frames from
    /// `start`, using the frames either side of them, and treating anything at or past `limit` (not
    /// written yet) as silence. Read without the lock: everything asked for was written before the
    /// caller looked at `written`, and the tap is nowhere near overwriting it.
    private func monoCopy(from start: Int, count: Int, upTo limit: Int, kernel: [Float]) -> [Float] {
        guard count > 0, start >= 0 else { return [] }
        let half = kernel.count / 2
        let span = count + 2 * half
        var raw = [Float](repeating: 0, count: span)
        raw.withUnsafeMutableBufferPointer { o in
            for i in 0..<span {
                let position = start - half + i
                guard position >= 0, position < limit else { continue }
                let at = position % capacity
                o[i] = (left[at] + right[at]) * 0.5
            }
        }
        var out = [Float](repeating: 0, count: count)
        raw.withUnsafeBufferPointer { r in
            kernel.withUnsafeBufferPointer { k in
                out.withUnsafeMutableBufferPointer { o in
                    guard let rBase = r.baseAddress, let kBase = k.baseAddress, let oBase = o.baseAddress else { return }
                    #if canImport(Accelerate)
                    vDSP_conv(rBase, 1, kBase, 1, oBase, 1, vDSP_Length(count), vDSP_Length(kernel.count))
                    #else
                    for i in 0..<count { oBase[i] = Match.dot(rBase + i, kBase, kernel.count) }
                    #endif
                }
            }
        }
        return out
    }

    /// A low-pass at 4 kHz, 33 taps, Hann-windowed: what realignment compares. Spotify's 44.1 kHz
    /// stream is resampled for most Macs' 48 kHz output, and after a seek the resampler restarts at
    /// another phase, so its copy of the song can fall up to half a sample between the frames memory
    /// holds. Full band, that drops a trap record's bright hi-hats below any threshold worth trusting;
    /// below 4 kHz the same sound still scores 0.99 and a different place still scores nothing.
    static func bandKernel(sampleRate: Double) -> [Float] {
        let half = 16
        let cutoff = 4_000 / sampleRate
        var kernel = (-half...half).map { k -> Double in
            let x = Double(k)
            let sinc = k == 0 ? 2 * cutoff : sin(2 * .pi * cutoff * x) / (.pi * x)
            return sinc * (0.5 + 0.5 * cos(.pi * x / Double(half + 1)))
        }
        let sum = kernel.reduce(0, +)
        kernel = kernel.map { $0 / sum }
        return kernel.map { Float($0) }
    }

    // MARK: Tightening a chop

    /// `back` frames, tightened to where the record itself repeats. Spotify's beat grid can sit a few
    /// milliseconds off a record's real beat, and a chop that far off flams: the kick lands twice.
    /// Within 25 ms of `back`, the lag at which the record's attacks line up best, if they clearly do
    /// (a loop, a drum pattern), found to the sample; with nothing that repeats, `back` as asked.
    /// `alike` when the two sides of the cut are near enough the same sound to be crossed straight.
    func tightened(_ back: Int) -> (frames: Int, alike: Bool) {
        let reach = Int(sampleRate * 0.025)
        lock.lock()
        let w = written
        let riding = detached == nil && spin == nil
        let liveStart: Int? = segments.last.flatMap { $0.end == nil ? $0.start : nil }
        let reuse = lastTight
        lock.unlock()
        // Every pass of a loop jumps the same distance: the first pass's tightening is kept a while.
        if let reuse, abs(reuse.asked - back) <= 1, w - reuse.at < Int(sampleRate * 20) { return (reuse.made, reuse.alike) }
        guard back > 4 * reach, riding, let liveStart else { return (back, false) }

        // Coarse, in half-millisecond steps: the newest 0.75 s of attacks against the same stretch
        // `back` earlier, give or take the reach.
        let step = max(1, Int((sampleRate / 2_000).rounded()))
        let reachBlocks = (reach + step - 1) / step
        let n = Int(sampleRate * 0.75) / step
        let probeStart = w - n * step
        let pastStart = probeStart - back - reachBlocks * step
        guard pastStart > liveStart, pastStart > w - capacity + Int(sampleRate) else { return (back, false) }
        let probe = attackEnvelope(from: probeStart, blocks: n, step: step)
        let past = attackEnvelope(from: pastStart, blocks: n + 2 * reachBlocks, step: step)
        var best: (offset: Int, r: Float)?
        for offset in 0...(2 * reachBlocks) {
            let r = Self.pearson(probe, past[offset..<(offset + n)])
            if best == nil || r > best!.r { best = (offset, r) }
        }
        // A clear match, and a peak of its own: one at the edge of the reach is the slope of something
        // further off (a hi-hat pattern the chop isn't in step with), not a beat to tighten to.
        guard let coarse = best, coarse.r >= 0.65, coarse.offset > 0, coarse.offset < 2 * reachBlocks else { return (back, false) }
        let center = back + (reachBlocks - coarse.offset) * step

        // Fine, to the sample, by the waveform below 4 kHz around the coarse lag.
        let kernel = Self.bandKernel(sampleRate: sampleRate)
        let fine = Int(sampleRate * 0.25)
        let end = w - kernel.count
        let ours = monoCopy(from: end - fine, count: fine, upTo: w, kernel: kernel)
        let theirs = monoCopy(from: end - fine - center - step, count: fine + 2 * step, upTo: w, kernel: kernel)
        var made = center
        var top: Float = -2
        for k in 0...(2 * step) {
            let score = Match.similarity(ours, Array(theirs[k..<(k + fine)]))
            if score > top {
                top = score
                made = center + step - k
            }
        }
        guard abs(made - back) <= reach else { return (back, false) }
        let alike = top >= 0.9
        lock.lock()
        lastTight = (asked: back, made: made, alike: alike, at: w)
        lock.unlock()
        return (made, alike)
    }

    /// How hard the record attacks, `step` frames at a time: each frame's change from the one before,
    /// rectified and averaged. Kicks, snares and hats stand up out of it; the 808's long notes, which
    /// repeat every few milliseconds and would line up almost anywhere, don't.
    private func attackEnvelope(from start: Int, blocks: Int, step: Int) -> [Float] {
        var out = [Float](repeating: 0, count: max(0, blocks))
        guard blocks > 0, start > 0 else { return out }
        var at = (start - 1) % capacity
        var previous = (left[at] + right[at]) * 0.5
        for b in 0..<blocks {
            var sum: Float = 0
            for k in 0..<step {
                at = (start + b * step + k) % capacity
                let x = (left[at] + right[at]) * 0.5
                sum += abs(x - previous)
                previous = x
            }
            out[b] = sum / Float(step)
        }
        return out
    }

    /// How alike two envelopes rise and fall, -1 to 1, whatever their levels; 0 when either is flat.
    static func pearson(_ a: [Float], _ b: ArraySlice<Float>) -> Float {
        let n = min(a.count, b.count)
        guard n > 1 else { return 0 }
        var meanA: Float = 0
        var meanB: Float = 0
        var i = b.startIndex
        for k in 0..<n {
            meanA += a[k]
            meanB += b[i]
            i += 1
        }
        meanA /= Float(n)
        meanB /= Float(n)
        var ab: Float = 0
        var aa: Float = 0
        var bb: Float = 0
        i = b.startIndex
        for k in 0..<n {
            let x = a[k] - meanA
            let y = b[i] - meanB
            ab += x * y
            aa += x * x
            bb += y * y
            i += 1
        }
        guard aa > 1e-12, bb > 1e-12 else { return 0 }
        return ab / (aa * bb).squareRoot()
    }

    /// How much louder `a` is than `b` (1 for the same level); nil when either is silent.
    static func gain(_ a: [Float], _ b: [Float]) -> Float? {
        let aa = Match.dot(a, a)
        let bb = Match.dot(b, b)
        guard aa > 1e-9, bb > 1e-9 else { return nil }
        return (aa / bb).squareRoot()
    }

    /// `value` is within `db` decibels of `reference`.
    static func within(_ value: Float, of reference: Float, db: Float) -> Bool {
        abs(20 * log10(value / reference)) <= db
    }
}
