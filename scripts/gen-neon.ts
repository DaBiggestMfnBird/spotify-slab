#!/usr/bin/env bun
/**
 * The sign's alphabet, laid out the way a Texas sign shop bends gothic: upright,
 * condensed letters of straight glass, every bowl a full round, every turn made
 * around a real former.
 *
 * A glyph is one length of tube, walked in order. `lit` steps are glass with gas
 * showing; `dark` steps are the same glass painted out, and they run behind lit
 * glass wherever they can so they vanish. Rules the walks keep:
 *
 * - Glass can't cross itself or bend tighter than about its own width, so every
 *   corner is a true circular bend (radius 6 at the tightest, the points of v, w
 *   and M), and bowls are stadiums whose ends are half the bowl's width.
 * - Where a stroke meets a stem (the bar of e, F, H; the arch of h and m; the
 *   bowl of b, d, p) it stops one glass width short: the tube bends into the
 *   stem, it doesn't float off it.
 * - Where strokes truly cross (t, +, 4) the glass breaks once, on one side.
 * - Supports clip on low down, on straight stems only: a clip across a bowl or
 *   halfway up a stroke reads as part of the letter.
 * - A word's tube comes in and leaves on lit glass at the baseline, so the
 *   painted-out jumps that src/ui/neon.ts threads under the letters hide behind
 *   the glass instead of poking out of a corner.
 * - The plus floats: its own unit of glass, no jump up into it from the baseline.
 * - Figures are separate units with no electrodes showing, the way number signs
 *   are built, so the pitch number reads as figures and nothing else.
 *
 * Design units: baseline 0, x-height 70, cap height 100, figures 90, y up.
 *
 *   bun run gen:neon
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A point, with the bend radius to use if the tube turns there. */
type Point = [number, number] | [number, number, number];
type Step = { kind: "lit" | "dark" | "move"; points: Point[] };

const lit = (...points: Point[]): Step => ({ kind: "lit", points });
const dark = (...points: Point[]): Step => ({ kind: "dark", points });
/** A separate piece of glass: nothing is drawn between the two. Figures only. */
const move = (from: Point, to: Point): Step => ({ kind: "move", points: [from, to] });

interface Skeleton {
    advance: number;
    walk: Step[];
    /** Points on straight vertical glass where a tube support can clip on. */
    supports?: [number, number][];
    /** A unit of its own, with no jump into it and no electrodes showing. */
    floating?: boolean;
}

/** The default bend: a full round on a lowercase bowl. */
const RADIUS = 17;
const X = 70;
const CAP = 100;
const FIG = 90;

