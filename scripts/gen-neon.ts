#!/usr/bin/env bun
/**
 * The sign's alphabet, laid out the way a sign bender patterns it: tall, tight
 * letters of straight glass with every turn made around the same form.
 *
 * A glyph is one length of tube, walked in order. `lit` steps are glass with gas
 * showing; `dark` steps are the same glass painted out, and they run behind a
 * lit stem wherever they can so they vanish. Glass cannot cross itself, so where
 * strokes would meet the lit part stops short and that break stays visible. The
 * walk starts and ends on the baseline, so src/ui/neon.ts can join letters with a
 * short painted-out jump under them and finish each word in an electrode.
 *
 * Design units: baseline 0, x-height 70, cap height 100, figures 90, y up.
 *
 *   bun run gen:neon
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

type Point = [number, number];
type Step = { lit: boolean; points: Point[]; radius?: number };

const lit = (...points: Point[]): Step => ({ lit: true, points });
const dark = (...points: Point[]): Step => ({ lit: false, points });
/** A sharp turn, for the points of v, w and M. */
const sharp = (...points: Point[]): Step => ({ lit: true, points, radius: 3 });
const darkSharp = (...points: Point[]): Step => ({ lit: false, points, radius: 3 });

interface Skeleton {
    advance: number;
    walk: Step[];
}

const RADIUS = 13;
const SLANT = Math.tan((4 * Math.PI) / 180);
const X = 70;
const CAP = 100;
const FIG = 90;

