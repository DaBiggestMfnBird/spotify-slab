/**
 * The performance half of SLAB.
 *
 * A chop is a seek. That sounds cheap until you put it on the grid: jump back
 * exactly a bar, to the same place in it, and the groove carries straight
 * through, the way two copies of a record a bar apart do under a crossfader.
 * Screw did this with two turntables and a pause button.
 */

import type { Grid } from "../types";
import { subscribe } from "./clock";
import { canJump, canSpin, dspCancelJump, dspJump, dspSpin, dspStatus, seekAheadMs } from "./dsp";
import {
    barIndexAt,
    barLengthMs,
    barStartMs,
    beatIndexAt,
    beatLengthMs,
    beatStartMs,
    gridFor,
    loadGrid,
} from "./grid";
import { lineJustHeard, loadLines } from "./lyrics";

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
/** A loop on the last bar jumps back this long before the track ends, so the player doesn't advance first. */
const TRACK_END_MARGIN_MS = 150;
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

/*
 * The needle: what is heard, and how much song has played unbroken behind it.
 *
 * With the helper, a chop jumps inside the helper's memory of what Spotify played, so
 * SLAB tells it how far back that memory runs straight through the song: never across a
 * new track, a pause (the tap may have caught silence) or the user dragging the record.
 * And right after such a jump Spotify itself was sent a little past the target, so for a
 * while its position runs ahead of what is heard; the needle is reckoned from the jump.
 */

/** A position jump bigger than this, not of SLAB's making, is the user moving the record. */
const MOVED_MS = 600;
/** What the helper hears trails Spotify's position by up to about this. */
const HEARD_MARGIN_MS = 350;
/** How long a jump's own reckoning of the needle is trusted. */
const RECKON_MS = 8_000;

/** Song position the unbroken run began at; null until SLAB has seen it play. */
let runFrom: number | null = null;
let lastAt = 0;
let lastTime = 0;
let lastPlaying = false;
let lastUri: string | null = null;
/** The last seek SLAB sent Spotify: where, when, and whether the run carries on through it. */
let sentTo = 0;
let sentAt = 0;
let sentKeepsRun = false;
/** What was heard at a moment, once a helper jump has put it there; the next one waits its turn. */
let reckon: { at: number; time: number } | null = null;
let nextReckon: { at: number; time: number } | null = null;
/** The helper's give-up count when the reckoning was set: one since means the sound went live. */
let reckonWentLive = 0;
/** The Spotify seek that follows a helper jump still to fire, so a newer cut can call it off. */
let pendingSend: number | null = null;
/** Until when a helper jump may still be playing from memory, waiting on Spotify. */
let helperCutUntil = 0;

function forgetReckoning(): void {
    reckon = null;
    nextReckon = null;
}

/** A new track or a pause: whatever the helper is doing with an earlier cut no longer fits. */
function dropHelperCut(): void {
    if (pendingSend !== null) window.clearTimeout(pendingSend);
    pendingSend = null;
    if (Date.now() < helperCutUntil) void dspCancelJump();
    helperCutUntil = 0;
}

/**
 * Looks at the player: a new track, a resume or the user moving the record starts the run
 * again from there. Called on every panel tick, open or not.
 */
export function watchNeedle(): void {
    let playing = false;
    let at = 0;
    let uri: string | null = null;
    try {
        playing = Spicetify.Player.isPlaying();
        at = Spicetify.Player.getProgress();
        uri = Spicetify.Player.data?.item?.uri ?? null;
    } catch {
        return;
    }
    const now = Date.now();
    if (uri !== lastUri) {
        runFrom = playing ? at : null;
        forgetReckoning();
        if (lastUri !== null) dropHelperCut();
    } else if (!playing) {
        forgetReckoning();
        // Paused while the helper plays a chop from memory: stop now, not when it tires of waiting.
        if (lastPlaying) dropHelperCut();
    } else if (!lastPlaying) {
        runFrom = at;
        forgetReckoning();
    } else if (Math.abs(at - (lastAt + (now - lastTime))) > MOVED_MS) {
        const ours = now - sentAt < 2_000 && Math.abs(at - (sentTo + (now - sentAt))) < MOVED_MS;
        if (!ours) {
            runFrom = at;
            forgetReckoning();
        } else if (!sentKeepsRun) {
            runFrom = sentTo;
        }
    }
    if (runFrom === null && playing) runFrom = at;
    lastAt = at;
    lastTime = now;
    lastPlaying = playing;
    lastUri = uri;
}

