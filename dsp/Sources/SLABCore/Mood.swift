/// What SLAB sets on the helper's sound and leaves set: the mood.
public struct DSPParams: Codable, Equatable, Sendable {
    /// Pitch shift in cents. 0 = untouched. -1200 = one octave down.
    public var pitch: Float
    /// Reverb wet/dry, 0...100.
    public var reverb: Float
    /// Reverb character.
    public var reverbPreset: String
    /// Delay time in seconds.
    public var delayTime: Double
    /// Delay feedback, 0...95.
    public var delayFeedback: Float
    /// Delay wet/dry, 0...100.
    public var delayMix: Float
    /// Low-pass cutoff in Hz. 20000 = bypass.
    public var lowpass: Float
    /// Output trim in dB.
    public var gain: Float
    /// Tape: a worn cassette's wow (the speed wandering), its hiss, a record's crackle, and a
    /// cheap sampler's crunch. Each 0...1, 0 = off.
    public var wow: Float
    public var hiss: Float
    public var crackle: Float
    public var crush: Float

    public init(
        pitch: Float = 0, reverb: Float = 0, reverbPreset: String = "largeHall2",
        delayTime: Double = 0.36, delayFeedback: Float = 0, delayMix: Float = 0,
        lowpass: Float = 20_000, gain: Float = 0,
        wow: Float = 0, hiss: Float = 0, crackle: Float = 0, crush: Float = 0
    ) {
        self.pitch = pitch
        self.reverb = reverb
        self.reverbPreset = reverbPreset
        self.delayTime = delayTime
        self.delayFeedback = delayFeedback
        self.delayMix = delayMix
        self.lowpass = lowpass
        self.gain = gain
        self.wow = wow
        self.hiss = hiss
        self.crackle = crackle
        self.crush = crush
    }

    public static let neutral = DSPParams()
}

/// A pad held on top of the mood: let it go and the mood is back. Each part ramps.
public struct Hold: Equatable, Sendable {
    /// Added to the mood's pitch, in cents.
    public var pitchOffset: Float
    /// The low-pass can't open past this, in Hz. 20000 = no cap.
    public var lowpassCap: Float
    /// Added to the output trim, in dB.
    public var gainBoost: Float
    /// An echo over the mood's own delay: wet 0...100, feedback 0...95, time in seconds.
    public var echoMix: Float
    public var echoFeedback: Float
    public var echoTime: Double

    public init(
        pitchOffset: Float = 0, lowpassCap: Float = 20_000, gainBoost: Float = 0,
        echoMix: Float = 0, echoFeedback: Float = 0, echoTime: Double = 0.36
    ) {
        self.pitchOffset = pitchOffset
        self.lowpassCap = lowpassCap
        self.gainBoost = gainBoost
        self.echoMix = echoMix
        self.echoFeedback = echoFeedback
        self.echoTime = echoTime
    }

    public static let none = Hold()
}
