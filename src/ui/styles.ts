import { FONT_CSS } from "./fonts.generated";

export const STYLE_ID = "slab-styles";

export const CSS = `
${FONT_CSS}
.slab-panel {
  --wall: #FFF3E0;
  --wall-soft: #F2E6D2;
  --gas: #35DDF5;
  --gas-glass: #86F0FC;
  --gas-core: #EBFEFF;
  /* Fat rolls with soft seams. The light comes from above, across all of them. */
  --rolls: repeating-linear-gradient(90deg, #2C0D12 0, #43161C 5px, #4E1B22 11px, #43161C 17px, #2C0D12 22px);
  --press-light: linear-gradient(180deg, rgba(255, 232, 220, 0.13) 0, rgba(255, 232, 220, 0.02) 42%, rgba(0, 0, 0, 0.18) 100%);
  /* The same rolls with gas on them, mixed here because cyan over red turns grey. */
  --lit-rolls: repeating-linear-gradient(90deg, #0C4A59 0, #105F72 5px, #126F84 11px, #105F72 17px, #0C4A59 22px);
  --lit-edge: var(--gas);
  position: fixed;
  z-index: 2147483000;
  width: 400px;
  max-height: min(680px, calc(100vh - 16px));
  box-sizing: border-box;
  overflow: hidden auto;
  overscroll-behavior: contain;
  /* No scrollbar to take width from a fixed layout; the lips say when there is more. */
  scrollbar-width: none;
  border-radius: 50% 50% 12px 12px / 16px 16px 12px 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.62), 0 2px 0 rgba(0, 0, 0, 0.6);
  color: var(--wall);
  font: 500 13px/1.25 "SLAB Barlow", "Barlow Semi Condensed", "Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif;
  font-variant-numeric: tabular-nums;
  text-align: left;
  letter-spacing: 0;
  animation: slab-rise 150ms cubic-bezier(0.2, 0.9, 0.3, 1);
}
.slab-panel::-webkit-scrollbar { display: none; }
.slab-panel[hidden] { display: none; }
.slab-panel[data-gas="off"] { --lit-rolls: repeating-linear-gradient(90deg, #4A4A49 0, #585857 5px, #626261 11px, #585857 17px, #4A4A49 22px); --lit-edge: var(--wall); }
.slab-panel *, .slab-panel *::before, .slab-panel *::after { box-sizing: border-box; }
:where(.slab-panel) button {
  font: inherit;
  color: inherit;
  border: 0;
  margin: 0;
  padding: 0;
  background: none;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}
:where(.slab-panel) button:disabled,
:where(.slab-panel) button[aria-disabled="true"] { cursor: not-allowed; }
.slab-panel p { margin: 0; }
.slab-panel svg { display: block; }
.slab-panel button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 1px;
  box-shadow: 0 0 0 4px #000;
}
.slab-sr {
  position: absolute;
  left: 0;
  top: 0;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@keyframes slab-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Short windows only: a chrome lip and a fade on whichever edge hides something. */
.slab-lip {
  position: sticky;
  z-index: 3;
  height: 0;
  pointer-events: none;
}
.slab-lip::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 26px;
  opacity: 0;
}
.slab-lip-top { top: 0; }
.slab-lip-top::before {
  top: 0;
  border-top: 2px solid #D8DCDF;
  background: linear-gradient(180deg, rgba(12, 2, 5, 0.85), rgba(12, 2, 5, 0));
}
.slab-lip-end { bottom: 0; }
.slab-lip-end::before {
  bottom: 0;
  border-bottom: 2px solid #D8DCDF;
  background: linear-gradient(0deg, rgba(12, 2, 5, 0.85), rgba(12, 2, 5, 0));
}
.slab-panel[data-above="true"] .slab-lip-top::before,
.slab-panel[data-more="true"] .slab-lip-end::before { opacity: 1; }

/* Paint. Candy is a deep coat under a bright one, so colour alone does the depth:
   near-black wine where the body turns away, bright candy where the lid and the
   crease catch the light. There is no flake or noise, so type always sits on
   calm colour. */
.slab-body {
  position: relative;
  width: 400px;
  padding: 0 10px;
  border-radius: inherit;
  background:
    linear-gradient(90deg, rgba(18, 0, 5, 0.6) 0, rgba(18, 0, 5, 0) 16px, rgba(18, 0, 5, 0) calc(100% - 16px), rgba(18, 0, 5, 0.6) 100%),
    linear-gradient(180deg, #33040F 0, #8C0B25 5px, #CE1534 14px, #A30D29 28px, #6A0A1E 46px, #4C0616 74px, #470515 100%);
  box-shadow: inset 0 0 0 1px rgba(28, 0, 6, 0.55);
}
.slab-panel[data-primer="true"] .slab-body {
  background: #575654;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.3);
}
/* The body line. Same crease in candy and in primer; only candy catches light. */
.slab-lower {
  position: relative;
  margin: 8px -10px 0;
  padding: 0 10px;
  border-top: 1px solid rgba(20, 0, 5, 0.8);
  background:
    linear-gradient(90deg, rgba(18, 0, 5, 0.6) 0, rgba(18, 0, 5, 0) 16px, rgba(18, 0, 5, 0) calc(100% - 16px), rgba(18, 0, 5, 0.6) 100%),
    linear-gradient(180deg, #A60F2C 0, #BC1231 7px, #8E0C26 22px, #5E0819 44px, #450514 100%);
  box-shadow: inset 0 1px 0 rgba(255, 190, 190, 0.45);
}
.slab-panel[data-primer="true"] .slab-lower {
  background: #515050;
  border-top-color: rgba(0, 0, 0, 0.4);
  box-shadow: none;
}

/* Deck lid, with the badge mounted on it. */
.slab-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 8px 0 0 10px;
}
.slab-badge { flex: none; }
.slab-tag {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--wall-soft);
}
.slab-tag[data-flash="true"] { color: var(--wall); font-weight: 600; }
.slab-close {
  flex: none;
  width: 32px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 3px;
  color: var(--wall);
}
.slab-close:hover { background: rgba(30, 5, 10, 0.45); }

/* The trunk. */
.slab-trim {
  position: relative;
  padding: 3px;
  border-radius: 50% 50% 5px 5px / 10px 10px 5px 5px;
  background: linear-gradient(180deg, #F4F6F7 0, #AEB5BA 18%, #E9EDEF 40%, #7E858A 52%, #C3C9CD 72%, #8C9398 100%);
  box-shadow: 0 0 0 1px rgba(30, 0, 6, 0.8), 0 2px 3px 1px rgba(30, 0, 6, 0.7);
}
.slab-bay {
  position: relative;
  padding: 7px 7px 5px;
  overflow: hidden;
  border-radius: 50% 50% 3px 3px / 8px 8px 3px 3px;
  background:
    linear-gradient(180deg, rgba(0, 0, 0, 0.4) 0, rgba(0, 0, 0, 0.04) 26px, rgba(255, 226, 214, 0.05) 46%, rgba(0, 0, 0, 0.22) 100%),
    repeating-linear-gradient(90deg, #220A0D 0, #2F1014 7px, #3A1519 17px, #2F1014 27px, #220A0D 34px);
  box-shadow: 0 0 0 1px #120405;
}
/* The gas landing on the lining. Static, gone with the gas, and screened so it adds
   cyan light to the pleats instead of greying them. */
.slab-bay::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  mix-blend-mode: screen;
  background: radial-gradient(72% 36% at 50% 20%, rgba(0, 96, 124, 0.34) 0, rgba(0, 96, 124, 0.14) 60%, rgba(0, 96, 124, 0) 100%);
}
.slab-panel[data-gas="off"] .slab-bay::before { display: none; }
.slab-bay > * { position: relative; }

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

/* The sign stage holds its size in every state. */
.slab-stage { height: 88px; }
.slab-sign {
  position: absolute;
  left: 0;
  top: 0;
  width: 360px;
  height: 70px;
}
.slab-sub, .slab-dead {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  text-align: center;
  font-size: 13px;
  line-height: 18px;
}
.slab-sub { color: var(--wall-soft); }
/* Two lines at most, however long the device is called. */
.slab-dead {
  font-weight: 600;
  color: var(--wall);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.slab-dead:empty { display: none; }
.slab-panel[data-primer="true"] .slab-sub { visibility: hidden; }

/* Pitch. */
.slab-pitch-head {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 42px;
}
.slab-pitch-words {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.slab-pitch-label { font-weight: 700; font-size: 14px; line-height: 17px; }
.slab-semi { font-size: 12.5px; line-height: 16px; color: var(--wall-soft); white-space: nowrap; }
.slab-number-tube { flex: none; width: 118px; height: 42px; }
.slab-nudges { flex: none; display: flex; gap: 3px; margin-left: 8px; }

/* One press material: tuck and roll in the interior oxblood, on real travel. */
.slab-press {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--wall);
  background: var(--press-light), var(--rolls);
  box-shadow: inset 0 1px 0 rgba(255, 220, 220, 0.2), inset 0 -2px 3px rgba(0, 0, 0, 0.4), 0 2px 0 #0B0203, 0 3px 4px rgba(0, 0, 0, 0.5);
  transition: transform 70ms ease-out, box-shadow 70ms ease-out;
}
.slab-press > * { position: relative; z-index: 1; }
.slab-press::before,
.slab-press::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  opacity: 0;
  pointer-events: none;
}
/* Hover lifts the rolls a little; a hit lights them with the sign's gas. */
.slab-press::before {
  background: rgba(255, 243, 224, 0.08);
  transition: opacity 90ms ease-out;
}
.slab-press::after {
  background: var(--press-light), var(--lit-rolls);
  box-shadow: inset 0 0 0 1.5px var(--lit-edge);
  transition: opacity 160ms ease-out;
}
.slab-press:hover:not(:disabled):not([aria-disabled="true"])::before { opacity: 1; }
.slab-press:active:not(:disabled):not([aria-disabled="true"]),
.slab-press[data-hit="true"]:not(:disabled):not([aria-disabled="true"]) {
  transform: translateY(2px);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.7), 0 0 0 #0B0203;
}
.slab-press:active:not(:disabled):not([aria-disabled="true"])::after,
.slab-press[data-hit="true"]:not(:disabled):not([aria-disabled="true"])::after { opacity: 1; transition-duration: 0ms; }
.slab-press:disabled,
.slab-press[aria-disabled="true"] {
  background: #2A1B1D;
  color: #D6CCC2;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.5);
}

.slab-nudge { width: 42px; height: 36px; font-weight: 700; font-size: 13px; }

/* The rail. Height matches the wheel so nothing can overrun it. */
.slab-rail { position: relative; height: 61px; margin: 4px 0 0 7px; }
.slab-rail-tube,
.slab-rail-hot {
  position: absolute;
  top: 28px;
  height: 5px;
  pointer-events: none;
}
.slab-rail-tube {
  border-radius: 1px;
  background: linear-gradient(180deg, #1C8299 0, #2BA6BE 45%, #187689 100%);
  box-shadow: 0 0 2px rgba(53, 221, 245, 0.6), 0 0 6px rgba(53, 221, 245, 0.22), 0 5px 5px rgba(0, 0, 0, 0.5);
}
/* Electrode caps close the tube exactly at the scale ends. */
.slab-rail-tube::before,
.slab-rail-tube::after {
  content: "";
  position: absolute;
  top: -1px;
  width: 4px;
  height: 7px;
  border-radius: 1.5px;
  background: linear-gradient(180deg, #8E8A86, #2A2726);
}
.slab-rail-tube::before { left: -2px; }
.slab-rail-tube::after { right: -2px; }
.slab-rail-hot {
  background: #E2FCFF;
  box-shadow: 0 0 2px 1px var(--gas), 0 0 8px 2px rgba(53, 221, 245, 0.7), 0 0 20px 5px rgba(53, 221, 245, 0.28);
  transform: scaleX(0);
}
.slab-rail-hot-up { transform-origin: 0 50%; }
.slab-rail-hot-down { transform-origin: 100% 50%; }
.slab-panel[data-tube="idle"] .slab-rail-tube {
  background: linear-gradient(180deg, #4E7079, #6A8C95 45%, #41606A);
  box-shadow: 0 5px 5px rgba(0, 0, 0, 0.55);
}
.slab-panel[data-tube="idle"] .slab-rail-hot {
  background: linear-gradient(180deg, #9CC4CD, #BFDFE6);
  box-shadow: none;
}
.slab-panel[data-tube="off"] .slab-rail-tube {
  background: linear-gradient(180deg, #8F9495, #A9AEAF 45%, #777C7D);
  box-shadow: 0 5px 5px rgba(0, 0, 0, 0.6);
}
/* Dead glass still says how far from normal it is, just without any light. */
.slab-panel[data-tube="off"] .slab-rail-hot {
  background: linear-gradient(180deg, #F0F2F2, #D2D6D6);
  box-shadow: none;
}
.slab-clip {
  position: absolute;
  top: 25px;
  width: 5px;
  height: 11px;
  margin-left: -2.5px;
  border-radius: 1px;
  background: linear-gradient(180deg, #FBFCFC, #9AA1A6 45%, #6D7478 55%, #E9EDEF);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.8), 0 2px 2px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.slab-clip[data-lit="true"] {
  background: var(--gas-core);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.8), 0 0 5px 2px rgba(53, 221, 245, 0.85);
}
.slab-panel:not([data-tube="on"]) .slab-clip[data-lit="true"] {
  background: linear-gradient(180deg, #FBFCFC, #C6CCD0);
  box-shadow: 0 0 0 1px var(--wall);
}

/* The scale, in the band under the tyre, above the wheel in the stack. */
.slab-rail-marks {
  position: absolute;
  left: 0;
  right: 0;
  top: 50px;
  height: 11px;
  z-index: 1;
  pointer-events: none;
}
.slab-rail-ticks { position: absolute; left: 0; top: 0; }
.slab-rail-ticks rect { fill: var(--wall); opacity: 0.72; }
.slab-rail-line,
.slab-rail-run {
  position: absolute;
  top: 0;
  height: 2px;
}
.slab-rail-line { background: rgba(255, 243, 224, 0.3); }
.slab-rail-run {
  height: 3px;
  background: var(--gas-glass);
  box-shadow: 0 0 5px 1px rgba(53, 221, 245, 0.6);
  transform: scaleX(0);
}
.slab-panel[data-tube="idle"] .slab-rail-run { background: #9CC4CD; box-shadow: none; }
.slab-panel[data-tube="off"] .slab-rail-run { background: var(--wall); box-shadow: none; }
.slab-clip-foot {
  position: absolute;
  top: 0;
  width: 3px;
  height: 7px;
  margin-left: -1.5px;
  border-radius: 0 0 1px 1px;
  background: linear-gradient(90deg, #E9EDEF, #8F979C);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.7);
}
.slab-clip-foot[data-lit="true"] {
  width: 7px;
  height: 10px;
  margin-left: -3.5px;
  background: var(--gas-core);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.8), 0 0 6px 2px rgba(53, 221, 245, 0.8);
}
.slab-panel:not([data-tube="on"]) .slab-clip-foot[data-lit="true"] {
  background: var(--wall);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7);
}

.slab-range {
  position: absolute;
  top: 0;
  z-index: 2;
  height: 61px;
  margin: 0;
  padding: 0;
  background: transparent;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}
.slab-range:active { cursor: grabbing; }
.slab-range:disabled { cursor: not-allowed; }
.slab-range:focus { outline: 0; }
.slab-range::-webkit-slider-runnable-track { height: 61px; background: transparent; }
.slab-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 37px;
  height: 61px;
  background: transparent;
  cursor: grab;
}
.slab-range::-moz-range-track { height: 61px; background: transparent; }
.slab-range::-moz-range-thumb { width: 37px; height: 61px; background: transparent; border: 0; }

.slab-wheel,
.slab-roll,
.slab-spin {
  position: absolute;
  left: 0;
  top: 0;
  width: 57px;
  height: 57px;
  transform-origin: 28.5px 28.5px;
  pointer-events: none;
}
.slab-wheel { top: 2px; z-index: 1; }
/* Follows the tyre, not the pokes, so it can't reach the controls around the rail. */
.slab-range:focus-visible ~ .slab-wheel::after {
  content: "";
  position: absolute;
  left: 8px;
  top: 8px;
  width: 41px;
  height: 41px;
  border-radius: 50%;
  outline: 2px solid #fff;
  outline-offset: 0;
  box-shadow: 0 0 0 2px #000, inset 0 0 0 1px #000;
}
.slab-wheel-base, .slab-wheel-spin { position: absolute; left: 0; top: 0; }
.slab-rail[data-rolling="true"] .slab-wheel,
.slab-rail[data-rolling="true"] .slab-roll,
.slab-rail[data-rolling="true"] .slab-rail-hot,
.slab-rail[data-rolling="true"] .slab-rail-run {
  transition: transform 640ms cubic-bezier(0.3, 0.7, 0.2, 1);
}

.slab-scale { position: relative; height: 32px; margin-left: 7px; }
.slab-scale > * { position: absolute; top: 4px; transform: translateX(-50%); }
.slab-scale-end { font-size: 12px; line-height: 28px; font-weight: 600; white-space: nowrap; color: var(--wall-soft); }
.slab-normal { width: 58px; height: 28px; font-size: 12.5px; font-weight: 700; }
.slab-scale .slab-normal:active:not(:disabled):not([aria-disabled="true"]) { transform: translate(-50%, 2px); }

/* Moods, highest landing pitch first. Each is a door panel raised off the paint,
   with a pinstripe pulled around it and a short return at its leading edge. */
.slab-moods {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  margin-top: 8px;
}
.slab-mood {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 58px;
  grid-template-rows: 18px 16px;
  column-gap: 4px;
  align-items: center;
  height: 42px;
  padding: 4px 8px 4px 10px;
  text-align: left;
  border-radius: 4px;
  background: linear-gradient(180deg, #B4132F 0, #8E0E27 48%, #6F0A1F 100%);
  box-shadow: inset 0 1px 0 rgba(255, 214, 214, 0.5), 0 2px 0 #27040B, 0 3px 4px rgba(10, 0, 2, 0.5);
  transition: transform 70ms ease-out, box-shadow 70ms ease-out;
}
.slab-mood::before {
  content: "";
  position: absolute;
  inset: 2px;
  border: 1px solid rgba(255, 243, 224, 0.62);
  border-radius: 3px;
  pointer-events: none;
}
.slab-mood::after {
  content: "";
  position: absolute;
  left: 5px;
  top: 10px;
  bottom: 10px;
  width: 1px;
  background: rgba(255, 243, 224, 0.62);
  pointer-events: none;
}
.slab-mood:hover { background: linear-gradient(180deg, #C4163A 0, #9C102C 48%, #7A0C23 100%); }
.slab-mood:active {
  transform: translateY(2px);
  box-shadow: inset 0 1px 2px rgba(30, 0, 6, 0.6), 0 0 0 #27040B;
}
.slab-mood-name {
  grid-column: 1;
  grid-row: 1;
  font-weight: 700;
  font-size: 14px;
  line-height: 17px;
  white-space: nowrap;
}
.slab-mood-curve { grid-column: 2; grid-row: 1 / 3; overflow: visible; }
.slab-mood-zero { fill: none; stroke: currentColor; stroke-opacity: 0.3; stroke-width: 1; }
.slab-mood-line { fill: none; stroke: currentColor; stroke-width: 2.25; stroke-linecap: round; stroke-linejoin: round; }
.slab-mood-cents { grid-column: 1; grid-row: 2; font-size: 12.5px; line-height: 16px; font-weight: 700; }
.slab-mood[aria-checked="true"] {
  background: var(--press-light), var(--rolls);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.85), inset 0 0 0 1px rgba(0, 0, 0, 0.8), 0 1px 0 rgba(255, 214, 214, 0.32);
}
.slab-mood[aria-checked="true"]::after { display: none; }
.slab-panel[data-gas="on"] .slab-mood[aria-checked="true"]::before { border-color: var(--gas); }
.slab-panel[data-gas="on"] .slab-mood[aria-checked="true"] .slab-mood-line { stroke: var(--gas-glass); }
.slab-panel[data-primer="true"] .slab-mood:not([aria-checked="true"]) {
  background: #5D5C5A;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.35);
}
.slab-panel[data-primer="true"] .slab-mood:not([aria-checked="true"])::before,
.slab-panel[data-primer="true"] .slab-mood:not([aria-checked="true"])::after { display: none; }

/* Readout. */
.slab-read { position: relative; padding: 4px 10px 0; }
.slab-read-top {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 34px;
}
.slab-bpm { display: inline-flex; align-items: baseline; gap: 4px; min-width: 88px; white-space: nowrap; }
.slab-bpm b { font: 700 29px/34px "SLAB Barlow Tall", "Barlow Condensed", "SLAB Barlow", "Arial Narrow", sans-serif; }
.slab-bpm small { font-size: 12px; font-weight: 700; }
.slab-count { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.slab-bar { font-weight: 600; white-space: nowrap; }
.slab-lamps { display: inline-flex; gap: 3px; flex: none; }
.slab-lamps i {
  display: block;
  width: 9px;
  height: 13px;
  border-radius: 1px;
  background: rgba(255, 243, 224, 0.26);
}
.slab-lamps i[data-on="true"] { background: var(--wall); }
.slab-play {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 700;
  white-space: nowrap;
}
.slab-play::before {
  content: "";
  width: 9px;
  height: 11px;
  background: var(--wall);
  clip-path: polygon(0 12%, 34% 12%, 34% 88%, 0 88%, 0 12%, 66% 12%, 100% 12%, 100% 88%, 66% 88%, 66% 12%);
}
.slab-panel[data-playing="true"] .slab-play::before { clip-path: polygon(0 0, 100% 50%, 0 100%); }
.slab-ruler-slot { position: relative; height: 16px; }
.slab-ruler { position: absolute; left: 0; top: 1px; width: 360px; height: 14px; }
.slab-ruler svg { position: absolute; left: 0; top: 0; }
.slab-ruler-clip { position: absolute; inset: 0; clip-path: inset(0 100% 0 0); }
.slab-ruler path { fill: none; stroke-width: 1; shape-rendering: crispEdges; }
.slab-ruler-dim { stroke: rgba(255, 243, 224, 0.36); }
.slab-ruler-lit { stroke: var(--wall); }
.slab-nogrid {
  position: absolute;
  inset: 0;
  display: none;
  font-weight: 600;
  font-size: 13px;
  line-height: 16px;
}
.slab-panel[data-grid="false"] .slab-nogrid { display: block; }
.slab-panel[data-grid="false"] .slab-ruler { visibility: hidden; }

.slab-pads {
  position: relative;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
  margin-top: 6px;
}
.slab-pad { height: 54px; gap: 1px; }
.slab-pad b { font-weight: 700; font-size: 15.5px; line-height: 18px; }
.slab-pad small { font-size: 12px; line-height: 14px; font-weight: 500; }

.slab-auto {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 44px;
  padding-top: 2px;
}
.slab-switch {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  border-radius: 4px;
}
.slab-auto-title { font-weight: 700; font-size: 14px; }
.slab-switch-track {
  position: relative;
  display: block;
  width: 44px;
  height: 26px;
  border-radius: 4px;
  background: #16040A;
  box-shadow: inset 0 0 0 1px #E6D9C5, inset 0 2px 3px #000;
}
.slab-switch i {
  position: absolute;
  left: 4px;
  top: 4px;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  background: #A99C92;
  transition: transform 120ms ease-out;
}
.slab-switch[aria-checked="true"] i { transform: translateX(18px); background: var(--wall); }
.slab-stepper { display: flex; align-items: center; gap: 5px; }
.slab-every { min-width: 74px; text-align: center; font-weight: 600; white-space: nowrap; }
.slab-step { width: 34px; height: 30px; font-weight: 700; font-size: 16px; line-height: 1; }

/* The kick plate: brushed metal screwed to the door sill, chrome round its edge,
   with the status stamped straight into it. Paint can go to primer; this can't. */
.slab-sill {
  position: relative;
  margin: 0 -10px;
  height: 84px;
  border-radius: 0 0 12px 12px;
  background:
    repeating-linear-gradient(180deg, rgba(255, 255, 255, 0.025) 0, rgba(255, 255, 255, 0.025) 1px, rgba(0, 0, 0, 0.015) 1px, rgba(0, 0, 0, 0.015) 2px),
    linear-gradient(180deg, #9EA2A6 0, #93979B 40%, #888C90 100%);
  box-shadow:
    inset 0 2px 0 #F3F5F6,
    inset 0 3px 0 rgba(0, 0, 0, 0.3),
    inset 2px 0 0 rgba(255, 255, 255, 0.55),
    inset -2px 0 0 rgba(0, 0, 0, 0.26),
    inset 0 -2px 0 #6A6E72;
}
.slab-sill-screws { position: absolute; left: 0; top: 0; pointer-events: none; }
.slab-sill-plate {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  height: 84px;
  padding: 2px 20px;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 18px;
  color: #101114;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.24);
}
.slab-status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slab-status:empty { display: none; }
.slab-eq { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 30px; margin-bottom: 2px; flex: none; }
.slab-eq[hidden] { display: none; }
.slab-eq-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slab-eq-btn { flex: none; height: 26px; padding: 0 10px; font-size: 12.5px; font-weight: 700; white-space: nowrap; text-shadow: none; box-shadow: inset 0 1px 0 rgba(255, 220, 220, 0.2), 0 2px 0 #2B2D30; }

/* Playbar chip. Same footprint as the client's own buttons. */
.slab-chip {
  width: 32px;
  height: 32px;
  border: 0;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 4px;
  background: transparent;
  color: var(--spice-subtext, #b3b3b3);
  cursor: pointer;
}
.slab-chip:hover { color: var(--spice-text, #fff); transform: scale(1.06); }
.slab-chip:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.slab-chip[data-on="true"] { color: #35DDF5; }
.slab-chip[data-on="true"][data-remote="true"] { color: var(--spice-text, #fff); }
.slab-chip[aria-expanded="true"] { background: rgba(255, 255, 255, 0.1); }

@media (prefers-reduced-motion: reduce) {
  .slab-panel { animation: none; }
  .slab-press, .slab-press::before, .slab-press::after, .slab-mood, .slab-switch i { transition: none; }
  .slab-rail[data-rolling="true"] .slab-wheel,
  .slab-rail[data-rolling="true"] .slab-roll,
  .slab-rail[data-rolling="true"] .slab-rail-hot,
  .slab-rail[data-rolling="true"] .slab-rail-run { transition: none; }
}
`;
