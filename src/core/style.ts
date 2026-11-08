/**
 * How you play: which pads you hit, and where in the phrase. Counted on this computer, for
 * each kind of record, so DJ mode leans toward the moves you make and the places you make them.
 */

import type { StyleId } from "./genre";

/** The moves DJ mode makes, and learns from yours: the pads of the same names. */
export const MOVES = ["chop1", "chop2", "chop4", "loop", "line", "spin", "screw", "trunk", "echo"] as const;
export type Move = (typeof MOVES)[number];

export function isMove(id: string): id is Move {
    return (MOVES as readonly string[]).includes(id);
}

const KEY = "slab:style:v1";
/** Bars in a phrase, for where a move falls in it. */
export const PHRASE = 8;
/** Under this many moves for a kind of record, there's nothing to lean on yet. */
const ENOUGH = 6;

type Counts = Partial<Record<StyleId, Partial<Record<Move, number[]>>>>;

let counts: Counts | null = null;

function load(): Counts {
    if (counts) return counts;
    counts = {};
    try {
        const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Counts;
        if (parsed && typeof parsed === "object") counts = parsed;
    } catch {
        /* nothing learned is the same as a bad store */
    }
    return counts;
}

function save(): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(counts ?? {}));
    } catch {
        /* ignore */
    }
}

/** A pad you hit, by hand: what it was, on what kind of record, and where in the phrase. */
export function noteMove(style: StyleId, move: Move, barInPhrase: number): void {
    const all = load();
    const byMove = (all[style] ??= {});
    const bars = (byMove[move] ??= new Array(PHRASE).fill(0));
    const at = ((Math.round(barInPhrase) % PHRASE) + PHRASE) % PHRASE;
    bars[at] = (bars[at] ?? 0) + 1;
    save();
}

/**
 * How much DJ mode leans toward a move here: 1 with nothing learned, up to 2.5 for the move
 * you make most, where you make it.
 */
export function lean(style: StyleId, move: Move, barInPhrase: number): number {
    const byMove = load()[style];
    if (!byMove) return 1;
    let total = 0;
    for (const bars of Object.values(byMove)) for (const n of bars ?? []) total += n;
    if (total < ENOUGH) return 1;
    const bars = byMove[move] ?? [];
    const here = bars[((Math.round(barInPhrase) % PHRASE) + PHRASE) % PHRASE] ?? 0;
    const overall = bars.reduce((sum, n) => sum + n, 0);
    return 1 + Math.min(1.5, (here / total) * 6 + overall / total);
}

/** Moves counted for a kind of record. */
export function learned(style: StyleId): number {
    const byMove = load()[style];
    if (!byMove) return 0;
    let total = 0;
    for (const bars of Object.values(byMove)) for (const n of bars ?? []) total += n;
    return total;
}
