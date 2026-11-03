/**
 * The neon tube as DOM: glass, paint-out, electrodes and gas, laid out by
 * neon.ts. Owned by the lettering; the panel only places it and sets layouts.
 */

import type { TubeLayout } from "./neon";

/**
 * One length of neon. Glass, paint-out and electrodes sit in one svg; the gas
 * sits in its own, so a strike only changes the opacity of a composited layer
 * and never repaints the glow.
 */
export class Tube {
    readonly node: HTMLDivElement;
    readonly gas: SVGSVGElement;
    private layers: Record<"shadow" | "shadowWide" | "dark" | "boots" | "bootsHi" | "frost" | "frostHi" | "bloom" | "halo" | "glass" | "core", SVGPathElement>;
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
</svg>`;
        const find = (name: string) => this.node.querySelector(`[data-l="${name}"]`) as SVGPathElement;
        this.layers = {
            shadow: find("shadow"),
            shadowWide: find("shadowWide"),
            dark: find("dark"),
            boots: find("boots"),
            bootsHi: find("bootsHi"),
            frost: find("frost"),
            frostHi: find("frostHi"),
            bloom: find("bloom"),
            halo: find("halo"),
            glass: find("glass"),
            core: find("core"),
        };
        this.gas = this.node.querySelector(".slab-tube-gas") as SVGSVGElement;
    }

    set(layout: TubeLayout): void {
        if (layout.lit === this.current) return;
        this.current = layout.lit;
        const { shadow, shadowWide, dark, boots, bootsHi, frost, frostHi, bloom, halo, glass, core } = this.layers;
        const all = layout.lit + layout.dark;
        shadow.setAttribute("d", all);
        shadowWide.setAttribute("d", all);
        dark.setAttribute("d", layout.dark);
        boots.setAttribute("d", layout.boots);
        bootsHi.setAttribute("d", layout.boots);
        for (const path of [frost, frostHi, bloom, halo, glass, core]) path.setAttribute("d", layout.lit);
    }
}