const GLYPHS: Record<string, Skeleton> = {
    a: {
        advance: 50,
        walk: [
            dark([0, 0], [0, 56]),
            lit([0, 56], [0, X], [34, X], [34, 0], [44, 0]),
            dark([44, 0], [34, 0], [34, 38], [23, 38]),
            lit([23, 38], [0, 38], [0, 0], [23, 0]),
        ],
    },
    b: {
        advance: 42,
        walk: [
            dark([0, 0], [0, CAP]),
            lit([0, CAP], [0, 0], [34, 0], [34, X], [11, X]),
            dark([11, X], [34, X], [34, 0]),
        ],
    },
    c: {
        advance: 38,
        walk: [
            dark([0, 0], [0, X], [32, X], [32, 56]),
            lit([32, 56], [32, X], [0, X], [0, 0], [32, 0], [32, 14]),
            dark([32, 14], [32, 0]),
        ],
    },
    d: {
        advance: 42,
        walk: [
            dark([0, 0], [0, X], [23, X], [34, X], [34, CAP]),
            lit([34, CAP], [34, 0], [0, 0], [0, X], [23, X]),
            dark([23, X], [0, X], [0, 0], [34, 0]),
        ],
    },
    e: {
        advance: 42,
        walk: [
            dark([0, 0], [0, 37], [11, 37]),
            lit([11, 37], [34, 37], [34, X], [0, X], [0, 0], [34, 0], [34, 12]),
            dark([34, 12], [34, 0]),
        ],
    },
    h: {
        advance: 50,
        walk: [
            dark([0, 0], [0, CAP]),
            lit([0, CAP], [0, 0]),
            dark([0, 0], [0, X], [11, X]),
            lit([11, X], [34, X], [34, 0], [44, 0]),
        ],
    },
    i: {
        advance: 22,
        walk: [
            dark([0, 0], [0, 84]),
            lit([0, 84], [0, 96]),
            dark([0, 96], [0, X]),
            lit([0, X], [0, 0], [11, 0]),
        ],
    },
    l: { advance: 22, walk: [dark([0, 0], [0, CAP]), lit([0, CAP], [0, 0], [11, 0])] },
    m: {
        advance: 76,
        walk: [
            dark([0, 0], [0, X]),
            lit([0, X], [0, 0]),
            dark([0, 0], [0, X], [10, X]),
            lit([10, X], [29, X], [29, 0]),
            dark([29, 0], [29, X], [39, X]),
            lit([39, X], [59, X], [59, 0], [69, 0]),
        ],
    },
    n: {
        advance: 50,
        walk: [
            dark([0, 0], [0, X]),
            lit([0, X], [0, 0]),
            dark([0, 0], [0, X], [11, X]),
            lit([11, X], [34, X], [34, 0], [44, 0]),
        ],
    },
    o: { advance: 42, walk: [lit([18, 0], [0, 0], [0, X], [34, X], [34, 0], [26, 0])] },
    p: {
        advance: 42,
        walk: [
            dark([0, 0], [0, X]),
            dark([0, X], [0, -26]),
            lit([0, -26], [0, X], [34, X], [34, 0], [11, 0]),
            dark([11, 0], [34, 0]),
        ],
    },
    r: {
        advance: 36,
        walk: [
            dark([0, 0], [0, X]),
            lit([0, X], [0, 0]),
            dark([0, 0], [0, X], [11, X]),
            lit([11, X], [30, X], [30, 56]),
            dark([30, 56], [30, X], [0, X], [0, 0]),
        ],
    },
    s: {
        advance: 38,
        walk: [
            dark([0, 0], [0, 13]),
            lit([0, 13], [0, 0], [31, 0], [31, 30], [0, 42], [0, X], [31, X], [31, 57]),
            dark([31, 57], [31, X], [0, X], [0, 42], [31, 30], [31, 0]),
        ],
    },
    t: {
        advance: 36,
        walk: [
            dark([14, 0], [14, X], [0, X]),
            lit([0, X], [6, X]),
            dark([6, X], [22, X]),
            lit([22, X], [29, X]),
            dark([29, X], [14, X], [14, 92]),
            lit([14, 92], [14, 0], [29, 0]),
        ],
    },
    u: {
        advance: 50,
        walk: [
            dark([0, 0], [0, X]),
            lit([0, X], [0, 0], [23, 0]),
            dark([23, 0], [34, 0], [34, X]),
            lit([34, X], [34, 0], [44, 0]),
        ],
    },
    v: {
        advance: 42,
        walk: [
            darkSharp([17, 0], [0, X]),
            sharp([0, X], [17, 0], [34, X]),
            darkSharp([34, X], [17, 0]),
        ],
    },
    w: {
        advance: 62,
        walk: [
            darkSharp([13, 0], [0, X]),
            sharp([0, X], [13, 0], [27, 58], [41, 0], [54, X]),
            darkSharp([54, X], [41, 0]),
        ],
    },

    C: {
        advance: 50,
        walk: [
            dark([0, 0], [0, CAP], [42, CAP], [42, 80]),
            lit([42, 80], [42, CAP], [0, CAP], [0, 0], [42, 0], [42, 20]),
            dark([42, 20], [42, 0]),
        ],
    },
    F: {
        advance: 48,
        walk: [
            lit([0, 0], [0, CAP], [40, CAP]),
            dark([40, CAP], [0, CAP], [0, 54], [11, 54]),
            lit([11, 54], [33, 54]),
            dark([33, 54], [0, 54], [0, 0]),
        ],
    },
    H: {
        advance: 56,
        walk: [
            dark([0, 0], [0, CAP]),
            lit([0, CAP], [0, 0]),
            dark([0, 0], [0, 52], [11, 52]),
            lit([11, 52], [35, 52]),
            dark([35, 52], [46, 52], [46, CAP]),
            lit([46, CAP], [46, 0]),
        ],
    },
    M: {
        advance: 68,
        walk: [
            sharp([0, 0], [0, CAP], [29, 34], [58, CAP], [58, 0]),
        ],
    },
    R: {
        advance: 52,
        walk: [
            dark([0, 0], [0, CAP]),
            lit([0, CAP], [0, 0]),
            dark([0, 0], [0, CAP], [11, CAP]),
            lit([11, CAP], [42, CAP], [42, 50], [13, 50]),
            dark([13, 50], [26, 50], [26, 39]),
            sharp([26, 39], [43, 0]),
        ],
    },
    S: {
        advance: 50,
        walk: [
            dark([0, 0], [0, 20]),
            lit([0, 20], [0, 0], [41, 0], [41, 42], [0, 60], [0, CAP], [41, CAP], [41, 80]),
            dark([41, 80], [41, CAP], [0, CAP], [0, 60], [41, 42], [41, 0]),
        ],
    },
    T: {
        advance: 50,
        walk: [
            lit([21, 0], [21, 88]),
            dark([21, 88], [21, CAP], [0, CAP]),
            lit([0, CAP], [42, CAP]),
            dark([42, CAP], [21, CAP], [21, 0]),
        ],
    },
    U: {
        advance: 54,
        walk: [
            dark([0, 0], [0, CAP]),
            lit([0, CAP], [0, 0], [44, 0], [44, CAP]),
            dark([44, CAP], [44, 0]),
        ],
    },
    "+": {
        advance: 46,
        walk: [
            dark([19, 0], [19, 14]),
            lit([19, 14], [19, 28]),
            dark([19, 28], [19, 39], [0, 39]),
            lit([0, 39], [38, 39]),
            dark([38, 39], [19, 39], [19, 50]),
            lit([19, 50], [19, 64]),
            dark([19, 64], [19, 0]),
        ],
    },

    // Figures sit on the number's own tube, built live from these.
    "0": { advance: 48, walk: [lit([17, 0], [0, 0], [0, FIG], [38, FIG], [38, 0], [25, 0])] },
    "1": { advance: 34, walk: [darkSharp([20, 0], [20, FIG], [2, 72]), sharp([2, 72], [20, FIG], [20, 0])] },
    "2": {
        advance: 48,
        walk: [
            dark([0, 0], [0, 30], [38, 50], [38, FIG], [0, FIG], [0, 72]),
            lit([0, 72], [0, FIG], [38, FIG], [38, 50], [0, 30], [0, 0], [38, 0]),
        ],
    },
    "3": {
        advance: 48,
        walk: [
            dark([0, 0], [38, 0], [38, FIG], [0, FIG], [0, 72]),
            lit([0, 72], [0, FIG], [38, FIG], [38, 50], [13, 50]),
            dark([13, 50], [38, 50]),
            lit([38, 50], [38, 0], [0, 0], [0, 18]),
            dark([0, 18], [0, 0]),
        ],
    },
    "4": {
        advance: 50,
        walk: [
            lit([29, 0], [29, 20]),
            dark([29, 20], [29, 40]),
            sharp([29, 40], [29, FIG], [0, 30], [42, 30]),
            darkSharp([42, 30], [29, 30], [29, 0]),
        ],
    },
    "5": {
        advance: 48,
        walk: [
            dark([0, 0], [38, 0], [38, 52], [0, 52], [0, FIG], [36, FIG]),
            lit([36, FIG], [0, FIG], [0, 52], [38, 52], [38, 0], [0, 0], [0, 18]),
            dark([0, 18], [0, 0]),
        ],
    },
    "6": {
        advance: 48,
        walk: [
            dark([0, 0], [0, FIG], [38, FIG], [38, 74]),
            lit([38, 74], [38, FIG], [0, FIG], [0, 0], [38, 0], [38, 50], [12, 50]),
            dark([12, 50], [38, 50], [38, 0]),
        ],
    },
    "7": { advance: 44, walk: [darkSharp([14, 0], [38, FIG], [0, FIG]), sharp([0, FIG], [38, FIG], [14, 0])] },
    "8": {
        advance: 48,
        walk: [
            lit([26, 0], [38, 0], [38, 38], [31, 45], [38, 52], [38, FIG], [0, FIG], [0, 52], [7, 45], [0, 38], [0, 0], [14, 0]),
            dark([14, 0], [0, 0], [0, 38], [7, 45], [13, 45]),
            lit([13, 45], [25, 45]),
            dark([25, 45], [31, 45], [38, 38], [38, 0], [26, 0]),
        ],
    },
    "9": {
        advance: 48,
        walk: [
            dark([0, 0], [0, 18]),
            lit([0, 18], [0, 0], [38, 0], [38, FIG], [0, FIG], [0, 40], [26, 40]),
            dark([26, 40], [0, 40], [0, FIG], [38, FIG], [38, 0]),
        ],
    },
    "−": { advance: 44, walk: [lit([0, 45], [34, 45])] },
};

