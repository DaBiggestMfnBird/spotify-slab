/**
 * Neon glass and gas. Every layer is a plain stroke, so there is no filter to
 * repaint. Colours come only from the panel's gas tokens (--gas, --gas-glass,
 * --gas-core), so the sign, the number and the rail tube are always one gas.
 */

export const NEON_CSS = `
.slab-tube { position: relative; }
.slab-tube svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.slab-tube path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
/* Standoffs hold the glass off the board, so it throws a soft shadow down and right. */
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
/* Tube supports: small chrome clips across straight glass, seated on the board by their own shadow. */
.slab-tube [data-l="clipShadow"] { stroke: #000; stroke-width: 2; stroke-linecap: butt; opacity: 0.55; transform: translate(0.7px, 1.2px); }
.slab-tube [data-l="clip"] { stroke: #B9C0C5; stroke-width: 1.6; stroke-linecap: butt; }
.slab-tube [data-l="clipHi"] { stroke: #F4F6F7; stroke-width: 0.5; stroke-linecap: butt; transform: translateY(-0.45px); }

.slab-panel[data-gas="off"] .slab-sign-tube .slab-tube-gas { visibility: hidden; }
.slab-panel[data-tube="off"] .slab-number-tube .slab-tube-gas { visibility: hidden; }
/* The helper is running with nothing to shift: warm glass, not lit. */
.slab-panel[data-tube="idle"] .slab-number-tube .slab-tube-gas { opacity: 0.24; }

/* The nameplate on the deck lid, bent in the same glass: a fine tube for small script. */
.slab-logo-tube { width: 58px; height: 28px; }
.slab-logo-tube .slab-tube-cast { transform: translate(0.7px, 1.3px); opacity: 0.75; }
.slab-logo-tube [data-l="shadowWide"] { stroke-width: 3.2; }
.slab-logo-tube [data-l="shadow"] { stroke-width: 2; }
.slab-logo-tube [data-l="frost"] { stroke-width: 1.8; }
.slab-logo-tube [data-l="frostHi"] { stroke-width: 0.55; }
.slab-logo-tube [data-l="bloom"] { stroke-width: 7.5; }
.slab-logo-tube [data-l="halo"] { stroke-width: 3.8; }
.slab-logo-tube [data-l="glass"] { stroke-width: 1.9; }
.slab-logo-tube [data-l="core"] { stroke-width: 0.8; }
.slab-panel[data-gas="off"] .slab-logo-tube .slab-tube-gas { visibility: hidden; }

/*
 * The ring round the big wheel: a thin loop of glass at low current, so it never
 * outshines the sign, the number or the rail. Each beat drives it up and it
 * settles before the next (deck.ts sets the opacity from the beat clock).
 */
.slab-ring-tube .slab-tube-cast { transform: translate(1px, 2px); opacity: 0.45; }
.slab-ring-tube [data-l="shadowWide"] { stroke-width: 4; opacity: 0.1; }
.slab-ring-tube [data-l="shadow"] { stroke-width: 2.2; opacity: 0.3; }
.slab-ring-tube [data-l="frost"] { stroke-width: 1.8; opacity: 0.4; }
.slab-ring-tube [data-l="frostHi"] { opacity: 0.35; }
.slab-ring-tube [data-l="bloom"] { stroke-width: 9; opacity: 0.08; }
.slab-ring-tube [data-l="halo"] { stroke-width: 4.5; opacity: 0.22; }
.slab-ring-tube [data-l="glass"] { stroke-width: 1.9; }
.slab-ring-tube [data-l="core"] { stroke-width: 0.7; }
.slab-ring-tube .slab-tube-gas { opacity: 0.3; }
.slab-panel[data-gas="off"] .slab-ring-tube .slab-tube-gas { visibility: hidden; }

/* The number is small glass close to the board: thinner tube, a lighter, shorter shadow. */
.slab-number-tube .slab-tube-cast { transform: translate(1px, 2px); opacity: 0.6; }
.slab-number-tube [data-l="frost"], .slab-number-tube [data-l="glass"] { stroke-width: 2.5; }
.slab-number-tube [data-l="dark"] { stroke-width: 2; }
.slab-number-tube [data-l="core"] { stroke-width: 1; }
.slab-number-tube [data-l="bloom"] { stroke-width: 9; }
`;
