/**
 * Pads held on top of the mood: Screw rides the pitch down like a hand on the
 * pitch fader, Trunk shuts the lid on the sound, Echo throws it back on the beat.
 * Let go and the mood is back. The helper does the ramps; SLAB says what is down.
 */

import { canHold, dspHold, dspStatus, type HoldOverlay } from "./dsp";

export type HoldName = "screw" | "trunk" | "echo";

/** How long each takes to come in and to go, ms: the ride is slow, the lid pops, the echo rings off. */
const RAMP: Record<HoldName, { on: number; off: number }> = {
    screw: { on: 650, off: 220 },
    trunk: { on: 90, off: 45 },
    echo: { on: 40, off: 900 },
};
/** The trunk lid: what gets through it, and a little make-up for what it keeps in. */
const TRUNK_HZ = 420;
const TRUNK_LIFT_DB = 3;
const ECHO_MIX = 38;
const ECHO_FEEDBACK = 48;
/** The helper lets go of a hold it hasn't heard about in 10 s; it hears again well inside that. */
const REFRESH_MS = 4_000;

const down = new Set<HoldName>();
let screwCents = -500;
let echoSeconds = 0.4;
let refresh: number | null = null;
let listener: ((held: ReadonlySet<HoldName>) => void) | null = null;

/** Told whenever what is held changes, so the pads can stay lit while they're down. */
export function onHoldChange(fn: ((held: ReadonlySet<HoldName>) => void) | null): void {
    listener = fn;
}

function overlay(): HoldOverlay {
    const o: HoldOverlay = {};
    if (down.has("screw")) o.pitchOffset = screwCents;
    if (down.has("trunk")) {
        o.lowpassCap = TRUNK_HZ;
        o.gainBoost = TRUNK_LIFT_DB;
    }
    if (down.has("echo")) {
        o.echoMix = ECHO_MIX;
        o.echoFeedback = ECHO_FEEDBACK;
        o.echoTime = echoSeconds;
    }
    return o;
}

function keepAlive(): void {
    if (down.size && refresh === null) {
        refresh = window.setInterval(() => void dspHold(overlay(), 0), REFRESH_MS);
    } else if (!down.size && refresh !== null) {
        window.clearInterval(refresh);
        refresh = null;
    }
    listener?.(down);
}

export interface PressOptions {
    /** Screw: how far down it rides, in cents (negative). */
    cents?: number;
    /** Echo: one beat of the song, in ms. */
    beatMs?: number;
}

/** Puts a hold down. False when there's no helper to do it. */
export function press(name: HoldName, options: PressOptions = {}): boolean {
    if (!canHold()) return false;
    if (down.has(name)) return true;
    if (name === "screw" && typeof options.cents === "number") screwCents = Math.min(-100, options.cents);
    if (name === "echo" && typeof options.beatMs === "number" && options.beatMs > 0) {
        // On the beat, or on the half beat when a slow song's beat is too long to hear as an echo.
        const beat = options.beatMs / 1000;
        echoSeconds = beat > 0.75 ? beat / 2 : beat;
    }
    down.add(name);
    void dspHold(overlay(), RAMP[name].on);
    keepAlive();
    return true;
}

/** A helper whose echo is a send throws it: the send is cut at once and the tail rings out on its own. */
const THROW_MS = 60;

export function release(name: HoldName): void {
    if (!down.delete(name)) return;
    void dspHold(overlay(), name === "echo" && dspStatus().throw ? THROW_MS : RAMP[name].off);
    keepAlive();
}

/** Everything up at once: the window lost the keys, or the panel went away. */
export function releaseAll(): void {
    if (!down.size) return;
    down.clear();
    void dspHold({}, 150);
    keepAlive();
}

export function isHeld(name: HoldName): boolean {
    return down.has(name);
}
