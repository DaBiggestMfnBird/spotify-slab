/**
 * Native equalizer bridge.
 *
 * The client exposes six filters. We never invent filters we don't have, and we
 * never leave the user's original gains behind: the first time SLAB loads it
 * snapshots whatever was there and restores that on Flat and on unload.
 */

import { BANDS } from "./moods";

const BASELINE_KEY = "slab:baseline:v1";
const GAIN_LIMIT = 12;

let filters: SlabEqualizerFilter[] = [];
let baseline: Record<string, number> | null = null;
let chain: Promise<void> = Promise.resolve();
let ready = false;

function readBaseline(): Record<string, number> | null {
    try {
        const raw = localStorage.getItem(BASELINE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Record<string, number>;
        return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
        return null;
    }
}

function writeBaseline(value: Record<string, number>): void {
    try {
        localStorage.setItem(BASELINE_KEY, JSON.stringify(value));
    } catch {
        /* storage full or blocked — not fatal */
    }
}

export function eqAvailable(): boolean {
    return ready && filters.length > 0;
}



export async function initEq(): Promise<boolean> {
    const api = Spicetify.Platform.EqualizerAPI;
    if (!api) return false;
    try {
        const list = await api.getFilters();
        if (!list.length) return false;
        filters = [...list].sort((a, b) => a.frequency - b.frequency);

        const saved = readBaseline();
        baseline =
            saved ??
            Object.fromEntries(filters.map((filter) => [filter.key, filter.gain]));
        if (!saved) writeBaseline(baseline);

        ready = true;
        return true;
    } catch {
        return false;
    }
}

function clamp(value: number): number {
    return Math.max(-GAIN_LIMIT, Math.min(GAIN_LIMIT, value));
}

/**
 * Apply a curve. Bands are matched by frequency so a client that ships a
 * different filter set still gets a sane mapping instead of silence.
 */
export function applyCurve(gainsDb: number[]): Promise<void> {
    const api = Spicetify.Platform.EqualizerAPI;
    if (!api || !filters.length) return Promise.resolve();

    chain = chain
        .then(async () => {
            api.setEnabledState(true);
            for (let index = 0; index < filters.length; index += 1) {
                const filter = filters[index];
                const band = nearestBand(filter.frequency);
                const gain = clamp(gainsDb[band] ?? 0);
                try {
                    await api.setFilterGain(filter.key, gain);
                } catch {
                    /* one dead filter shouldn't stop the curve */
                }
            }
        })
        .catch(() => undefined);

    return chain;
}

function nearestBand(frequency: number): number {
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < BANDS.length; index += 1) {
        const distance = Math.abs(Math.log(frequency) - Math.log(BANDS[index]));
        if (distance < bestDistance) {
            bestDistance = distance;
            best = index;
        }
    }
    return best;
}

/**
 * Write a curve that is given at explicit frequencies instead of SLAB's six
 * bands. ModernEQ stores its eleven bands this way, so handing the filters back
 * means mapping each native filter to the nearest of those points — in log
 * frequency, so the low end isn't over-weighted.
 */
export function applyCurveAtFrequencies(
    points: { frequency: number; gain: number }[],
): Promise<void> {
    const api = Spicetify.Platform.EqualizerAPI;
    if (!api || !filters.length || !points.length) return Promise.resolve();

    chain = chain
        .then(async () => {
            api.setEnabledState(true);
            for (const filter of filters) {
                let best = points[0];
                let bestDistance = Infinity;
                for (const point of points) {
                    const distance = Math.abs(
                        Math.log(filter.frequency) - Math.log(point.frequency),
                    );
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = point;
                    }
                }
                try {
                    await api.setFilterGain(filter.key, clamp(best.gain));
                } catch {
                    /* one dead filter shouldn't stop the curve */
                }
            }
        })
        .catch(() => undefined);

    return chain;
}

export function restoreBaseline(): Promise<void> {
    const api = Spicetify.Platform.EqualizerAPI;
    if (!api || !baseline || !filters.length) return Promise.resolve();

    chain = chain
        .then(async () => {
            for (const filter of filters) {
                const gain = baseline?.[filter.key];
                if (typeof gain !== "number") continue;
                try {
                    await api.setFilterGain(filter.key, gain);
                } catch {
                    /* ignore */
                }
            }
        })
        .catch(() => undefined);

    return chain;
}


