/**
 * DJ mode: SLAB works the record the way a screw DJ works a tape, on its own.
 *
 * It reads the bars, the song's sections and its lyric lines, and plays the moves the
 * pads have: a chop on the phrase line, the vocal run back at the end of a line, a
 * section's last bar looped, an echo thrown into the next section, a spin back, Screw
 * held over the hook, the trunk shut on a breakdown. How much of each depends on what
 * kind of record it is (see genre.ts), and leans toward the moves you make yourself
 * (style.ts). Any pad of yours from the Chop or Screw bank takes the record back for eight bars.
 *
 * It decides bar by bar, as each new bar is reached for the first time, so a bar it
 * replayed never sets it off again, and its dice are seeded by the track: the same
 * record gets the same mix.
 */

import type { Grid, Section } from "../types";
import { chopBars, isLooping, loopBars, needlePosition, runLineBack, spinBack } from "./chops";
import { subscribe } from "./clock";
import { canHold } from "./dsp";
import { STYLES, STYLE_NAMES, type StyleId, type StyleReading, artistGenres, pickStyle, pickedStyle, styleFor, trackSound } from "./genre";
import { barIndexAt, barLengthMs, barStartMs, beatIndexAt, beatLengthMs, gridFor, loadGrid } from "./grid";
import { type HoldName, isHeld, press as pressHold, release as releaseHold } from "./holds";
import { currentArtist } from "./keep";
import { type LyricLine, loadLines } from "./lyrics";
import { type Move, PHRASE, lean, noteMove } from "./style";

interface Plan {
    /** Bars to a phrase: where the cuts land. */
    phrase: number;
    /** At a phrase line, how often it chops, and how far back. */
    chop: number;
    chopBars: [bars: 1 | 2 | 4, weight: number][];
    /** At the end of a vocal line, how often it runs the line back. */
    line: number;
    /** On a section's last bar: the bar looped, a spin back, an echo thrown into what's next. */
    loop: number;
    spin: number;
    echo: number;
    /** On the hook, how often Screw rides a bar down; on a breakdown, the trunk shut. */
    screw: number;
    trunk: number;
}

/** Full screw, by kind of record. */
const PLANS: Record<StyleId, Plan> = {
    houston: { phrase: 4, chop: 0.75, chopBars: [[1, 0.55], [2, 0.35], [4, 0.1]], line: 0.7, loop: 0.3, spin: 0.15, echo: 0.3, screw: 0.55, trunk: 0.35 },
    trap: { phrase: 4, chop: 0.6, chopBars: [[1, 0.5], [2, 0.4], [4, 0.1]], line: 0.4, loop: 0.4, spin: 0.35, echo: 0.4, screw: 0.4, trunk: 0.4 },
    rap: { phrase: 4, chop: 0.65, chopBars: [[1, 0.5], [2, 0.4], [4, 0.1]], line: 0.55, loop: 0.3, spin: 0.2, echo: 0.3, screw: 0.45, trunk: 0.3 },
    slowjam: { phrase: 8, chop: 0.45, chopBars: [[1, 0.4], [2, 0.5], [4, 0.1]], line: 0.8, loop: 0.25, spin: 0.1, echo: 0.5, screw: 0.65, trunk: 0.25 },
    band: { phrase: 8, chop: 0.45, chopBars: [[1, 0.3], [2, 0.5], [4, 0.2]], line: 0.35, loop: 0.3, spin: 0.25, echo: 0.45, screw: 0.35, trunk: 0.3 },
    dance: { phrase: 8, chop: 0.4, chopBars: [[1, 0.3], [2, 0.4], [4, 0.3]], line: 0.25, loop: 0.5, spin: 0.4, echo: 0.4, screw: 0.3, trunk: 0.5 },
    pop: { phrase: 8, chop: 0.5, chopBars: [[1, 0.45], [2, 0.45], [4, 0.1]], line: 0.5, loop: 0.3, spin: 0.2, echo: 0.4, screw: 0.4, trunk: 0.3 },
};

