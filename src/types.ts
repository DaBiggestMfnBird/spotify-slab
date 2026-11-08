export interface Grid {
    uri: string;
    tempo: number;
    timeSignature: number;
    beats: number[];
    bars: number[];
    durationMs: number;
    /** The song's sections as Spotify's analysis hears them: where each starts, and how loud it is. */
    sections: Section[];
}

export interface Section {
    /** ms into the track. */
    start: number;
    /** dB, as the analysis reports it; the loudest are the hooks. */
    loudness: number;
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
    /** Which pads show: the cuts (keys 1–5), the holds and the spin (6–0), or the tape. The keys always play. */
    bank: "chop" | "screw" | "tape";
    /** How far the Screw pad rides the pitch down, in semitones. */
    screwDepth: number;
    /** The sound kept in the Mine door, or null while it's empty. */
    mine: SavedMoodState | null;
    /** What the record is played through, over whatever mood is on. */
    tape: TapeState;
    /** DJ mode: SLAB plays the moves itself. */
    dj: boolean;
    /** The sound from before DJ mode put the record on full screw, to go back to after. */
    djBefore: { moodId: string; pitch: number; tape: TapeState } | null;
}

export interface TapeState {
    /** The reverb's room, over the mood's own; null keeps the mood's. */
    room: string | null;
    wow: boolean;
    hiss: boolean;
    crackle: boolean;
    crush: boolean;
}

/** As stored: see `SavedMood` in core/moods. */
export interface SavedMoodState {
    from: string;
    gains: number[];
    /** The tape it was kept with; older keeps have none and leave the tape as it is. */
    tape?: TapeState;
    dsp: {
        pitch: number;
        reverb: number;
        reverbPreset: string;
        delayTime: number;
        delayFeedback: number;
        delayMix: number;
        lowpass: number;
        gain: number;
        wow: number;
        hiss: number;
        crackle: number;
        crush: number;
    };
}
