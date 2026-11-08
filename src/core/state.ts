import type { SavedMoodState, SlabState } from "../types";
import { BANDS, MINE_ID, moodById, setMine } from "./moods";

const KEY = "slab:state:v1";

const DEFAULTS: SlabState = {
    moodId: "flat",
    auto: false,
    open: false,
    every: 4,
    pitch: 0,
    eqOwner: "auto",
    bank: "chop",
    screwDepth: 5,
    mine: null,
};

/** The one rule for a pitch value: ±1200 cents, on the slider's 10-cent grid. */
export function clampPitch(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(-1200, Math.min(1200, Math.round(value / 10) * 10));
}

/** How far Screw can ride down: a semitone to an octave. */
export const SCREW_MIN = 1;
export const SCREW_MAX = 12;

function finite(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A kept sound as stored, or null if it doesn't hold together. */
function readMine(raw: unknown): SavedMoodState | null {
    if (!raw || typeof raw !== "object") return null;
    const saved = raw as Partial<SavedMoodState>;
    if (typeof saved.from !== "string" || !Array.isArray(saved.gains) || saved.gains.length !== BANDS.length) return null;
    if (!saved.gains.every((gain) => typeof gain === "number" && Number.isFinite(gain))) return null;
    const dsp = (saved.dsp ?? {}) as Partial<SavedMoodState["dsp"]>;
    return {
        from: saved.from,
        gains: saved.gains.map((gain) => Math.max(-12, Math.min(12, gain))),
        dsp: {
            pitch: clampPitch(finite(dsp.pitch, 0)),
            reverb: finite(dsp.reverb, 0),
            reverbPreset: typeof dsp.reverbPreset === "string" ? dsp.reverbPreset : "largeHall2",
            delayTime: finite(dsp.delayTime, 0.36),
            delayFeedback: finite(dsp.delayFeedback, 0),
            delayMix: finite(dsp.delayMix, 0),
            lowpass: finite(dsp.lowpass, 20_000),
            gain: finite(dsp.gain, 0),
        },
    };
}

export function loadState(): SlabState {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) {
            setMine(null);
            return { ...DEFAULTS };
        }
        const parsed = JSON.parse(raw) as Partial<SlabState>;
        const mine = readMine(parsed.mine);
        setMine(mine);
        // Mine picked but nothing kept in it (the store was edited, or cleared): Flat.
        const moodId = typeof parsed.moodId === "string" && (parsed.moodId !== MINE_ID || mine) ? parsed.moodId : DEFAULTS.moodId;
        return {
            moodId,
            auto: parsed.auto === true,
            open: parsed.open === true,
            every:
                typeof parsed.every === "number" && parsed.every >= 1 && parsed.every <= 16
                    ? parsed.every
                    : DEFAULTS.every,
            // State saved before the slider existed has no pitch; the mood's is the truth.
            pitch: typeof parsed.pitch === "number" ? clampPitch(parsed.pitch) : moodById(moodId).dsp.pitch,
            eqOwner:
                parsed.eqOwner === "slab" || parsed.eqOwner === "modern"
                    ? parsed.eqOwner
                    : DEFAULTS.eqOwner,
            bank: parsed.bank === "screw" ? "screw" : "chop",
            screwDepth:
                typeof parsed.screwDepth === "number" && parsed.screwDepth >= SCREW_MIN && parsed.screwDepth <= SCREW_MAX
                    ? Math.round(parsed.screwDepth)
                    : DEFAULTS.screwDepth,
            mine,
        };
    } catch {
        setMine(null);
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