const GLYPHS: Record<string, Skeleton> = {
    // Single-storey a: a bowl against its stem, the bottom stopping a glass width short.
    a: {
        advance: 46,
        walk: [lit([34, 0], [34, X, 13], [0, X, 17], [0, 0, 17], [28, 0])],
        supports: [[34, 20]],
    },
    b: {
        advance: 46,
        walk: [
            dark([17, 0], [0, 0, 17], [0, CAP]),
            lit([0, CAP], [0, 0, 17], [34, 0, 17], [34, X, 17], [6, X]),
            dark([6, X], [34, X, 17], [34, 0, 17], [17, 0]),
        ],
        supports: [[0, 22]],
    },
    c: {
        advance: 42,
        walk: [
            dark([17, 0], [30, 0]),
            lit([30, 0], [0, 0, 17], [0, X, 17], [30, X]),
            dark([30, X], [0, X, 17], [0, 0, 17], [17, 0]),
        ],
    },
    d: {
        advance: 46,
        walk: [
            dark([17, 0], [34, 0, 17], [34, CAP]),
            lit([34, CAP], [34, 0, 17], [0, 0, 17], [0, X, 17], [28, X]),
            dark([28, X], [0, X, 17], [0, 0, 17], [17, 0]),
        ],
        supports: [[34, 22]],
    },
    e: {
        advance: 44,
        walk: [
            dark([17, 0], [0, 0, 17], [0, 36, 0], [6, 36]),
            lit([6, 36], [34, 36, 10], [34, X, 17], [0, X, 17], [0, 0, 17], [30, 0]),
        ],
    },
    h: {
        advance: 46,
        walk: [
            dark([0, 0], [0, CAP]),
            lit([0, CAP], [0, 0]),
            dark([0, 0], [0, X, 0], [6, X]),
            lit([6, X], [34, X, 17], [34, 0]),
        ],
        supports: [[0, 20]],
    },
    i: {
        advance: 22,
        walk: [
            dark([0, 0], [0, 84]),
            lit([0, 84], [0, 96]),
            dark([0, 96], [0, X]),
            lit([0, X], [0, 0]),
        ],
        supports: [[0, 20]],
    },
    l: {
        advance: 22,
        walk: [dark([0, 0], [0, CAP]), lit([0, CAP], [0, 0])],
        supports: [[0, 20]],
    },
    m: {
        advance: 70,
        walk: [
            lit([0, 0], [0, X, 14], [29, X, 14], [29, 0]),
            dark([29, 0], [29, X, 0], [35, X]),
            lit([35, X], [58, X, 14], [58, 0]),
        ],
        supports: [[0, 20], [58, 20]],
    },
    n: {
        advance: 46,
        walk: [lit([0, 0], [0, X, 17], [34, X, 17], [34, 0])],
        supports: [[0, 20]],
    },
    o: {
        advance: 46,
        walk: [
            dark([17, 0], [0, 0, 17], [0, 36]),
            lit([0, 36], [0, 0, 17], [34, 0, 17], [34, X, 17], [0, X, 17], [0, 44]),
            dark([0, 44], [0, 0, 17], [17, 0]),
        ],
    },
    p: {
        advance: 46,
        walk: [lit([0, -26], [0, X, 17], [34, X, 17], [34, 0, 17], [6, 0])],
        supports: [[0, -12]],
    },
    r: {
        advance: 38,
        walk: [
            lit([0, 0], [0, X, 13], [28, X, 10], [28, 58]),
            dark([28, 58], [28, X, 10], [0, X, 13], [0, 0]),
        ],
        supports: [[0, 20]],
    },
    s: {
        advance: 42,
        walk: [
            dark([14, 0], [0, 0, 12], [0, 12]),
            lit([0, 12], [0, 0, 12], [30, 0, 14], [30, 35, 14], [0, 35, 14], [0, X, 14], [30, X, 12], [30, 58]),
            dark([30, 58], [30, X, 12], [0, X, 14], [0, 35, 14], [30, 35, 14], [30, 0, 14], [14, 0]),
        ],
    },
    // The bar runs into the stem on the left and breaks once on the right.
    t: {
        advance: 38,
        walk: [
            dark([26, 0], [14, 0, 10], [14, X, 0], [0, X]),
            lit([0, X], [11, X]),
            dark([11, X], [23, X]),
            lit([23, X], [30, X]),
            dark([30, X], [14, X, 0], [14, 92]),
            lit([14, 92], [14, 0, 10], [26, 0]),
        ],
        supports: [[14, 20]],
    },
    v: {
        advance: 44,
        walk: [
            dark([17, 0], [11, 0, 6], [0, X]),
            lit([0, X], [11, 0, 6], [23, 0, 6], [34, X]),
            dark([34, X], [23, 0, 6], [17, 0]),
        ],
    },
    w: {
        advance: 70,
        walk: [
            dark([12, 0], [6, 0, 6], [0, X]),
            lit([0, X], [6, 0, 6], [18, 0, 6], [30, 48, 6], [42, 0, 6], [54, 0, 6], [60, X]),
            dark([60, X], [54, 0, 6], [48, 0]),
        ],
    },

    C: {
        advance: 52,
        walk: [
            dark([24, 0], [40, 0]),
            lit([40, 0], [0, 0, 21], [0, CAP, 21], [40, CAP]),
            dark([40, CAP], [0, CAP, 21], [0, 0, 21], [24, 0]),
        ],
    },
    F: {
        advance: 46,
        walk: [
            lit([0, 0], [0, CAP, 12], [38, CAP]),
            dark([38, CAP], [0, CAP, 12], [0, 54, 0], [6, 54]),
            lit([6, 54], [30, 54]),
            dark([30, 54], [0, 54, 0], [0, 0]),
        ],
        supports: [[0, 20]],
    },
    M: {
        advance: 70,
        walk: [lit([0, 0], [0, CAP, 6], [12, CAP, 6], [29, 40, 6], [46, CAP, 6], [58, CAP, 6], [58, 0])],
        supports: [[0, 20], [58, 20]],
    },
    R: {
        advance: 54,
        walk: [
            lit([0, 0], [0, CAP, 13], [40, CAP, 20], [40, 52, 20], [6, 52]),
            dark([6, 52], [23, 52, 0], [25.2, 46.4]),
            lit([25.2, 46.4], [44, 0]),
        ],
        supports: [[0, 20]],
    },
    S: {
        advance: 52,
        walk: [
            dark([18, 0], [0, 0, 14], [0, 16]),
            lit([0, 16], [0, 0, 14], [40, 0, 18], [40, 50, 18], [0, 50, 18], [0, CAP, 18], [40, CAP, 14], [40, 84]),
            dark([40, 84], [40, CAP, 14], [0, CAP, 18], [0, 50, 18], [40, 50, 18], [40, 0, 18], [18, 0]),
        ],
    },
    T: {
        advance: 50,
        walk: [
            lit([22, 0], [22, 94]),
            dark([22, 94], [22, CAP, 0], [0, CAP]),
            lit([0, CAP], [44, CAP]),
            dark([44, CAP], [22, CAP, 0], [22, 0]),
        ],
        supports: [[22, 20]],
    },
    U: {
        advance: 56,
        walk: [
            dark([22, 0], [0, 0, 22], [0, CAP]),
            lit([0, CAP], [0, 0, 22], [44, 0, 22], [44, CAP]),
            dark([44, CAP], [44, 0, 22], [22, 0]),
        ],
        supports: [[0, 30], [44, 30]],
    },
    // The vertical stays whole; the bar runs into it on the left and breaks once on the right.
    "+": {
        advance: 48,
        floating: true,
        walk: [
            lit([19, 20], [19, 70]),
            dark([19, 70], [19, 45, 0], [0, 45]),
            lit([0, 45], [16, 45]),
            dark([16, 45], [27, 45]),
            lit([27, 45], [38, 45]),
        ],
    },

    // Figures: each its own piece of glass, built live into the pitch number.
    "0": { advance: 48, walk: [lit([0, 36], [0, 0, 19], [38, 0, 19], [38, FIG, 19], [0, FIG, 19], [0, 44])] },
    // The flag's corner sits above the figure line so the bent glass tops out on it.
    "1": { advance: 32, walk: [lit([4, 80], [20, 101, 6], [20, 0])] },
    "2": { advance: 48, walk: [lit([0, 70], [0, FIG, 16], [38, FIG, 16], [38, 56, 12], [0, 26, 10], [0, 0, 8], [38, 0])] },
    "3": {
        advance: 48,
        walk: [
            lit([0, 72], [0, FIG, 16], [38, FIG, 16], [38, 0, 16], [0, 0, 16], [0, 18]),
            dark([0, 18], [0, 0, 16], [38, 0, 16], [38, 47, 0], [32, 47]),
            lit([32, 47], [14, 47]),
        ],
    },
    "4": {
        advance: 50,
        walk: [
            lit([25, FIG], [0, 30, 8], [29, 30]),
            dark([29, 30], [40, 30]),
            lit([40, 30], [44, 30]),
            dark([44, 30], [32, 30, 0], [32, 0]),
            lit([32, 0], [32, FIG]),
        ],
    },
    "5": { advance: 48, walk: [lit([36, FIG], [0, FIG, 8], [0, 52, 6], [38, 52, 16], [38, 0, 16], [0, 0, 14], [0, 18])] },
    "6": { advance: 48, walk: [lit([38, 72], [38, FIG, 16], [0, FIG, 19], [0, 0, 19], [38, 0, 19], [38, 50, 16], [8, 50])] },
    "7": { advance: 46, walk: [lit([0, FIG], [38, FIG, 6], [14, 0])] },
    "8": {
        advance: 48,
        walk: [
            lit([38, 27], [38, 48, 19], [0, 48, 19], [0, 0, 19], [38, 0, 19], [38, 21]),
            move([38, 21], [3, 72]),
            lit([3, 72], [3, FIG, 16], [35, FIG, 16], [35, 50, 16], [3, 50, 16], [3, 66]),
        ],
    },
    "9": { advance: 48, walk: [lit([0, 18], [0, 0, 16], [38, 0, 19], [38, FIG, 19], [0, FIG, 19], [0, 40, 16], [30, 40])] },
    "−": { advance: 42, walk: [lit([0, 45], [30, 45])] },
};

