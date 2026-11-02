/**
 * The performance half of SLAB.
 *
 * A chop is a seek. That sounds cheap until you put it on the grid: jump to the
 * top of a bar and it stops being a glitch and starts being an edit. Screw did
 * this with two turntables and a pause button.
 */

import { subscribe } from "./clock";
import { barIndexAt, barLengthMs, barStartMs, gridFor, loadGrid } from "./grid";

export type ChopKind = "chop" | "screw" | "spin" | "loop" | "stop" | "auto";

export interface ChopEvent {
    kind: ChopKind;
    label: string;
}

type Listener = (event: ChopEvent) => void;

let listener: Listener | null = null;
let busy = false;

let autoUnsub: (() => void) | null = null;
let autoEvery = 4;
let autoLastBar = -1;
let autoCounter = 0;
let autoCooldownUntil = 0;

let loopUnsub: (() => void) | null = null;

export function onChop(fn: Listener | null): void {
    listener = fn;
}

function emit(kind: ChopKind, label: string): void {
    listener?.({ kind, label });
}

async function ensureGrid() {
    return gridFor() ?? (await loadGrid());
}

function seek(ms: number): void {
    try {
        Spicetify.Player.seek(Math.max(0, Math.round(ms)));
    } catch {
        /* player not ready */
    }
}

/**
 * Jump back `bars` bars, always landing on a downbeat.
 *
 * CHOP lands on the top of the bar you're in, so pressing late in a bar replays
 * that bar. Press right after a downbeat and the guard sends you one bar
 * further so the pad never feels dead.
 */
export async function chopBars(bars: number): Promise<boolean> {
    if (busy) return false;
    busy = true;
    try {
        const grid = await ensureGrid();
        if (!grid) return false;

        const now = Spicetify.Player.getProgress();
        const index = barIndexAt(grid, now);
        const from = index < 0 ? 0 : index;
        const span = Math.max(1, Math.round(bars));

        let target = barStartMs(grid, from - (span - 1));
        if (now - target < 250) target = barStartMs(grid, from - span);
        if (now - target < 250) return false;

        seek(target);
        emit(span >= 4 ? "spin" : "chop", `−${span} bar${span === 1 ? "" : "s"}`);
        return true;
    } finally {
        busy = false;
    }
}

export function cancelLoop(): void {
    loopUnsub?.();
    loopUnsub = null;
}

/** Repeat the current bar `times` times, then let the record run. */
export async function loopBars(times = 4): Promise<boolean> {
    const grid = await ensureGrid();
    if (!grid) return false;

    cancelLoop();

    const index = Math.max(0, barIndexAt(grid, Spicetify.Player.getProgress()));
    const start = barStartMs(grid, index);
    const length = barLengthMs(grid, index);
    if (length < 300) return false;

    const total = Math.max(1, Math.round(times));
    let remaining = total;
    let due = Date.now() + length;

    loopUnsub = subscribe(() => {
        if (!Spicetify.Player.isPlaying()) {
            cancelLoop();
            return;
        }
        if (Date.now() < due) return;

        seek(start);
        remaining -= 1;
        due += length;
        if (remaining <= 0) {
            cancelLoop();
            emit("loop", `${total} bars`);
        }
    });

    emit("loop", `${total} bars`);
    return true;
}

/**
 * Tape stop: pull the fader down and pause, the way a 1200 does when the power
 * cuts. The fade runs on the worker clock so it stays smooth even if Spotify is
 * behind another window, and the fader comes back up at the pause so the next
 * play isn't silent.
 */
export async function tapeStop(): Promise<boolean> {
    if (!Spicetify.Player.isPlaying()) {
        emit("stop", "already stopped");
        return false;
    }

    const startVolume = Spicetify.Player.getVolume();
    const duration = 420;
    const origin = Date.now();

    await new Promise<void>((resolve) => {
        const unsub = subscribe(() => {
            const progress = Math.min(1, (Date.now() - origin) / duration);
            try {
                Spicetify.Player.setVolume(startVolume * Math.pow(1 - progress, 1.8));
            } catch {
                /* ignore */
            }
            if (progress >= 1) {
                unsub();
                resolve();
            }
        });
    });

    try {
        Spicetify.Player.pause();
    } catch {
        /* ignore */
    }
    try {
        Spicetify.Player.setVolume(startVolume);
    } catch {
        /* ignore */
    }

    emit("stop", "tape stopped");
    return true;
}

export function isAutoRunning(): boolean {
    return autoUnsub !== null;
}

export function setAuto(enabled: boolean, every = 4): void {
    autoEvery = Math.max(1, Math.min(16, Math.round(every)));
    if (!enabled) {
        stopAuto();
        return;
    }
    startAuto();
}

function startAuto(): void {
    stopAuto();
    autoLastBar = -1;
    autoCounter = 0;
    autoCooldownUntil = 0;

    autoUnsub = subscribe(() => {
        if (busy) return;
        if (!Spicetify.Player.isPlaying()) return;

        const grid = gridFor();
        if (!grid) return;

        const index = barIndexAt(grid, Spicetify.Player.getProgress());
        if (index < 0) return;
        if (index === autoLastBar) return;

        autoLastBar = index;
        if (Date.now() < autoCooldownUntil) return;

        autoCounter += 1;
        if (autoCounter < autoEvery) return;

        autoCounter = 0;
        autoCooldownUntil = Date.now() + 900;
        void chopBars(1).then((did) => {
            if (did) emit("auto", `auto · ${autoEvery} bars`);
        });
    });
}

function stopAuto(): void {
    autoUnsub?.();
    autoUnsub = null;
    autoLastBar = -1;
    autoCounter = 0;
    autoCooldownUntil = 0;
}

export function resetForTrack(): void {
    cancelLoop();
    autoLastBar = -1;
    autoCounter = 0;
    autoCooldownUntil = 0;
}

export function disposeChops(): void {
    stopAuto();
    cancelLoop();
    listener = null;
}
