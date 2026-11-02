/**
 * Lays text out as bent neon tube.
 *
 * Each word is one unit of glass: the letters' lit runs, a short painted-out jump
 * under the baseline between letters, and an electrode at both ends. The sign and
 * the pitch number both come through here, so the number can be rebuilt live from
 * the same tube. Nothing here touches the DOM.
 */

import { NEON_GLYPHS } from "./neon-glyphs";

export interface TubeLayout {
    /** The lit glass. */
    lit: string;
    /** Glass painted out: inside letters, between them, and down to the electrodes. */
    dark: string;
    /** The electrode boots, as short strokes drawn wide. */
    boots: string;
}

const NUMBER = /-?\d*\.?\d+/g;
const SPACE_ADVANCE = 34;
/** Under this many px apart, the two ends of a word share one boot. */
const SHARED_BOOT = 8;
const BOOT_LENGTH = 3.5;

function fmt(value: number): string {
    return String(Math.round(value * 10) / 10);
}

function place(d: string, sx: number, sy: number, dx: number, dy: number): string {
    let isX = true;
    return d.replace(NUMBER, (token) => {
        const value = Number(token) * (isX ? sx : sy) + (isX ? dx : dy);
        isX = !isX;
        return fmt(value);
    });
}

interface PlacedGlyph {
    lit: string;
    dark: string;
    entry: [number, number];
    exit: [number, number];
}

/** One word per unit of glass. A plus travels with the word before it. */
function placeText(text: string, sx: number, sy: number, tracking: number, x: number, y: number): PlacedGlyph[][] {
    const units: PlacedGlyph[][] = [[]];
    let pen = x;
    const chars = [...text];
    chars.forEach((char, index) => {
        if (char === " ") {
            if (chars[index + 1] !== "+" && units[units.length - 1].length) units.push([]);
            pen += SPACE_ADVANCE * sx + tracking;
            return;
        }
        const glyph = NEON_GLYPHS[char];
        if (!glyph) return;
        units[units.length - 1].push({
            lit: place(glyph.l, sx, sy, pen, y),
            dark: place(glyph.d, sx, sy, pen, y),
            entry: [glyph.i[0] * sx + pen, glyph.i[1] * sy + y],
            exit: [glyph.o[0] * sx + pen, glyph.o[1] * sy + y],
        });
        pen += glyph.a * sx + tracking;
    });
    return units.filter((unit) => unit.length > 0);
}

/** Left and right of the glass, from its path points. Close enough to centre by. */
function inkBounds(units: PlacedGlyph[][]): [number, number] {
    let left = Infinity;
    let right = -Infinity;
    for (const unit of units) {
        for (const glyph of unit) {
            glyph.lit.match(NUMBER)?.forEach((token, index) => {
                if (index % 2) return;
                const value = Number(token);
                if (value < left) left = value;
                if (value > right) right = value;
            });
        }
    }
    return [left, right];
}

/** Threads a word: boot, letter, painted-out jump under the baseline, letter, boot. */
function thread(units: PlacedGlyph[][], baseline: number, drop: number): TubeLayout {
    let lit = "";
    let dark = "";
    let boots = "";
    const rail = baseline + drop;
    for (const unit of units) {
        let previous: [number, number] | null = null;
        for (const glyph of unit) {
            if (previous) {
                dark += `M${fmt(previous[0])} ${fmt(previous[1])}V${fmt(rail)}H${fmt(glyph.entry[0])}V${fmt(glyph.entry[1])}`;
            }
            lit += glyph.lit;
            dark += glyph.dark;
            previous = glyph.exit;
        }
        const start = unit[0].entry;
        const end = previous as [number, number];
        const shared = Math.abs(end[0] - start[0]) < SHARED_BOOT;
        const bootAt = shared ? [(start[0] + end[0]) / 2] : [start[0], end[0]];
        dark += `M${fmt(start[0])} ${fmt(start[1])}V${fmt(rail)}M${fmt(end[0])} ${fmt(end[1])}V${fmt(rail)}`;
        if (shared) dark += `M${fmt(start[0])} ${fmt(rail)}H${fmt(end[0])}`;
        for (const x of bootAt) boots += `M${fmt(x)} ${fmt(rail)}v${BOOT_LENGTH}`;
    }
    return { lit, dark, boots };
}

