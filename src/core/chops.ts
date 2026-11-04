/**
 * The performance half of SLAB.
 *
 * A chop is a seek. That sounds cheap until you put it on the grid: jump back
 * exactly a bar, to the same place in it, and the groove carries straight
 * through, the way two copies of a record a bar apart do under a crossfader.
 * Screw did this with two turntables and a pause button.
 */

import { subscribe } from "./clock";
import { barIndexAt, barLengthMs, barStartMs, gridFor, loadGrid } from "./grid";

export type ChopKind = "chop" | "loop" | "stop" | "auto";

export interface ChopEvent {
    kind: ChopKind;
    label: string;
}

type Listener = (event: ChopEvent) => void;

let listener: Listener | null = null;
let busy = false;

/** The furthest jump back any pad makes; a bigger backward move is the user's own seek. */
const MAX_CHOP_BARS = 4;
/** When a pad last jumped the record; its jumps, however many in a row, are never the user's own seek. */
let padJumpAt = 0;
const PAD_JUMP_GRACE_MS = 1500;
/** The bar the last hand-made cut (a pad or a loop jump) left from; auto chop counts it as that line's cut. */
let manualBar = -2;
/** The bar auto chop saw on its last tick, to tell a jump from steady play. */
let autoLastIndex: number | null = null;

let autoUnsub: (() => void) | null = null;
let autoEvery = 4;
/** The furthest bar reached, so replayed bars and backward chops never count. */
let autoMaxBar = -1;
let autoCooldownUntil = 0;

let loopUnsub: (() => void) | null = null;
let loopLeft = 0;

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
 * Jump back exactly `bars` bars, to the same place in the bar, so every beat
 * still lands where it should. Resolves false, and does nothing, when there
 * isn't that much record behind the needle yet.
 */
export async function chopBars(bars: number, auto = false): Promise<boolean> {
    if (busy) return false;
    busy = true;
    try {
        const grid = await ensureGrid();
        if (!grid) return false;

        const now = Spicetify.Player.getProgress();
        const index = barIndexAt(grid, now);
        const span = Math.max(1, Math.round(bars));
        if (index < span) return false;

        const back = index - span;
        const phase = (now - barStartMs(grid, index)) / barLengthMs(grid, index);
        seek(barStartMs(grid, back) + phase * barLengthMs(grid, back));
        if (auto) return true;
        padJumpAt = Date.now();
        manualBar = index;
        emit("chop", `${span} bar${span === 1 ? "" : "s"} back`);
        return true;
    } finally {
        busy = false;
    }
}

export function cancelLoop(): void {
    loopUnsub?.();
    loopUnsub = null;
    loopLeft = 0;
}

/** A loop is running, its last pass included. */
export function isLooping(): boolean {
    return loopUnsub !== null;
}

/** Jumps back still to come in the running loop; 0 during its last pass or with no loop. */
export function loopRemaining(): number {
    return loopUnsub ? loopLeft : 0;
}

/** How early the jump fires, so the seek lands on the bar line rather than after it. */
const LOOP_LEAD_MS = 15;

/**
 * Repeat the current bar `times` more times, then let the record run.
 *
 * The jump is timed in track time, off the bar's own end, so a press late in a
 * bar still cuts on the line instead of running into the next bar first. After
 * each jump the loop waits to see the playhead back inside the bar before it
 * arms again, so a slow seek can't be counted twice. Moving the record anywhere
 * else ends the loop.
 */
export async function loopBars(times = 4): Promise<boolean> {
    const grid = await ensureGrid();
    if (!grid) return false;

    // Before the first downbeat there is no bar to repeat yet.
    const index = barIndexAt(grid, Spicetify.Player.getProgress());
    if (index < 0) return false;
    cancelLoop();

    const start = barStartMs(grid, index);
    const length = barLengthMs(grid, index);
    if (length < 300) return false;

    const end = start + length;
    const total = Math.max(1, Math.round(times));
    let armed = true;
    loopLeft = total;

    loopUnsub = subscribe(() => {
        if (!Spicetify.Player.isPlaying()) {
            cancelLoop();
            return;
        }
        const at = Spicetify.Player.getProgress();
        if (at < start - 250 || at > end + length) {
            cancelLoop();
            return;
        }
        if (!armed) {
            if (at < end - length / 2) armed = true;
            return;
        }
        if (at < end - LOOP_LEAD_MS) return;
        // The last pass has played out to the bar line: the record runs on.
        if (loopLeft <= 0) {
            cancelLoop();
            emit("loop", "Loop done");
            return;
        }

        // A late tick has already run past the line; carry the overshoot so the loop stays in time.
        seek(start + Math.max(0, at - end));
        armed = false;
        loopLeft -= 1;
        manualBar = index;
    });

    emit("loop", `Looping this bar ${total} times`);
    return true;
}

/**
 * Tape stop: pull the fader down and pause, the way a 1200 does when the power
 * cuts. The fade runs on the worker clock so it stays smooth even if Spotify is
 * behind another window, and the fader comes back up at the pause so the next
 * play isn't silent.
 */