/**
 * What is heard now, as a song position. Reckoned from the last helper jump while that holds,
 * otherwise Spotify's position less what the helper's buffer holds back.
 */
export function needlePosition(): number {
    const now = Date.now();
    if (nextReckon && now >= nextReckon.time) {
        reckon = nextReckon;
        nextReckon = null;
    }
    // The helper gave up on Spotify and went live: the sound is where Spotify is, not where the jump put it.
    if ((dspStatus().wentLive ?? 0) > reckonWentLive) forgetReckoning();
    if (reckon && now - reckon.time < RECKON_MS) return reckon.at + (now - reckon.time);
    const at = Spicetify.Player.getProgress();
    return canJump() ? at - (dspStatus().latencyMs ?? 0) : at;
}

/** How much song has played unbroken behind what is heard: as far back as the helper may jump. */
function unbrokenMs(heard: number): number {
    if (runFrom === null) return 0;
    return Math.max(0, heard - runFrom - HEARD_MARGIN_MS);
}

function sent(to: number, keepsRun: boolean): void {
    sentTo = to;
    sentAt = Date.now();
    sentKeepsRun = keepsRun;
    if (!keepsRun) {
        runFrom = to;
        forgetReckoning();
    }
}

/**
 * Puts the needle on `target`, a song position, from `from`, what is heard when it fires
 * `inMs` from now. With the helper the sound jumps inside it there and then, and Spotify is
 * sent a little past the target to catch up out of earshot. Without it, Spotify is seeked.
 * True when the helper took it.
 */
async function cut(target: number, from: number, inMs = 0, spin = false): Promise<boolean> {
    if (spin ? canSpin() : canJump()) {
        const ahead = seekAheadMs();
        const asked = Date.now();
        const order = {
            backMs: Math.round(from - target),
            seekAheadMs: ahead,
            availableMs: Math.round(unbrokenMs(from)),
        };
        // A spin turns from now and lands `inMs` from now; a jump waits `inMs`, then lands.
        const jumped = spin
            ? await dspSpin({ ...order, spinMs: Math.round(inMs) })
            : await dspJump({ ...order, inMs: Math.round(inMs) });
        if (jumped) {
            // The helper counted `inMs` from when the order reached it, about halfway through the
            // round trip; reckoning from the answer would make every loop pass that much long.
            const fires = asked + (Date.now() - asked) / 2 + inMs;
            const send = (): void => {
                pendingSend = null;
                // A timer that fired late sends Spotify on by as much, so it still comes back just ahead.
                const to = target + ahead + Math.max(0, Date.now() - fires);
                sent(to, true);
                seek(to);
            };
            // This jump replaced any the helper was still holding: so does its seek.
            if (pendingSend !== null) window.clearTimeout(pendingSend);
            pendingSend = null;
            helperCutUntil = fires + 3_000;
            reckonWentLive = dspStatus().wentLive ?? 0;
            nextReckon = { at: target, time: fires };
            if (inMs > 0) pendingSend = window.setTimeout(send, inMs);
            else send();
            return true;
        }
    }
    // A helper jump still to fire would land under this seek: call it off with its own.
    if (pendingSend !== null) dropHelperCut();
    const plain = (): void => {
        sent(target, false);
        seek(target);
    };
    if (inMs > 0) window.setTimeout(plain, inMs);
    else plain();
    return false;
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

        const now = needlePosition();
        const index = barIndexAt(grid, now);
        const span = Math.max(1, Math.round(bars));
        if (index < span) return false;

        const back = index - span;
        const phase = (now - barStartMs(grid, index)) / barLengthMs(grid, index);
        await cut(barStartMs(grid, back) + phase * barLengthMs(grid, back), now);
        if (auto) return true;
        padJumpAt = Date.now();
        manualBar = index;
        emit("chop", `${span} bar${span === 1 ? "" : "s"} back`);
        return true;
    } finally {
        busy = false;
    }
}