/** The sign's drawing area, matched by the svg viewBox in deck.ts. */
export const SIGN_WIDTH = 360;
export const SIGN_HEIGHT = 70;

/**
 * Every name gets its own fit. A sign is patterned to its board, so height is
 * always filled and each name is condensed or opened out to the width: `wide`
 * limits how far a short name may stretch, and `margin` and `tracking` set its
 * run. Flat is too short for that to hold the sign, so it gets what its name
 * says: a dead level run of tube either side of the word.
 */
const SIGN_FIT: Record<string, { tracking: number; margin: number; wide: number; level?: boolean }> = {
    sped: { tracking: 7, margin: 30, wide: 1 },
    flat: { tracking: 7, margin: 10, wide: 1, level: true },
    chopped: { tracking: 2.5, margin: 2, wide: 1 },
    slowed: { tracking: 2.5, margin: 2, wide: 1 },
    memphis: { tracking: 3, margin: 6, wide: 1 },
    screwed: { tracking: 2.5, margin: 2, wide: 1 },
};

const CAP_HEIGHT = 100;
const DESCENDER = 26;
const LEVEL_GAP = 14;
/** Space under the baseline for the jumps and the boots, including their round caps. */
const UNDER = 9;

/** `height` is less than the board when the message needs the room. */
export function signLayout(id: string, name: string, height = SIGN_HEIGHT): TubeLayout {
    const fit = SIGN_FIT[id] ?? { tracking: 2, margin: 6, wide: 1 };
    const gaps = [...name].length - 1;

    const descends = /[pq]/.test(name);
    const room = height - 3;
    const sy = (descends ? Math.min(room - UNDER, (room * CAP_HEIGHT) / (CAP_HEIGHT + DESCENDER)) : room - UNDER) / CAP_HEIGHT;

    const [unitLeft, unitRight] = inkBounds(placeText(name, 1, sy, 0, 0, 0));
    const byWidth = (SIGN_WIDTH - fit.margin * 2 - fit.tracking * gaps) / (unitRight - unitLeft);
    const sx = Math.min(byWidth, sy * fit.wide);

    const baseline = 3 + CAP_HEIGHT * sy;
    const [left, right] = inkBounds(placeText(name, sx, sy, fit.tracking, 0, baseline));
    const dx = (SIGN_WIDTH - (right - left)) / 2 - left;
    const units = placeText(name, sx, sy, fit.tracking, dx, baseline);

    const layout = thread(units, baseline, 3);
    if (fit.level) {
        const y = fmt(baseline - 50 * sy);
        const start = fmt(left + dx - LEVEL_GAP);
        const end = fmt(right + dx + LEVEL_GAP);
        layout.lit += `M${fit.margin} ${y}H${start}M${end} ${y}H${SIGN_WIDTH - fit.margin}`;
        const rail = fmt(baseline + 3);
        layout.dark += `M${fit.margin} ${y}V${rail}M${start} ${y}V${rail}M${end} ${y}V${rail}M${SIGN_WIDTH - fit.margin} ${y}V${rail}`;
        layout.boots += `M${fit.margin} ${rail}v${BOOT_LENGTH}M${start} ${rail}v${BOOT_LENGTH}M${end} ${rail}v${BOOT_LENGTH}M${SIGN_WIDTH - fit.margin} ${rail}v${BOOT_LENGTH}`;
    }
    return layout;
}

/** The pitch number's drawing area, also matched in deck.ts. */
export const NUMBER_WIDTH = 118;
export const NUMBER_HEIGHT = 42;

const NUMBER_SX = 0.4;
const NUMBER_SY = 0.33;
const NUMBER_TRACKING = 0.5;
const NUMBER_BASELINE = 33;

/** Right-aligned, so the digits stay put against the nudges as the sign comes and goes. */
export function numberLayout(cents: number): TubeLayout {
    const text = cents === 0 ? "0" : `${cents < 0 ? "−" : "+"}${Math.abs(cents)}`;
    const [, right] = inkBounds(placeText(text, NUMBER_SX, NUMBER_SY, NUMBER_TRACKING, 0, NUMBER_BASELINE));
    const units = placeText(text, NUMBER_SX, NUMBER_SY, NUMBER_TRACKING, NUMBER_WIDTH - right - 4, NUMBER_BASELINE);
    return thread(units, NUMBER_BASELINE, 2.5);
}
