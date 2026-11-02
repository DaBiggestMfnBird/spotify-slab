/**
 * Beat grid.
 *
 * Spotify's own analysis endpoint gives us tempo, beats and bars for a track.
 * We cache per URI because the panel asks for the grid on every render tick.
 */

import type { Grid } from "../types";

const cache = new Map<string, Grid>();
const inflight = new Map<string, Promise<Grid | null>>();

function currentUri(): string | null {
    return Spicetify.Player.data?.item?.uri ?? null;
}

export async function loadGrid(uri?: string): Promise<Grid | null> {
    const target = uri ?? currentUri();
    if (!target) return null;
    if (!target.startsWith("spotify:track:")) return null;

    const cached = cache.get(target);
    if (cached) return cached;

    const running = inflight.get(target);
    if (running) return running;

    const request = (async (): Promise<Grid | null> => {
        try {
            const analysis = await Spicetify.getAudioData(target);
            const beats = (analysis.beats ?? []).map((beat) => beat.start * 1000);
            const bars = (analysis.bars ?? []).map((bar) => bar.start * 1000);
            if (beats.length < 2 || bars.length < 2) return null;

            const durationMs =
                (analysis.track?.duration ?? 0) * 1000 ||
                Spicetify.Player.getDuration() ||
                bars[bars.length - 1] + 4000;

            const grid: Grid = {
                uri: target,
                tempo: analysis.track?.tempo ?? 0,
                timeSignature: analysis.track?.time_signature ?? 4,
                beats,
                bars,
                durationMs,
            };
            cache.set(target, grid);
            return grid;
        } catch {
            return null;
        } finally {
            inflight.delete(target);
        }
    })();

    inflight.set(target, request);
    return request;
}

export function gridFor(uri?: string): Grid | null {
    const target = uri ?? currentUri();
    return target ? cache.get(target) ?? null : null;
}

export function clearGrids(): void {
    cache.clear();
    inflight.clear();
}

/** Index of the last marker at or before `ms`. Returns -1 when before the first. */
export function indexAt(markers: number[], ms: number): number {
    let low = 0;
    let high = markers.length - 1;
    let found = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (markers[mid] <= ms) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return found;
}

export function barIndexAt(grid: Grid, ms: number): number {
    return indexAt(grid.bars, ms);
}

export function barStartMs(grid: Grid, index: number): number {
    const clamped = Math.max(0, Math.min(grid.bars.length - 1, index));
    return grid.bars[clamped];
}

export function beatIndexAt(grid: Grid, ms: number): number {
    return indexAt(grid.beats, ms);
}

/** Milliseconds until the next beat lands. Capped so a bad grid can't stall a pad. */
export function msToNextBeat(grid: Grid, ms: number): number {
    const index = indexAt(grid.beats, ms);
    const next = grid.beats[index + 1];
    if (next === undefined) return 0;
    return Math.max(0, Math.min(900, next - ms));
}

export function barLengthMs(grid: Grid, index: number): number {
    const start = barStartMs(grid, index);
    const next = grid.bars[index + 1];
    return next !== undefined ? next - start : 2000;
}

export function barCount(grid: Grid): number {
    return grid.bars.length;
}
