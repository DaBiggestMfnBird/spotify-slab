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
}