/** A line that started longer ago than this is behind an instrumental stretch: nothing to run back. */
const LINE_REACH_MS = 15_000;

/**
 * Where the beat grid puts `at`'s place in its beat, in the beat at or before `start`: the same
 * place in the beat, so the groove carries through, and never past the line's first word.
 */
function onTheBeat(grid: Grid, at: number, start: number): number {
    const here = beatIndexAt(grid, at);
    let there = beatIndexAt(grid, start);
    if (here < 0 || there < 0) return start;
    const phase = (at - beatStartMs(grid, here)) / beatLengthMs(grid, here);
    let target = beatStartMs(grid, there) + phase * beatLengthMs(grid, there);
    if (target > start + 25 && there > 0) {
        there -= 1;
        target = beatStartMs(grid, there) + phase * beatLengthMs(grid, there);
    }
    return target;
}

function quote(words: string): string {
    return words.length > 34 ? `${words.slice(0, 33).trimEnd()}…` : words;
}

/**
 * Run the line back: back to the start of the lyric line just heard, at the same place in the
 * beat, the way Screw ran a vocal back. Synced lyrics come from Spotify; a track without them,
 * or a stretch with no singing, gets a bar chop instead.
 */
export async function runLineBack(): Promise<boolean> {
    if (busy) return false;
    const grid = await ensureGrid();
    if (!grid) return false;
    const lines = await loadLines();
    const heard = needlePosition();
    const line = lines ? lineJustHeard(lines, heard) : null;
    if (!line || heard - line.startMs > LINE_REACH_MS) {
        const did = await chopBars(1, true);
        if (did) {
            padJumpAt = Date.now();
            manualBar = barIndexAt(grid, heard);
            emit("chop", lines ? "No line here, so a bar back" : "No synced lyrics, so a bar back");
        }
        return did;
    }
    busy = true;
    try {
        const target = onTheBeat(grid, heard, line.startMs);
        // Barely into it: nothing worth running back yet.
        if (heard - target < 250) return false;
        await cut(target, heard);
        padJumpAt = Date.now();
        manualBar = barIndexAt(grid, heard);
        emit("chop", `Back to “${quote(line.words)}”`);
        return true;
    } finally {
        busy = false;
    }
}

/** A backspin turns for a beat, inside these bounds: shorter is a scratch, longer drags. */
const SPIN_MIN_MS = 350;
const SPIN_MAX_MS = 650;

/**
 * Backspin into a chop: the helper spins the record back for about a beat, then it lands a bar
 * back from where it would have been, on the beat. Without a helper that can, a bar chop.
 */
