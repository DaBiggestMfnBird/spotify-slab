/**
 * Lays text out as bent neon tube.
 *
 * Each word is one unit of glass: the letters' lit runs, a short painted-out jump
 * under the baseline between letters, and an electrode at both ends. A plus is a
 * unit of its own that floats, with no jump up into it. The sign and the pitch
 * number both come through here, so the number can be rebuilt live from the same
 * tube; the number's figures are separate pieces of glass, the way number signs
 * are built, with nothing hanging off them. Nothing here touches the DOM.
 */

import { NEON_GLYPHS } from "./neon-glyphs";

export interface TubeLayout {
    /** The lit glass. */
    lit: string;
    /** Glass painted out: inside letters, between them, and down to the electrodes. */
    dark: string;
    /** The electrode boots, as short strokes drawn wide. */
    boots: string;
    /** Tube supports: short clips across straight glass that stand it off the board. */
    supports: string;
}

const NUMBER = /-?\d*\.?\d+/g;
const SPACE_ADVANCE = 34;
/** Under this many px apart, the two ends of a word share one boot. */
const SHARED_BOOT = 8;
const BOOT_LENGTH = 3.5;
/** Half the length of a support clip, in px. */
const CLIP = 3;

function fmt(value: number): string {
    return String(Math.round(value * 10) / 10);
}

/** Scales and moves glyph path data. Glyph paths only use M, L and C, so every number is an x or a y. */
function place(d: string, scale: number, dx: number, dy: number): string {
    let isX = true;
    return d.replace(NUMBER, (token) => {
        const value = Number(token) * scale + (isX ? dx : dy);
        isX = !isX;
        return fmt(value);
    });
}

interface PlacedGlyph {
    lit: string;
    dark: string;
    entry: [number, number];
    exit: [number, number];
    supports: [number, number][];
}

interface Unit {
    glyphs: PlacedGlyph[];
    /** A plus, or a figure in the number: no jump into it, no electrodes showing. */
    floating: boolean;
}

/** One unit per word; a floating glyph is a unit of its own. Uniform scale only: letters are never squashed. */
function placeText(text: string, scale: number, tracking: number, x: number, y: number, eachGlyphFloats = false): Unit[] {
    const units: Unit[] = [{ glyphs: [], floating: false }];
    const fresh = (floating: boolean) => {
        if (units[units.length - 1].glyphs.length) units.push({ glyphs: [], floating });
        else units[units.length - 1].floating = floating;
    };
    let pen = x;
    for (const char of [...text]) {
        if (char === " ") {
            fresh(false);
            pen += SPACE_ADVANCE * scale + tracking;
            continue;
        }
        const glyph = NEON_GLYPHS[char];
        if (!glyph) continue;
        const floats = eachGlyphFloats || glyph.f === true;
        if (floats || units[units.length - 1].floating) fresh(floats);
        units[units.length - 1].glyphs.push({
            lit: place(glyph.l, scale, pen, y),
            dark: place(glyph.d, scale, pen, y),
            entry: [glyph.i[0] * scale + pen, glyph.i[1] * scale + y],
            exit: [glyph.o[0] * scale + pen, glyph.o[1] * scale + y],
            supports: (glyph.s ?? []).map(([sx, sy]) => [sx * scale + pen, sy * scale + y]),
        });
        pen += glyph.a * scale + tracking;
    }
    return units.filter((unit) => unit.glyphs.length > 0);
}