function fmt(value: number): string {
    return String(Math.round(value * 10) / 10);
}

/** Design units (y up) to sign units (y down). Upright: a sign-shop gothic, not a 4° accident. */
const toSign = (x: number, y: number): [number, number] => [x, -y];

/**
 * Straight glass with each turn taken around a former: a true circular bend,
 * drawn as a cubic. A turn may use up to the whole of a segment that ends the
 * walk, and up to half of one shared with another turn, so a bowl's ends can be
 * a full half-circle. A dark step retracing a lit one makes the same bends, so
 * it stays hidden behind the glass.
 */
function bend(points: Point[]): string {
    const at = points.map((p) => toSign(p[0], p[1]));
    let d = `M${fmt(at[0][0])} ${fmt(at[0][1])}`;
    for (let i = 1; i < at.length - 1; i++) {
        const [ax, ay] = at[i - 1];
        const [bx, by] = at[i];
        const [cx, cy] = at[i + 1];
        const radius = points[i][2] ?? RADIUS;
        const before = Math.hypot(bx - ax, by - ay);
        const after = Math.hypot(cx - bx, cy - by);
        const ux = (bx - ax) / before;
        const uy = (by - ay) / before;
        const vx = (cx - bx) / after;
        const vy = (cy - by) / after;
        const turn = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
        if (radius <= 0 || turn < 1e-4) {
            d += `L${fmt(bx)} ${fmt(by)}`;
            continue;
        }
        const room = Math.min(before * (i - 1 === 0 ? 1 : 0.5), after * (i + 1 === at.length - 1 ? 1 : 0.5));
        const t = Math.min(radius * Math.tan(turn / 2), room);
        const r = t / Math.tan(turn / 2);
        const handle = (4 / 3) * Math.tan(turn / 4) * r;
        const [sx, sy] = [bx - ux * t, by - uy * t];
        const [ex, ey] = [bx + vx * t, by + vy * t];
        d += `L${fmt(sx)} ${fmt(sy)}`;
        d += `C${fmt(sx + ux * handle)} ${fmt(sy + uy * handle)} ${fmt(ex - vx * handle)} ${fmt(ey - vy * handle)} ${fmt(ex)} ${fmt(ey)}`;
    }
    const last = at[at.length - 1];
    return `${d}L${fmt(last[0])} ${fmt(last[1])}`;
}