export async function spinBack(): Promise<boolean> {
    if (!canSpin()) {
        const did = await chopBars(1, true);
        if (did) {
            padJumpAt = Date.now();
            emit("chop", dspStatus().linked ? "1 bar back. Spinning needs a newer SLAB DSP." : "1 bar back. Spinning needs SLAB DSP.");
        }
        return did;
    }
    if (busy) return false;
    busy = true;
    try {
        const grid = await ensureGrid();
        if (!grid) return false;
        const heard = needlePosition();
        const beat = beatLengthMs(grid, Math.max(0, beatIndexAt(grid, heard)));
        const turn = Math.max(SPIN_MIN_MS, Math.min(SPIN_MAX_MS, beat));
        // Where the record will be when the spin ends, and a bar back from there, same place in the bar.
        const end = heard + turn;
        const index = barIndexAt(grid, end);
        if (index < 1) return false;
        const phase = (end - barStartMs(grid, index)) / barLengthMs(grid, index);
        const target = barStartMs(grid, index - 1) + phase * barLengthMs(grid, index - 1);
        await cut(target, heard, turn, true);
        padJumpAt = Date.now();
        manualBar = index;
        emit("chop", "Spun back a bar");
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
/** With the helper, how early the jump is sent: it waits there and lands on the line to the sample. */
const LOOP_SEND_MS = 200;

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
    const index = barIndexAt(grid, needlePosition());
    if (index < 0) return false;
    cancelLoop();

    const start = barStartMs(grid, index);
    // The last bar can run past the end of the track; a loop there repeats what's left of it,
    // so the jump comes before Spotify moves on to the next track.
    const trackLeft = (grid.durationMs || Number.POSITIVE_INFINITY) - TRACK_END_MARGIN_MS - start;
    const length = Math.min(barLengthMs(grid, index), trackLeft);
    if (length < 300) return false;

    const end = start + length;
    const total = Math.max(1, Math.round(times));
    let armed = true;
    loopLeft = total;

    const tick = (): void => {
        if (!Spicetify.Player.isPlaying()) {
            cancelLoop();
            return;
        }
        const at = needlePosition();
        if (at < start - 250 || at > end + length) {
            cancelLoop();
            return;
        }
        if (!armed) {
            if (at < end - length / 2) armed = true;
            return;
        }
        const helper = canJump();
        if (at < end - (helper ? LOOP_SEND_MS : LOOP_LEAD_MS)) return;
        // The last pass has played out to the bar line: the record runs on.
        if (loopLeft <= 0) {
            cancelLoop();
            emit("loop", "Loop done");
            return;
        }
        armed = false;
        loopLeft -= 1;
        manualBar = index;

        // A late tick has already run past the line; carry the overshoot so the loop stays in time.
        // A stalled clock can be late by most of a bar: carry at most a beat's worth, so the jump
        // lands early enough in the bar for the loop to arm again rather than quietly die.
        const late = Math.max(0, at - end);
        const to = start + Math.min(late, length / 4);
        if (helper) {
            // Ahead of the line, the helper is told when: the jump lands on it to the sample.
            void cut(to, late > 0 ? at : end, late > 0 ? 0 : end - at);
            return;
        }
        sent(to, false);
        seek(to);
    };
    loopUnsub = subscribe(tick);
    // Pressed just before the line: the clock's first tick can take a moment to come (the
    // first time, its thread has to start), so the line is looked at right away too.
    tick();

    emit("loop", total === 1 ? "Looping this bar once more" : `Looping this bar ${total} times`);
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

export interface TapeStopOptions {
    /** Asks the helper to ramp the audio itself; resolves true only if it did. */
    spinDown?: () => Promise<boolean>;
    /** How long the helper's ramp takes to bottom out, so the pause doesn't clip it. */
    spinDownMs?: number;
}

export function tapeStop(options: TapeStopOptions = {}): Promise<boolean> {
    // One stop at a time. A second press during the fade would read the faded
    // volume as its starting point and leave the player turned down for good.
    if (stopping) return stopping;
    stopping = runTapeStop(options).finally(() => {
        stopping = null;
    });
    return stopping;
}

async function runTapeStop(options: TapeStopOptions): Promise<boolean> {
    if (!Spicetify.Player.isPlaying()) {
        emit("stop", "Already stopped");
        return false;
    }

    // When the helper ramps the audio, the spin-down is real, and fading the
    // player on top of it would hide the effect: hold the volume and pause when
    // the ramp bottoms out. When it can't (nothing tapped, or no answer), the
    // fader does the stop, so a stop is never a hard cut.
    const spun = options.spinDown ? await options.spinDown() : false;
    const fade = !spun;
    const startVolume = Spicetify.Player.getVolume();
    const duration = fade ? 420 : Math.max(0, options.spinDownMs ?? 0);
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

        const index = barIndexAt(grid, needlePosition());
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
    // A cut on the last track says nothing about this one's bars, and none of the last
    // track is behind this one's needle.
    manualBar = -2;
    padJumpAt = 0;
    forgetReckoning();
    dropHelperCut();
    lastUri = null;
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
