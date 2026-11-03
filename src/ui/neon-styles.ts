/**
 * Neon glass and gas. Every layer is a plain stroke, so there is no filter to
 * repaint. Colours come only from the panel's gas tokens (--gas, --gas-glass,
 * --gas-core), so the sign, the number and the rail tube are always one gas.
 */

export const NEON_CSS = `
/* Neon. Every layer is a plain stroke, so there is no filter to repaint. */
.slab-tube { position: relative; }
.slab-tube svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.slab-tube path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.slab-tube-cast { transform: translate(2.5px, 4.5px); }
.slab-tube [data-l="shadowWide"] { stroke: #000; stroke-width: 6; opacity: 0.16; }
.slab-tube [data-l="shadow"] { stroke: #000; stroke-width: 3.2; opacity: 0.46; }
.slab-tube [data-l="dark"] { stroke: #090405; stroke-width: 2.4; }
.slab-tube [data-l="boots"] { stroke: #16110F; stroke-width: 5; }
.slab-tube [data-l="bootsHi"] { stroke: #8A8682; stroke-width: 1; transform: translateX(-1.2px); }
.slab-tube [data-l="frost"] { stroke: #A9AEAF; stroke-width: 2.8; }
.slab-tube [data-l="frostHi"] { stroke: #E4E7E7; stroke-width: 0.9; }
.slab-tube [data-l="bloom"] { stroke: var(--gas); stroke-width: 13; opacity: 0.1; }
.slab-tube [data-l="halo"] { stroke: var(--gas); stroke-width: 6.5; opacity: 0.32; }
.slab-tube [data-l="glass"] { stroke: var(--gas-glass); stroke-width: 3.1; }
.slab-tube [data-l="core"] { stroke: var(--gas-core); stroke-width: 1.2; }
.slab-tube-gas { will-change: opacity; }

.slab-panel[data-gas="off"] .slab-sign-tube .slab-tube-gas { visibility: hidden; }
.slab-panel[data-tube="off"] .slab-number-tube .slab-tube-gas { visibility: hidden; }
/* The helper is running with nothing to shift: warm glass, not lit. */
.slab-panel[data-tube="idle"] .slab-number-tube .slab-tube-gas { opacity: 0.24; }

.slab-number-tube [data-l="frost"], .slab-number-tube [data-l="glass"] { stroke-width: 2.5; }
.slab-number-tube [data-l="dark"] { stroke-width: 2; }
.slab-number-tube [data-l="core"] { stroke-width: 1; }
.slab-number-tube [data-l="bloom"] { stroke-width: 9; }
.slab-number-tube [data-l="boots"] { stroke-width: 4.4; }
`;