const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];

const entries = Object.entries(GLYPHS).map(([char, glyph]) => {
    glyph.walk.forEach((step, index) => {
        const next = glyph.walk[index + 1];
        if (next && !same(step.points[step.points.length - 1], next.points[0])) {
            throw new Error(`${char}: the tube breaks between steps ${index} and ${index + 1}`);
        }
    });
    let litPath = "";
    let darkPath = "";
    for (const step of glyph.walk) {
        if (step.kind === "move") continue;
        const d = bend(step.points);
        if (step.kind === "lit") litPath += d;
        else darkPath += d;
    }
    const first = toSign(...(glyph.walk[0].points[0].slice(0, 2) as [number, number]));
    const lastStep = glyph.walk[glyph.walk.length - 1];
    const last = toSign(...(lastStep.points[lastStep.points.length - 1].slice(0, 2) as [number, number]));
    const supports = (glyph.supports ?? []).map(([x, y]) => toSign(x, y));
    const extra = `${supports.length ? `, s: ${JSON.stringify(supports.map(([x, y]) => [Number(fmt(x)), Number(fmt(y))]))}` : ""}${glyph.floating ? ", f: true" : ""}`;
    return `    ${JSON.stringify(char)}: { a: ${glyph.advance}, l: ${JSON.stringify(litPath)}, d: ${JSON.stringify(darkPath)}, i: [${fmt(first[0])}, ${fmt(first[1])}], o: [${fmt(last[0])}, ${fmt(last[1])}]${extra} },`;
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
    /** Where a tube support can clip onto straight vertical glass. */
    s?: [number, number][];
    /** Its own unit of glass: no jump into it, no electrodes showing. */
    f?: boolean;
}

export const NEON_GLYPHS: Record<string, NeonGlyph> = {
${entries.join("\n")}
};
`;

const out = join(import.meta.dir, "..", "src/ui/neon-glyphs.ts");
await writeFile(out, source);
console.log(`neon-glyphs.ts: ${(source.length / 1024).toFixed(1)} kB, ${entries.length} glyphs`);