/** After a jump the record runs at least this many bars before the next one. */
const REST_BARS = 2;
/** A pad of your own hands the record back to you for this many bars. */
const YIELD_BARS = 8;
/** A jump back further than any move makes is a hand on the record: start counting from there. */
const MOVED_BARS = 5;
/** How long a jump of the DJ's own takes to show in the bar count. */
const OWN_JUMP_MS = 1_500;
/** How hard it plays: every chance it takes, light to hard. */
export const HANDS = ["light", "steady", "heavy", "hard"] as const;
const HAND_WEIGHT = [0.55, 1, 1.45, 1.9];

let running = false;
let unsub: (() => void) | null = null;
let listener: ((label: string) => void) | null = null;
let uri: string | null = null;
let style: StyleId = "rap";
/** What it reads the record as, before any pick of yours. */
let detected: StyleId = "rap";
let styleReady = false;
let hand = 1;
let lines: LyricLine[] | null = null;
let seed = 1;
let lastBar: number | null = null;
let maxBar = -1;
let restUntil = -1;
let lastJumpBar = -10;
let yieldUntil = -1;
let jumpedAt = 0;
let timers: number[] = [];
/** Holds the DJ put down itself, so it only ever lets up its own. */
const mine = new Set<HoldName>();

/** Told what the DJ just did, in a few words, for the readout. */
export function onDj(fn: ((label: string) => void) | null): void {
    listener = fn;
}

export function djRunning(): boolean {
    return running;
}

/** What kind of record the DJ reckons this is, for the panel. */
export function djStyleName(): string | null {
    return running && styleReady ? STYLE_NAMES[style] : null;
}

/** How hard it plays, 1 to 4. */
export function setDjHand(level: number): void {
    hand = Math.max(0, Math.min(HANDS.length - 1, Math.round(level) - 1));
}

/**
 * Plays this record as the next kind, in turn, and the artist's records as that from now on. Back
 * round to what it read the record as, the pick is forgotten. Null while there's nothing to play.
 */
export function nextDjStyle(): StyleId | null {
    if (!running || !styleReady) return null;
    const next = STYLES[(STYLES.indexOf(style) + 1) % STYLES.length];
    const artist = currentArtist();
    if (artist) pickStyle(artist.uri, next === detected ? null : next);
    style = next;
    return next;
}

function say(label: string): void {
    listener?.(label);
}

function clearTimers(): void {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
}

function letUpMine(): void {
    for (const name of mine) releaseHold(name);
    mine.clear();
}

function playing(): boolean {
    try {
        return Spicetify.Player.isPlaying();
    } catch {
        return false;
    }
}

/** Does `fn` when the needle reaches `at` (a song position), if the DJ is still on and the record still playing. */
function at(when: number, fn: () => void): void {
    const wait = Math.max(0, when - needlePosition());
    timers.push(window.setTimeout(() => {
        if (running && playing()) fn();
    }, wait));
}

/** A small seeded generator: the same track and bar roll the same dice. */
function dice(bar: number): () => number {
    let a = (seed ^ Math.imul(bar + 1, 0x9e3779b1)) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

function hash(text: string): number {
    let h = 2_166_136_261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16_777_619);
    return h >>> 0;
}

/** What the record reads as, without your pick: its artist's genres, how it sounds, or its tempo. */
async function readTrack(track: string | null): Promise<StyleReading> {
    const artist = currentArtist();
    const [grid, genres, sound] = await Promise.all([
        gridFor() ?? loadGrid(),
        artist ? artistGenres(artist.uri) : Promise.resolve([]),
        track ? trackSound(track) : Promise.resolve(null),
    ]);
    return styleFor(genres, grid?.tempo ?? 0, sound);
}

/** The kind of record playing now: yours for the artist if you picked one, or what it reads as. */
export async function trackStyle(): Promise<StyleId> {
    const artist = currentArtist();
    const picked = artist ? pickedStyle(artist.uri) : null;
    if (picked) return picked;
    let track: string | null = null;
    try {
        track = Spicetify.Player.data?.item?.uri ?? null;
    } catch {
        /* nothing playing */
    }
    return (await readTrack(track)).style;
}