let stopping: Promise<boolean> | null = null;

/** A stop is already running; a second press must not start another. */
export function isStopping(): boolean {
    return stopping !== null;
}

export function tapeStop(options: { fade?: boolean; pauseDelayMs?: number } = {}): Promise<boolean> {
    // One stop at a time. A second press during the fade would read the faded
    // volume as its starting point and leave the player turned down for good.
    if (stopping) return stopping;
    stopping = runTapeStop(options).finally(() => {
        stopping = null;
    });
    return stopping;
}

async function runTapeStop(options: { fade?: boolean; pauseDelayMs?: number }): Promise<boolean> {
    if (!Spicetify.Player.isPlaying()) {
        emit("stop", "Already stopped");
        return false;
    }

    // With the DSP helper linked the spin-down is real audio, so fading the
    // player on top of it would hide the effect. In that case hold the volume
    // and just wait for the ramp before pausing.
    const fade = options.fade !== false;
    const startVolume = Spicetify.Player.getVolume();
    const duration = fade ? 420 : Math.max(0, options.pauseDelayMs ?? 0);
    const origin = Date.now();

    await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
            if (done) return;
            done = true;
            unsub();
            resolve();
        };
        const unsub = subscribe(() => {
            const progress = duration === 0 ? 1 : Math.min(1, (Date.now() - origin) / duration);
            if (fade) {
                try {
                    Spicetify.Player.setVolume(startVolume * Math.pow(1 - progress, 1.8));
                } catch {
                    /* ignore */
                }
            }
            if (progress >= 1) finish();
        });
        // The record stops even if the clock never ticks.
        window.setTimeout(finish, duration + 250);
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

    emit("stop", "Tape stopped");
    return true;
}



/** Changing N keeps the clock running; only the switch starts and stops it. */
export function setAuto(enabled: boolean, every = 4): void {
    autoEvery = Math.max(1, Math.min(16, Math.round(every)));
    if (!enabled) {
        stopAuto();
        return;
    }
    if (!autoUnsub) startAuto();
}

/** The first bar seen after starting (or after a track change) is a baseline, not a bar played. */
let autoBaseline = true;

/**
 * Cuts on the phrase lines the music is built on: with N = 4, the top of bar 5,
 * 9, 13, each time replaying the bar that ended the phrase. Only bars reached for
 * the first time count, so the replayed bar, the user's own chops and a running
 * loop can never set it off again. A loop or a tape stop has the deck to itself.
 */
function startAuto(): void {
    autoBaseline = true;
    autoCooldownUntil = 0;

    autoUnsub = subscribe(() => {
        if (busy || loopUnsub || stopping) return;
        if (!Spicetify.Player.isPlaying()) return;

        const grid = gridFor();
        if (!grid) return;

        const index = barIndexAt(grid, Spicetify.Player.getProgress());
        if (index < 0) return;
        const last = autoLastIndex;
        autoLastIndex = index;
        if (autoBaseline || last === null) {
            autoBaseline = false;
            autoMaxBar = index;
            return;
        }
        // Judged at the moment of the jump, not afterwards: pads jump back as far as they
        // like, stacked or not, and the replayed bars still never count; only the user
        // dragging the record back past any pad's reach starts the count again from there.
        if (index < last) {
            const padJumped = Date.now() - padJumpAt < PAD_JUMP_GRACE_MS;
            if (!padJumped && index < autoMaxBar - MAX_CHOP_BARS) autoMaxBar = index;
            return;
        }
        // Dragged forward more than a bar: count from there, never cut mid-bar on arrival.
        if (index > last + 1) {
            autoMaxBar = Math.max(autoMaxBar, index);
            return;
        }
        if (index <= autoMaxBar) return;
        autoMaxBar = index;

        if (Date.now() < autoCooldownUntil) return;
        if (index % autoEvery !== 0) return;
        // A chop or a loop just played over this phrase line already; one cut per line.
        if (manualBar >= index - 1) return;

        autoCooldownUntil = Date.now() + 900;
        void chopBars(1, true).then((did) => {
            if (did) emit("auto", `Auto chop, every ${autoEvery} bar${autoEvery === 1 ? "" : "s"}`);
        });
    });
}

/**
 * Bars from `index` until auto chop cuts next: the first phrase line past the
 * furthest bar reached. Null while it isn't counting.
 */
export function autoBarsAhead(index: number): number | null {
    if (!autoUnsub || autoBaseline || index < 0) return null;
    const from = Math.max(autoMaxBar, index);
    return (Math.floor(from / autoEvery) + 1) * autoEvery - index;
}

function stopAuto(): void {
    autoUnsub?.();
    autoUnsub = null;
    autoLastIndex = null;
    autoMaxBar = -1;
    autoCooldownUntil = 0;
}

export function resetForTrack(): void {
    cancelLoop();
    autoBaseline = true;
    autoLastIndex = null;
    autoMaxBar = -1;
    autoCooldownUntil = 0;
}

export function disposeChops(): void {
    stopAuto();
    cancelLoop();
    listener = null;
}
