import type { SlabState } from "../types";

const KEY = "slab:state:v1";

const DEFAULTS: SlabState = {
    moodId: "flat",
    auto: false,
    open: false,
    every: 4,
};

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