async function prepare(track: string | null): Promise<void> {
    uri = track;
    lastBar = null;
    maxBar = -1;
    restUntil = -1;
    lastJumpBar = -10;
    yieldUntil = -1;
    clearTimers();
    letUpMine();
    styleReady = false;
    lines = null;
    seed = hash(track ?? "");
    if (!track) return;
    const [reading, words] = await Promise.all([readTrack(track), loadLines(track)]);
    if (uri !== track) return;
    detected = reading.style;
    const artist = currentArtist();
    style = (artist ? pickedStyle(artist.uri) : null) ?? reading.style;
    styleReady = true;
    lines = words;
}

export function startDj(): void {
    if (running) return;
    running = true;
    let track: string | null = null;
    try {
        track = Spicetify.Player.data?.item?.uri ?? null;
    } catch {
        /* player not ready: the first tick picks it up */
    }
    void prepare(track);
    unsub = subscribe(tick);
}

export function stopDj(): void {
    running = false;
    unsub?.();
    unsub = null;
    clearTimers();
    letUpMine();
}

/**
 * A pad of your own: the record is yours for the next eight bars, and whatever the DJ had
 * planned or was holding is called off. A move is counted, so the DJ learns where you play.
 */
export function djYield(move?: Move): void {
    const grid = gridFor();
    const bar = grid ? barIndexAt(grid, needlePosition()) : -1;
    if (move && bar >= 0) {
        void trackStyle().then((kind) => noteMove(kind, move, bar % PHRASE));
    }
    if (!running) return;
    clearTimers();
    letUpMine();
    if (bar >= 0) yieldUntil = bar + YIELD_BARS;
}

function tick(): void {
    if (!running) return;
    let track: string | null = null;
    try {
        track = Spicetify.Player.data?.item?.uri ?? null;
    } catch {
        return;
    }
    if (track !== uri) {
        void prepare(track);
        return;
    }
    if (!playing()) {
        // Stopped: nothing planned plays into the silence, and nothing the DJ holds stays down.
        clearTimers();
        letUpMine();
        return;
    }
    if (!styleReady) return;
    const grid = gridFor();
    if (!grid) return;
    const heard = needlePosition();
    const bar = barIndexAt(grid, heard);
    if (bar < 0) return;
    const last = lastBar;
    lastBar = bar;
    if (last === null || bar === last) return;
    if (bar !== last + 1) {
        // Moved: the DJ's own jump, a loop, or a hand on the record. Dragged back further than any
        // move goes, it counts again from there; forward, from where it landed.
        const own = Date.now() - jumpedAt < OWN_JUMP_MS;
        if (bar > maxBar) maxBar = bar;
        else if (!own && bar < maxBar - MOVED_BARS) maxBar = bar;
        return;
    }
    // Only bars reached for the first time: never a bar it, or you, just played again.
    if (bar <= maxBar) return;
    maxBar = bar;
    if (bar < yieldUntil || isLooping()) return;
    play(grid, bar, heard);
}

/** The section a moment falls in, by index, or -1. */
function sectionIndex(sections: Section[], ms: number): number {
    let found = -1;
    for (let i = 0; i < sections.length; i++) {
        if (sections[i].start > ms) break;
        found = i;
    }
    return found;
}

function pick(weights: [1 | 2 | 4, number][], roll: number): 1 | 2 | 4 {
    const total = weights.reduce((sum, [, w]) => sum + w, 0);
    let at = roll * total;
    for (const [bars, w] of weights) {
        at -= w;
        if (at <= 0) return bars;
    }
    return weights[0][0];
}

function hold(name: HoldName, from: number, to: number, label: string, beatMs: number): void {
    if (!canHold() || isHeld(name)) return;
    at(from, () => {
        if (isHeld(name)) return;
        if (!pressHold(name, name === "screw" ? { cents: -500 } : { beatMs })) return;
        mine.add(name);
        say(label);
        at(to, () => {
            if (!mine.delete(name)) return;
            releaseHold(name);
        });
    });
}

