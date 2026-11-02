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
}
