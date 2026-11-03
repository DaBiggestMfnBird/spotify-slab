import type { SlabState } from "../types";
import { moodById } from "./moods";

const KEY = "slab:state:v1";

const DEFAULTS: SlabState = {
    moodId: "flat",
    auto: false,
    open: false,
    every: 4,
    pitch: 0,
    eqOwner: "auto",
};

/** The one rule for a pitch value: ±1200 cents, on the slider's 10-cent grid. */
export function clampPitch(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(-1200, Math.min(1200, Math.round(value / 10) * 10));
}

export function loadState(): SlabState {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { ...DEFAULTS };
        const parsed = JSON.parse(raw) as Partial<SlabState>;
        return {
            moodId: typeof parsed.moodId === "string" ? parsed.moodId : DEFAULTS.moodId,
            auto: parsed.auto === true,
            open: parsed.open === true,
            every:
                typeof parsed.every === "number" && parsed.every >= 1 && parsed.every <= 16
                    ? parsed.every
                    : DEFAULTS.every,
            // State saved before the slider existed has no pitch; the mood's is the truth.
            pitch:
                typeof parsed.pitch === "number"
                    ? clampPitch(parsed.pitch)
                    : moodById(parsed.moodId ?? DEFAULTS.moodId).dsp.pitch,
            eqOwner:
                parsed.eqOwner === "slab" || parsed.eqOwner === "modern"
                    ? parsed.eqOwner
                    : DEFAULTS.eqOwner,
        };
    } catch {
        return { ...DEFAULTS };
    }
}

export function saveState(state: SlabState): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        /* ignore */
    }
}