function play(grid: Grid, bar: number, heard: number): void {
    const plan = PLANS[style];
    const roll = dice(bar);
    const start = barStartMs(grid, bar);
    const length = barLengthMs(grid, bar);
    const end = start + length;
    const beat = beatLengthMs(grid, Math.max(0, beatIndexAt(grid, heard)));
    const learnt = bar % PHRASE;
    const weigh = (move: Move, chance: number) => Math.min(0.95, chance * HAND_WEIGHT[hand] * lean(style, move, learnt));

    const sections = grid.sections;
    const here = sectionIndex(sections, start + length / 2);
    const next = here + 1 < sections.length ? sections[here + 1] : null;
    // A section's last bar: the next one starts within half a bar of this one's end.
    const lastOfSection = next !== null && Math.abs(next.start - end) < length / 2;
    const firstOfSection = here >= 0 && Math.abs(sections[here].start - start) < length / 2;
    const loudest = sections.reduce((max, s) => Math.max(max, s.loudness), -Infinity);
    const sorted = sections.map((s) => s.loudness).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : -60;
    const hook = here >= 0 && sections.length >= 3 && sections[here].loudness >= loudest - 1.5;
    const breakdown = here >= 0 && sections.length >= 3 && sections[here].loudness <= median - 4;

    let jumped = false;
    const resting = bar < restUntil;

    // The phrase line first: the classic cut, back to the bar that ended the phrase, or further.
    // It's the backbone of the mix, so only the bar straight after another jump holds it off.
    if (bar - lastJumpBar >= 2 && bar >= plan.phrase && bar % plan.phrase === 0) {
        const bars = pick(plan.chopBars, roll());
        const move: Move = bars === 1 ? "chop1" : bars === 2 ? "chop2" : "chop4";
        if (roll() < weigh(move, plan.chop) && bar >= bars) {
            jumped = true;
            jumpedAt = Date.now();
            void chopBars(bars, true).then((did) => {
                if (did) say(`DJ: ${bars === 1 ? "a bar" : `${bars} bars`} back`);
            });
        }
    }

    // A section's last bar: loop it, or spin back out of it.
    if (!jumped && !resting && lastOfSection) {
        const r = roll();
        const loop = weigh("loop", plan.loop);
        if (r < loop) {
            jumped = true;
            jumpedAt = Date.now();
            void loopBars(1).then((did) => {
                if (did) say("DJ: looped the bar");
            });
        } else if (r < loop + weigh("spin", plan.spin)) {
            jumped = true;
            const turn = Math.max(350, Math.min(650, beat));
            at(end - turn - 30, () => {
                jumpedAt = Date.now();
                void spinBack();
            });
        }
    }

    // Between the cuts, a vocal line that ended: a new one starts in this bar, so the one before
    // it was just heard. Run it back.
    if (!jumped && !resting && lines) {
        const fresh = lines.find((line) => line.startMs >= start && line.startMs < end);
        if (fresh && roll() < weigh("line", plan.line)) {
            jumped = true;
            at(fresh.startMs + 150, () => {
                jumpedAt = Date.now();
                void runLineBack();
            });
        }
    }

    // Thrown into what's next: an echo on the last beat of the section.
    if (lastOfSection && roll() < weigh("echo", plan.echo)) hold("echo", end - beat, end, "DJ: echo thrown", beat);

    // Screw on the hook, a bar at a time; with no sections to say where the hook is, now and then on a phrase.
    const screwChance = hook ? plan.screw : sections.length < 3 && bar % plan.phrase === 1 ? plan.screw * 0.4 : 0;
    if (screwChance > 0 && roll() < weigh("screw", screwChance)) hold("screw", start, end - beat / 4, "DJ: Screw on the hook", beat);

    // The trunk shut on a breakdown's first two bars.
    if (firstOfSection && breakdown && roll() < weigh("trunk", plan.trunk)) {
        hold("trunk", start, start + length * 2 - beat / 4, "DJ: trunk shut", beat);
    }

    if (jumped) {
        restUntil = bar + REST_BARS + 1;
        lastJumpBar = bar;
    }
}