/** Left and right of the glass, from its path points. Close enough to centre by. */
function inkBounds(units: Unit[]): [number, number] {
    let left = Infinity;
    let right = -Infinity;
    for (const unit of units) {
        for (const glyph of unit.glyphs) {
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

/**
 * Supports go on the first and last letters of a word that have straight
 * vertical glass, and one in the middle of a long word: two or three a word,
 * the way a bender spaces them.
 */
function chooseSupports(unit: Unit): [number, number][] {
    const holders = unit.glyphs.filter((glyph) => glyph.supports.length > 0);
    if (holders.length === 0) return [];
    const picked = new Set([holders[0], holders[holders.length - 1]]);
    if (unit.glyphs.length >= 6 && holders.length >= 3) picked.add(holders[Math.floor(holders.length / 2)]);
    return [...picked].map((glyph) => glyph.supports[0]);
}

/** Threads a word: boot, letter, painted-out jump under the baseline, letter, boot. */
function thread(units: Unit[], baseline: number, drop: number): TubeLayout {
    let lit = "";
    let dark = "";
    let boots = "";
    let supports = "";
    const rail = baseline + drop;
    for (const unit of units) {
        if (unit.floating) {
            for (const glyph of unit.glyphs) {
                lit += glyph.lit;
                dark += glyph.dark;
            }
            continue;
        }
        let previous: [number, number] | null = null;
        for (const glyph of unit.glyphs) {
            if (previous) {
                dark += `M${fmt(previous[0])} ${fmt(previous[1])}V${fmt(rail)}H${fmt(glyph.entry[0])}V${fmt(glyph.entry[1])}`;
            }
            lit += glyph.lit;
            dark += glyph.dark;
            previous = glyph.exit;
        }
        const start = unit.glyphs[0].entry;
        const end = previous as [number, number];
        const shared = Math.abs(end[0] - start[0]) < SHARED_BOOT;
        const bootAt = shared ? [(start[0] + end[0]) / 2] : [start[0], end[0]];
        dark += `M${fmt(start[0])} ${fmt(start[1])}V${fmt(rail)}M${fmt(end[0])} ${fmt(end[1])}V${fmt(rail)}`;
        if (shared) dark += `M${fmt(start[0])} ${fmt(rail)}H${fmt(end[0])}`;
        for (const x of bootAt) boots += `M${fmt(x)} ${fmt(rail)}v${BOOT_LENGTH}`;
        for (const [x, y] of chooseSupports(unit)) supports += `M${fmt(x - CLIP)} ${fmt(y)}H${fmt(x + CLIP)}`;
    }
    return { lit, dark, boots, supports };
}

/** The sign's drawing area, matched by the svg viewBox in deck.ts. */
export const SIGN_WIDTH = 360;
export const SIGN_HEIGHT = 70;

/**
 * Every name gets its own fit. Scale is uniform, so a long name gives up height
 * rather than being squashed; `tracking` opens or closes its run and `margin`
 * keeps the glow clear of the trim. Flat is too short to hold the board on its
 * own, so it gets what its name says: a dead level run of tube either side.
 */
const SIGN_FIT: Record<string, { tracking: number; margin: number; level?: boolean }> = {
    sped: { tracking: 5, margin: 40 },
    flat: { tracking: 6, margin: 20, level: true },
    chopped: { tracking: 4, margin: 22 },
    slowed: { tracking: 3, margin: 20 },
    memphis: { tracking: 3, margin: 20 },
    screwed: { tracking: 4, margin: 22 },
};

const CAP_HEIGHT = 100;
const DESCENDER = 26;
const LEVEL_GAP = 14;
/** Space under the baseline for the jumps and the boots, including their round caps. */
const UNDER = 9;
/** Glow clearance: 12px of board, plus half the bloom. Margins never go under it. */
const MIN_MARGIN = 19;

/** `height` is less than the board when the message needs the room. */
export function signLayout(id: string, name: string, height = SIGN_HEIGHT): TubeLayout {
    const fit = SIGN_FIT[id] ?? { tracking: 4, margin: 22 };
    const margin = Math.max(MIN_MARGIN, fit.margin);
    const gaps = [...name].length - 1;

    const descends = /[pq]/.test(name);
    const room = height - 3 - UNDER;
    const byHeight = (descends ? (room * CAP_HEIGHT) / (CAP_HEIGHT + DESCENDER) : room) / CAP_HEIGHT;
    const [unitLeft, unitRight] = inkBounds(placeText(name, 1, 0, 0, 0));
    const byWidth = (SIGN_WIDTH - margin * 2 - fit.tracking * gaps) / (unitRight - unitLeft);
    const scale = Math.min(byHeight, byWidth);

    // Centred on the board: a long name sits in the middle, not hung from the top.
    const block = CAP_HEIGHT * scale + (descends ? DESCENDER * scale : 0) + UNDER;
    const top = 3 + Math.max(0, (height - 3 - block) / 2);
    const baseline = top + CAP_HEIGHT * scale;
    const [left, right] = inkBounds(placeText(name, scale, fit.tracking, 0, baseline));
    const dx = (SIGN_WIDTH - (right - left)) / 2 - left;
    const units = placeText(name, scale, fit.tracking, dx, baseline);

    const layout = thread(units, baseline, 3);
    if (fit.level) {
        const y = fmt(baseline - 50 * scale);
        const start = fmt(left + dx - LEVEL_GAP);
        const end = fmt(right + dx + LEVEL_GAP);
        layout.lit += `M${margin} ${y}H${start}M${end} ${y}H${SIGN_WIDTH - margin}`;
        const rail = fmt(baseline + 3);
        layout.dark += `M${margin} ${y}V${rail}M${start} ${y}V${rail}M${end} ${y}V${rail}M${SIGN_WIDTH - margin} ${y}V${rail}`;
        layout.boots += `M${margin} ${rail}v${BOOT_LENGTH}M${start} ${rail}v${BOOT_LENGTH}M${end} ${rail}v${BOOT_LENGTH}M${SIGN_WIDTH - margin} ${rail}v${BOOT_LENGTH}`;
        const mid = (a: number, b: number) => fmt((a + b) / 2);
        layout.supports += `M${Number(mid(margin, Number(start))) - CLIP} ${y}h${CLIP * 2}M${Number(mid(Number(end), SIGN_WIDTH - margin)) - CLIP} ${y}h${CLIP * 2}`;
    }
    return layout;
}

/** The pitch number's drawing area, also matched in deck.ts. */
export const NUMBER_WIDTH = 118;
export const NUMBER_HEIGHT = 42;

const NUMBER_SCALE = 0.36;
const NUMBER_TRACKING = 2;
const NUMBER_BASELINE = 36;

/**
 * Right-aligned, so the figures stay put against the nudges. Each figure is its
 * own piece of glass with no jump and no electrode showing, so "−560" reads as
 * four marks and nothing else.
 */
export function numberLayout(cents: number): TubeLayout {
    const text = cents === 0 ? "0" : `${cents < 0 ? "−" : "+"}${Math.abs(cents)}`;
    const [, right] = inkBounds(placeText(text, NUMBER_SCALE, NUMBER_TRACKING, 0, NUMBER_BASELINE, true));
    const units = placeText(text, NUMBER_SCALE, NUMBER_TRACKING, NUMBER_WIDTH - right - 4, NUMBER_BASELINE, true);
    return thread(units, NUMBER_BASELINE, 2.5);
}
