export interface Grid {
    uri: string;
    tempo: number;
    timeSignature: number;
    beats: number[];
    bars: number[];
    durationMs: number;
}

export interface SlabState {
    moodId: string;
    auto: boolean;
    open: boolean;
    /** Bars between automatic chops when auto is on. */
    every: number;
    /** Live pitch in cents (−1200…+1200). Moods set it; the slider moves it. */
    pitch: number;
    /**
     * Who owns the six native filters when ModernEQ is installed.
     * `auto` yields to ModernEQ, `slab` takes the bands back.
     */
    eqOwner: "auto" | "slab" | "modern";
    /** Which pads show: the cuts (keys 1–5) or the holds and the spin (6–0). Both always play. */
    bank: "chop" | "screw";
    /** How far the Screw pad rides the pitch down, in semitones. */
    screwDepth: number;
    /** The sound kept in the Mine door, or null while it's empty. */
    mine: SavedMoodState | null;
}

/** As stored: see `SavedMood` in core/moods. */
export interface SavedMoodState {
    from: string;
    gains: number[];
    dsp: {
        pitch: number;
        reverb: number;
        reverbPreset: string;
        delayTime: number;
        delayFeedback: number;
        delayMix: number;
        lowpass: number;
        gain: number;
    };
}
