/**
 * The neon tube as DOM: glass, paint-out, electrodes, gas and the supports that
 * hold it off the board, laid out by neon.ts. The panel only places it and sets
 * layouts.
 */

import type { TubeLayout } from "./neon";

type Layer =
    | "shadow"
    | "shadowWide"
    | "dark"
    | "boots"
    | "bootsHi"
    | "frost"
    | "frostHi"
    | "bloom"
    | "halo"
    | "glass"
    | "core"
    | "clipShadow"
    | "clip"
    | "clipHi";

/**
 * One length of neon. Glass, paint-out and electrodes sit in one svg; the gas
 * sits in its own, so a strike only changes the opacity of a composited layer
 * and never repaints the glow; the supports sit in a third over both, so they
 * stay put when the gas goes out.
 */
export class Tube {
    readonly node: HTMLDivElement;
    readonly gas: SVGSVGElement;
    private layers: Record<Layer, SVGPathElement>;
    private current = "";

    constructor(className: string, width: number, height: number) {
        const box = `viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true" focusable="false"`;
        this.node = document.createElement("div");
        this.node.className = `slab-tube ${className}`;
        this.node.innerHTML = `
<svg class="slab-tube-glass" ${box}>
  <g class="slab-tube-cast"><path data-l="shadowWide"/><path data-l="shadow"/></g>
  <path data-l="dark"/><path data-l="boots"/><path data-l="bootsHi"/>
  <g class="slab-tube-frosted"><path data-l="frost"/><path data-l="frostHi"/></g>
</svg>
<svg class="slab-tube-gas" ${box}>
  <path data-l="bloom"/><path data-l="halo"/><path data-l="glass"/><path data-l="core"/>
</svg>
<svg class="slab-tube-clips" ${box}>
  <path data-l="clipShadow"/><path data-l="clip"/><path data-l="clipHi"/>
</svg>`;
        const find = (name: Layer) => this.node.querySelector(`[data-l="${name}"]`) as SVGPathElement;
        const names: Layer[] = ["shadow", "shadowWide", "dark", "boots", "bootsHi", "frost", "frostHi", "bloom", "halo", "glass", "core", "clipShadow", "clip", "clipHi"];
        this.layers = Object.fromEntries(names.map((name) => [name, find(name)])) as Record<Layer, SVGPathElement>;
        this.gas = this.node.querySelector(".slab-tube-gas") as SVGSVGElement;
    }

    set(layout: TubeLayout): void {
        const key = layout.lit + layout.supports;
        if (key === this.current) return;
        this.current = key;
        const { shadow, shadowWide, dark, boots, bootsHi, frost, frostHi, bloom, halo, glass, core, clipShadow, clip, clipHi } = this.layers;
        const all = layout.lit + layout.dark;
        shadow.setAttribute("d", all);
        shadowWide.setAttribute("d", all);
        dark.setAttribute("d", layout.dark);
        boots.setAttribute("d", layout.boots);
        bootsHi.setAttribute("d", layout.boots);
        for (const path of [frost, frostHi, bloom, halo, glass, core]) path.setAttribute("d", layout.lit);
        for (const path of [clipShadow, clip, clipHi]) path.setAttribute("d", layout.supports);
    }
}
