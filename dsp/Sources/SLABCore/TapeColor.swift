import Foundation

/// The sound of the medium, laid over the record: a cassette's hiss, a played record's
/// crackle, the grit of a cheap sampler. It runs on the audio thread right after the deck,
/// costs a few multiplies a frame and allocates nothing. With everything off it doesn't
/// touch a sample.
public final class TapeColor: @unchecked Sendable {
    public struct Settings: Equatable, Sendable {
        /// 0 is none, 1 is a worn cassette's hiss.
        public var hiss: Float
        /// 0 is none, 1 is a record that's been played a lot.
        public var crackle: Float
        /// 0 is clean, 1 is crunched down to a cheap sampler.
        public var crush: Float

        public init(hiss: Float = 0, crackle: Float = 0, crush: Float = 0) {
            self.hiss = max(0, min(1, hiss))
            self.crackle = max(0, min(1, crackle))
            self.crush = max(0, min(1, crush))
        }

        public static let clean = Settings()
    }

    private let sampleRate: Double
    private let lock = NSLock()
    private var settings = Settings.clean

    /// xorshift64*, so the noise needs no system call and the same seed is the same noise.
    private var seed: UInt64
    /// Hiss: a high-pass to take the rumble out, then a gentle low-pass off the very top, per channel.
    private var hissIn: (Float, Float) = (0, 0)
    private var hissHigh: (Float, Float) = (0, 0)
    private var hissOut: (Float, Float) = (0, 0)
    /// The tick ringing out now: its level, how fast it dies, and the phase it rings at.
    private var tickLevel: Float = 0
    private var tickDecay: Float = 0
    private var tickPhase: Float = 0
    private var tickStep: Float = 0
    /// The sampler holding each value for a few frames.
    private var holdLeft = 0
    private var held: (Float, Float) = (0, 0)

    /// Ticks a second at full crackle, and the rarer, bigger pops among them.
    static let ticksPerSecond: Double = 7
    static let popsPerSecond: Double = 0.45
    static let hissLevel: Float = 0.01

    public init(sampleRate: Double, seed: UInt64 = 0x51AB_7A9E) {
        self.sampleRate = sampleRate
        self.seed = seed == 0 ? 0x51AB : seed
    }

    public func set(_ new: Settings) {
        lock.lock()
        settings = new
        lock.unlock()
    }

    public var current: Settings {
        lock.lock()
        defer { lock.unlock() }
        return settings
    }

    /// A uniform value in [0, 1).
    @inline(__always)
    private func random() -> Float {
        seed ^= seed >> 12
        seed ^= seed << 25
        seed ^= seed >> 27
        return Float((seed &* 0x2545_F491_4F6C_DD1D) >> 40) / Float(1 << 24)
    }

    public func process(_ left: UnsafeMutablePointer<Float>, _ right: UnsafeMutablePointer<Float>, frames: Int) {
        lock.lock()
        let s = settings
        lock.unlock()
        guard s != .clean, frames > 0 else { return }

        // The crush: held for a few frames, then cut to fewer bits.
        let hold = 1 + Int((s.crush * 4).rounded())
        let levels = Float(1 << max(5, 12 - Int((s.crush * 5).rounded())))
        // The crackle: a chance a frame of a tick starting, and of a pop.
        let tickChance = Float(Self.ticksPerSecond * Double(s.crackle) / sampleRate)
        let popChance = Float(Self.popsPerSecond * Double(s.crackle) / sampleRate)
        let hissGain = Self.hissLevel * s.hiss

        for i in 0..<frames {
            var l = left[i]
            var r = right[i]

            if s.crush > 0 {
                if holdLeft <= 0 {
                    held = ((l * levels).rounded() / levels, (r * levels).rounded() / levels)
                    holdLeft = hold
                }
                holdLeft -= 1
                l = held.0
                r = held.1
            }

            if hissGain > 0 {
                let a = random() * 2 - 1
                let b = random() * 2 - 1
                hissHigh.0 = 0.62 * (hissHigh.0 + a - hissIn.0)
                hissHigh.1 = 0.62 * (hissHigh.1 + b - hissIn.1)
                hissIn = (a, b)
                hissOut.0 += 0.55 * (hissHigh.0 - hissOut.0)
                hissOut.1 += 0.55 * (hissHigh.1 - hissOut.1)
                l += hissOut.0 * hissGain
                r += hissOut.1 * hissGain
            }

            if s.crackle > 0 {
                if tickLevel < 1e-4 {
                    let roll = random()
                    if roll < popChance {
                        // A pop: low and slow to die.
                        tickLevel = (0.12 + 0.18 * random()) * s.crackle * (random() < 0.5 ? -1 : 1)
                        tickDecay = Float(exp(-1 / (0.0016 * sampleRate)))
                        tickStep = Float(2 * Double.pi * Double(300 + 600 * random()) / sampleRate)
                        tickPhase = 0
                    } else if roll < popChance + tickChance {
                        // A tick: bright and gone in a fraction of a millisecond.
                        let size = random()
                        tickLevel = (0.02 + 0.1 * size * size) * s.crackle * (random() < 0.5 ? -1 : 1)
                        tickDecay = Float(exp(-1 / (0.00025 * sampleRate)))
                        tickStep = Float(2 * Double.pi * Double(2_500 + 3_500 * random()) / sampleRate)
                        tickPhase = 0
                    }
                }
                if tickLevel != 0 {
                    let v = tickLevel * cos(tickPhase)
                    l += v
                    r += v * 0.92
                    tickPhase += tickStep
                    tickLevel *= tickDecay
                    if abs(tickLevel) < 1e-4 { tickLevel = 0 }
                }
            }

            left[i] = l
            right[i] = r
        }
    }
}