function fmt(value: number): string {
    return String(Math.round(value * 10) / 10);
}

const toSign = (p: Point): Point => [p[0] + p[1] * SLANT, -p[1]];

/** Straight glass with each turn taken around a former of the given radius. */
function bend(points: Point[], radius: number): string {
    const pts = points.map(toSign);
    let d = `M${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
    for (let i = 1; i < pts.length - 1; i++) {
        const [px, py] = pts[i - 1];
        const [x, y] = pts[i];
        const [nx, ny] = pts[i + 1];
        const before = Math.hypot(x - px, y - py);
        const after = Math.hypot(nx - x, ny - y);
        const r = Math.min(radius, before / 2, after / 2);
        d += `L${fmt(x + ((px - x) / before) * r)} ${fmt(y + ((py - y) / before) * r)}`;
        d += `Q${fmt(x)} ${fmt(y)} ${fmt(x + ((nx - x) / after) * r)} ${fmt(y + ((ny - y) / after) * r)}`;
    }
    const last = pts[pts.length - 1];
    return `${d}L${fmt(last[0])} ${fmt(last[1])}`;
}

const entries = Object.entries(GLYPHS).map(([char, glyph]) => {
    glyph.walk.forEach((step, index) => {
        const next = glyph.walk[index + 1];
        if (!next) return;
        const end = step.points[step.points.length - 1];
        if (end[0] !== next.points[0][0] || end[1] !== next.points[0][1]) {
            throw new Error(`${char}: the tube breaks between steps ${index} and ${index + 1}`);
        }
    });
    let litPath = "";
    let darkPath = "";
    for (const step of glyph.walk) {
        const d = bend(step.points, step.radius ?? RADIUS);
        if (step.lit) litPath += d;
        else darkPath += d;
    }
    const first = toSign(glyph.walk[0].points[0]);
    const lastStep = glyph.walk[glyph.walk.length - 1];
    const last = toSign(lastStep.points[lastStep.points.length - 1]);
    return `    ${JSON.stringify(char)}: { a: ${glyph.advance}, l: ${JSON.stringify(litPath)}, d: ${JSON.stringify(darkPath)}, i: [${fmt(first[0])}, ${fmt(first[1])}], o: [${fmt(last[0])}, ${fmt(last[1])}] },`;
});

const source = `// Generated by scripts/gen-neon.ts. Hand-drawn tube centrelines in design units.
export interface NeonGlyph {
    /** Advance width. */
    a: number;
    /** The lit glass, y down, baseline at 0. */
    l: string;
    /** The glass painted out inside the letter. */
    d: string;
    /** Where the tube comes in. */
    i: [number, number];
    /** Where the tube leaves. */
    o: [number, number];
}

export const NEON_GLYPHS: Record<string, NeonGlyph> = {
${entries.join("\n")}
};
`;

const out = join(import.meta.dir, "..", "src/ui/neon-glyphs.ts");
await writeFile(out, source);
console.log(`neon-glyphs.ts: ${(source.length / 1024).toFixed(1)} kB, ${entries.length} glyphs`);
