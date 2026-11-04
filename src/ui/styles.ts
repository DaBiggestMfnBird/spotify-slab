import { FONT_CSS } from "./fonts.generated";
import { NEON_CSS } from "./neon-styles";

export const STYLE_ID = "slab-styles";

/*
 * The panel is a slab's popped trunk, so every material is one you could touch
 * on the car: candy paint over a deep coat, chrome trim, a vinyl-wrapped sign
 * board, tuck-and-roll presses in the interior oxblood, a stainless scuff plate,
 * whitewall text. The gas is the only light, and it only lights glass.
 *
 * Type: four sizes (12, 14, 16, 26) and three weights. 700 names things (moods,
 * pads, the BPM figure); 600 labels buttons; 500 is everything secondary.
 */
export const CSS = `
${FONT_CSS}
.slab-panel {
  /* Whitewall, and its softer second line. */
  --wall: #FFF3E0;
  --wall-soft: #EADCC6;
  /*
   * Gas: clear glass with argon and a drop of mercury, which burns blue. Neon
   * proper only makes reds and oranges, and cyan needs phosphor-coated tube.
   * Every use of the gas goes through these, so the sign, the number, the rail
   * tube and a lit press are always one gas.
   */
  --gas: #4D6BFF;
  --gas-glass: #9DB0FF;
  --gas-core: #F3F5FF;
  --gas-spill: color-mix(in srgb, var(--gas) 24%, transparent);
  /* Gold, for the Vogue line and the pinstripe. Never a state colour. */
  --gold: #D4A24C;
  --gold-bright: #F0C46A;
  position: fixed;
  z-index: 2147483000;
  width: 400px;
  max-height: min(680px, calc(100vh - 16px));
  box-sizing: border-box;
  overflow: hidden auto;
  overscroll-behavior: contain;
  scroll-padding-block: 30px 70px;
  /* No scrollbar to take width from a fixed layout; the lip and the pinned sill say when there is more. */
  scrollbar-width: none;
  /* A 77-92 GM deck lid: nearly flat, a shallow crown, tight corners. */
  border-radius: 50% 50% 10px 10px / 6px 6px 10px 10px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.62), 0 2px 0 rgba(0, 0, 0, 0.6);
  color: var(--wall);
  font: 500 12px/16px "SLAB Barlow", "Barlow Semi Condensed", "Bahnschrift SemiCondensed", "Bahnschrift", "Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif;
  font-variant-numeric: tabular-nums;
  text-align: left;
  letter-spacing: 0;
  animation: slab-rise 150ms cubic-bezier(0.2, 0.9, 0.3, 1);
}
.slab-panel::-webkit-scrollbar { display: none; }
.slab-panel[hidden] { display: none; }
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
:where(.slab-panel) button[aria-disabled="true"] { cursor: not-allowed; }
.slab-panel p { margin: 0; }
.slab-panel svg { display: block; }
/* An outline only, so a focused press keeps its bevel and a selected door its recess. */
.slab-panel button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
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

/* Short windows only: a chrome lip and a light fade on the top edge when something is hidden above. */
.slab-lip {
  position: sticky;
  top: 0;
  z-index: 3;
  height: 0;
  pointer-events: none;
}
.slab-lip::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 12px;
  border-top: 2px solid #D8DCDF;
  background: linear-gradient(180deg, rgba(12, 2, 5, 0.6), rgba(12, 2, 5, 0));
  opacity: 0;
}
.slab-panel[data-above="true"] .slab-lip::before { opacity: 1; }

/*
 * Paint. Candy is a deep coat under a bright one, so colour does the depth:
 * near-black wine where the body turns away, saturated red on the face, and
 * a warmer, hotter red only where the light rolls over the crown and the body
 * line. One light for the whole body; the doors and the lower panel share it.
 * The clear coat shows as sharp reflections, and only where there's no type.
 */
.slab-body {
  position: relative;
  width: 400px;
  padding: 0 10px;
  border-radius: inherit;
  background:
    linear-gradient(90deg, rgba(16, 0, 5, 0.72) 0, rgba(16, 0, 5, 0.32) 6px, rgba(16, 0, 5, 0) 14px, rgba(16, 0, 5, 0) calc(100% - 14px), rgba(16, 0, 5, 0.32) calc(100% - 6px), rgba(16, 0, 5, 0.72) 100%),
    radial-gradient(90% 18% at 50% 64%, rgba(200, 18, 42, 0.42), rgba(200, 18, 42, 0) 100%),
    linear-gradient(180deg, #E8202C 0, #B20E27 3px, #860A20 12px, #6E0719 30px, #640618 46%, #520514 74%, #3A030E 100%);
  box-shadow: inset 0 0 0 1px rgba(28, 0, 6, 0.55);
}
/* Clear coat over the crown, fading out before the corners. */
.slab-body::before {
  content: "";
  position: absolute;
  left: 9%;
  right: 9%;
  top: 2px;
  height: 8px;
  border-top: 1px solid rgba(255, 241, 238, 0.85);
  border-radius: 50% 50% 0 0 / 4px 4px 0 0;
  background: linear-gradient(180deg, rgba(255, 214, 206, 0.2), rgba(255, 214, 206, 0));
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 22%, #000 78%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 22%, #000 78%, transparent);
  pointer-events: none;
}
/* A streak down each side rail, where the body turns away. */
.slab-body::after {
  content: "";
  position: absolute;
  left: 4px;
  right: 4px;
  top: 48px;
  bottom: 96px;
  border-left: 1px solid rgba(255, 214, 206, 0.3);
  border-right: 1px solid rgba(255, 214, 206, 0.22);
  -webkit-mask-image: linear-gradient(180deg, transparent, #000 20%, #000 70%, transparent);
  mask-image: linear-gradient(180deg, transparent, #000 20%, #000 70%, transparent);
  pointer-events: none;
}
.slab-body > * { position: relative; }
/* Primer is the first coat of a candy job: flat, matte, nothing reflects. */
.slab-panel[data-primer="true"] .slab-body {
  background:
    linear-gradient(90deg, rgba(0, 0, 0, 0.28) 0, rgba(0, 0, 0, 0) 14px, rgba(0, 0, 0, 0) calc(100% - 14px), rgba(0, 0, 0, 0.28) 100%),
    #575654;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.3);
}
.slab-panel[data-primer="true"] .slab-body::before,
.slab-panel[data-primer="true"] .slab-body::after { display: none; }

/* The body line: a crease across the car, its edge catching the light. */
.slab-lower {
  margin: 8px -10px 0;
  padding: 0 10px;
}
.slab-lower::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 10px;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(18, 0, 5, 0.85) 0, rgba(18, 0, 5, 0.85) 1px, rgba(255, 170, 160, 0.55) 1px, rgba(255, 170, 160, 0.55) 2px, rgba(232, 32, 44, 0.34) 2px, rgba(232, 32, 44, 0) 10px);
}
.slab-panel[data-primer="true"] .slab-lower::before {
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.45) 0, rgba(0, 0, 0, 0.45) 1px, rgba(255, 255, 255, 0.1) 1px, rgba(255, 255, 255, 0.1) 2px, transparent 2px);
}

/* Deck lid, with the nameplate mounted on it. */
.slab-head {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 8px 0 0 14px;
}
.slab-badge { flex: none; display: block; }
.slab-tag {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--wall-soft);
}
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

/* The trunk: a chrome frame round a vinyl-wrapped board the glass is mounted on. */
.slab-trim {
  padding: 3px;
  border-radius: 6px;
  background: linear-gradient(180deg, #F4F6F7 0, #AEB5BA 18%, #E9EDEF 40%, #7E858A 52%, #C3C9CD 72%, #8C9398 100%);
  box-shadow: 0 0 0 1px rgba(30, 0, 6, 0.8), 0 2px 3px 1px rgba(30, 0, 6, 0.7);
}
.slab-bay {
  position: relative;
  padding: 8px 8px 6px;
  overflow: hidden;
  border-radius: 3px;
  background:
    radial-gradient(120% 70% at 50% 0%, rgba(255, 225, 215, 0.1), rgba(255, 225, 215, 0) 60%),
    linear-gradient(180deg, #2A0C10, #1E070A);
  /* The welt: piping sewn round the board's edge. */
  box-shadow: inset 0 0 0 4px #1A0609, inset 0 0 0 5px #3A1A1E, 0 0 0 1px #120405;
}
/* The gas landing on the vinyl, screened so it adds light instead of greying it. Gone with the gas. */
.slab-bay::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  mix-blend-mode: screen;
  background: radial-gradient(72% 36% at 50% 20%, var(--gas-spill) 0, color-mix(in srgb, var(--gas) 8%, transparent) 60%, transparent 100%);
}
.slab-panel[data-gas="off"] .slab-bay::before { display: none; }
.slab-bay > * { position: relative; }

${NEON_CSS}

/*
 * The sign stage holds its size in every state: the sign's board, then one line
 * of subtitle, in flow, so larger text spacing pushes the panel down rather than
 * pushing words into the glass. A two-line message gets the compact sign.
 */
.slab-stage { display: flex; flex-direction: column; min-height: 84px; }
.slab-sign {
  position: relative;
  flex: none;
  width: 360px;
  height: 66px;
}
.slab-panel[data-compact="true"] .slab-sign { height: 48px; }
.slab-sub, .slab-dead {
  text-align: center;
  line-height: 18px;
}
.slab-sub { color: var(--wall-soft); }
/* On the dead glass: where it's playing on one line (the name is cut short to fit), what that means on the next. */
.slab-dead {
  font-size: 14px;
  font-weight: 600;
  color: var(--wall);
}
.slab-dead[hidden] { display: none; }
.slab-dead-where, .slab-dead-why { display: block; }
/* The message takes the subtitle's line; with no message the line is the subtitle's. */
.slab-panel[data-primer="true"] .slab-sub { display: none; }
/* A short window gets the compact sign and one line under it. */
.slab-panel[data-short="true"] .slab-stage { min-height: 70px; }
.slab-panel[data-short="true"] .slab-sub { display: none; }
.slab-panel[data-short="true"] .slab-mood { min-height: 34px; grid-template-rows: minmax(26px, auto); }
.slab-panel[data-short="true"] .slab-mood-cents {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.slab-panel[data-short="true"] .slab-mood-curve { height: 26px; }
.slab-panel[data-short="true"] .slab-sill-plate { min-height: 20px; }

/* Pitch. */
.slab-pitch-head {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 42px;
  margin-top: 4px;
}
.slab-pitch-words {
  flex: 1;
  min-width: 0;
  padding-left: 3px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.slab-pitch-label { font-weight: 600; font-size: 14px; line-height: 17px; color: var(--wall-soft); }
.slab-semi { color: var(--wall-soft); }
.slab-number-tube { flex: none; width: 118px; height: 42px; }
.slab-nudges { flex: none; display: flex; gap: 4px; margin-left: 8px; }

/*
 * One press material: tuck and roll in the interior oxblood, on real travel.
 * Rolled horizontally: seam, lip, padded crest, fall-off into the next seam.
 * The gradients live here, on the press, because --roll is set per control so
 * the rolls divide it evenly and a seam never runs through a line of type: a
 * pad gets two rolls with the seam between its name and its sub-label, a small
 * button one. A hit lets the sign's gas catch the top of each roll; with the
 * gas out it catches plain light. Disabled rolls go dull and flat.
 */
.slab-press {
  --roll: 18px;
  --rolls: repeating-linear-gradient(180deg,
    #0D0304 0, #0D0304 1px, #6E3139 1px, #6A2D35 calc(var(--roll) * 0.22),
    #55232A calc(var(--roll) * 0.5), #3A151B calc(var(--roll) * 0.83),
    #22080C calc(var(--roll) * 0.94), #0D0304 var(--roll));
  --lit-rolls: repeating-linear-gradient(180deg,
    #0A0306 0, #0A0306 1px,
    color-mix(in srgb, var(--gas-glass) 72%, #4A1C22) 1px, color-mix(in srgb, var(--gas) 42%, #3A141A) calc(var(--roll) * 0.22),
    color-mix(in srgb, var(--gas) 12%, #2A0C11) calc(var(--roll) * 0.5), #1C070B calc(var(--roll) * 0.83),
    #130407 calc(var(--roll) * 0.94), #0A0306 var(--roll));
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--wall);
  background: var(--rolls);
  box-shadow: inset 0 1px 0 rgba(255, 220, 220, 0.2), inset 0 0 0 1px rgba(0, 0, 0, 0.35), 0 2px 0 #0B0203, 0 3px 4px rgba(0, 0, 0, 0.5);
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
.slab-press::before {
  background: rgba(255, 243, 224, 0.09);
  transition: opacity 90ms ease-out;
}
.slab-press::after {
  background: var(--lit-rolls);
  transition: opacity 160ms ease-out;
}
/* With the gas out there's no light to catch: a latched press reads as pushed in, with a whitewall edge. */
.slab-panel[data-gas="off"] .slab-press { --lit-rolls: repeating-linear-gradient(180deg,
    #0E0E0E 0, #0E0E0E 1px, #5A5A58 1px, #4A4A49 calc(var(--roll) * 0.22),
    #383837 calc(var(--roll) * 0.5), #2A2A29 calc(var(--roll) * 0.83),
    #1E1E1D calc(var(--roll) * 0.94), #0E0E0E var(--roll)); }
.slab-panel[data-gas="off"] .slab-press::after { box-shadow: inset 0 0 0 1px rgba(255, 243, 224, 0.7); }
/* Auto chop latched with no beat grid is waiting, not cutting: pushed in, unlit. */
.slab-panel[data-grid="false"] .slab-auto-press[aria-checked="true"]::after { opacity: 0; }
.slab-press:hover:not([aria-disabled="true"])::before { opacity: 1; }
.slab-press:active:not([aria-disabled="true"]),
.slab-press[data-hit="true"]:not([aria-disabled="true"]),
.slab-press[data-latched="true"],
.slab-auto-press[aria-checked="true"] {
  transform: translateY(2px);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.7), 0 0 0 #0B0203;
}
.slab-press:active:not([aria-disabled="true"])::after,
.slab-press[data-hit="true"]:not([aria-disabled="true"])::after,
.slab-press[data-latched="true"]::after,
.slab-auto-press[aria-checked="true"]::after { opacity: 1; transition-duration: 0ms; }
.slab-press[aria-disabled="true"] {
  filter: saturate(0.45) brightness(0.62);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35);
}

.slab-nudge { --roll: 36px; width: 42px; height: 36px; font-weight: 600; font-size: 14px; }

/* The rail. Its geometry comes from the wheel's own numbers, set on it in deck.ts. */
.slab-rail { position: relative; height: calc(var(--slab-wheel) + 10px); margin: 4px 0 0 7px; }
.slab-rail-tube,
.slab-rail-hot {
  position: absolute;
  top: calc(var(--slab-wheel) / 2 - 2.5px);
  height: 5px;
  pointer-events: none;
}
.slab-rail-tube {
  border-radius: 1px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--gas) 56%, #000) 0, var(--gas) 45%, color-mix(in srgb, var(--gas) 50%, #000) 100%);
  box-shadow: 0 0 2px color-mix(in srgb, var(--gas) 60%, transparent), 0 0 6px color-mix(in srgb, var(--gas) 24%, transparent), 0 5px 5px rgba(0, 0, 0, 0.5);
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
  background: var(--gas-core);
  box-shadow: 0 0 2px 1px var(--gas), 0 0 8px 2px color-mix(in srgb, var(--gas) 70%, transparent), 0 0 20px 5px color-mix(in srgb, var(--gas) 28%, transparent);
  transform: scaleX(0);
}
.slab-rail-hot-up { transform-origin: 0 50%; }
.slab-rail-hot-down { transform-origin: 100% 50%; }
.slab-panel[data-tube="idle"] .slab-rail-tube {
  background: linear-gradient(180deg, color-mix(in srgb, var(--gas) 28%, #3E4148), color-mix(in srgb, var(--gas) 28%, #5E6168) 45%, color-mix(in srgb, var(--gas) 28%, #34373D));
  box-shadow: 0 5px 5px rgba(0, 0, 0, 0.55);
}
.slab-panel[data-tube="idle"] .slab-rail-hot {
  background: linear-gradient(180deg, color-mix(in srgb, var(--gas-glass) 55%, #9A9EA6), color-mix(in srgb, var(--gas-glass) 55%, #C4C8CE));
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
/* Chrome clips holding the tube at each mood's cents. They reflect; they don't glow. */
.slab-clip {
  position: absolute;
  top: calc(var(--slab-wheel) / 2 - 5.5px);
  width: 5px;
  height: 11px;
  margin-left: -2.5px;
  border-radius: 1px;
  background: linear-gradient(180deg, #FBFCFC, #9AA1A6 45%, #6D7478 55%, #E9EDEF);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.8), 0 2px 2px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
.slab-clip[data-lit="true"] {
  background: linear-gradient(180deg, #FFFFFF, #E6E9EB 45%, #B9C0C5 55%, #FFFFFF);
  box-shadow: 0 0 0 1px var(--wall), 0 2px 2px rgba(0, 0, 0, 0.6);
}

/* The scale, in the band under the tyre, above the wheel in the stack. Flat marks, no glow. */
.slab-rail-marks {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(var(--slab-wheel) - 1px);
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
  background: var(--gas-glass);
  transform: scaleX(0);
}
.slab-panel[data-tube="idle"] .slab-rail-run { background: color-mix(in srgb, var(--gas-glass) 55%, #9A9EA6); }
.slab-panel[data-tube="off"] .slab-rail-run { background: var(--wall); }
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
  background: var(--wall);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.8);
}

.slab-range {
  position: absolute;
  top: 0;
  z-index: 2;
  height: 100%;
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
.slab-range::-webkit-slider-runnable-track { height: calc(var(--slab-wheel) + 10px); background: transparent; }
.slab-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: var(--slab-thumb, 47px);
  height: calc(var(--slab-wheel) + 10px);
  background: transparent;
  cursor: grab;
}
.slab-range::-moz-range-track { height: calc(var(--slab-wheel) + 10px); background: transparent; }
.slab-range::-moz-range-thumb { width: var(--slab-thumb, 47px); height: calc(var(--slab-wheel) + 10px); background: transparent; border: 0; }

.slab-wheel,
.slab-roll,
.slab-spin,
.slab-cone {
  position: absolute;
  left: 0;
  top: 0;
  width: var(--slab-wheel);
  height: var(--slab-wheel);
  transform-origin: calc(var(--slab-wheel) / 2) calc(var(--slab-wheel) / 2);
  pointer-events: none;
}
.slab-wheel { z-index: 1; }
.slab-wheel svg { position: absolute; left: 0; top: 0; }
/* The knock-off turns about the poke's tip, not the axle. */
.slab-roll.slab-knock, .slab-spin.slab-knock { transform-origin: var(--slab-poke); }
/* Thirty spokes on a 12° pitch strobe at speed; they fade and the knock-off carries the turn. */
.slab-wheel[data-spin="on"] .slab-roll:not(.slab-knock) { opacity: 0.65; }
.slab-wheel[data-spin="on"] .slab-roll.slab-knock { opacity: 0.8; }
.slab-range:disabled ~ .slab-wheel { filter: saturate(0.35) brightness(0.75); }
/* Spinning, the well behind the faded spokes reads as blurred chrome, not a dark turbine. */
.slab-wheel[data-spin="on"] .slab-well { fill: #5E666B; }
/* Follows the tyre, so it can't reach the controls around the rail. */
.slab-range:focus-visible ~ .slab-wheel::after {
  content: "";
  position: absolute;
  left: calc(var(--slab-wheel) / 2 - var(--slab-tyre) - 2px);
  top: calc(var(--slab-wheel) / 2 - var(--slab-tyre) - 2px);
  width: calc(var(--slab-tyre) * 2 + 4px);
  height: calc(var(--slab-tyre) * 2 + 4px);
  border-radius: 50%;
  outline: 2px solid #fff;
  outline-offset: 0;
  box-shadow: 0 0 0 2px #000, inset 0 0 0 1px #000;
}
.slab-rail[data-rolling="true"] .slab-wheel,
.slab-rail[data-rolling="true"] .slab-roll,
.slab-rail[data-rolling="true"] .slab-rail-hot,
.slab-rail[data-rolling="true"] .slab-rail-run {
  transition: transform 640ms cubic-bezier(0.3, 0.7, 0.2, 1);
}

.slab-scale { position: relative; height: 28px; margin-left: 7px; }
.slab-scale > * { position: absolute; top: 1px; transform: translateX(-50%); }
.slab-scale-end { line-height: 26px; white-space: nowrap; color: var(--wall-soft); }
/* Two pixels of board between the key and the welt, so its shadow never lands on the piping. */
.slab-normal { --roll: 26px; width: 58px; height: 26px; font-weight: 600; }
.slab-scale .slab-normal:active:not([aria-disabled="true"]) { transform: translate(-50%, 2px); }

/*
 * Moods, highest landing pitch first. Each is a door cut from the body: the
 * same paint, a seam round it, and a pinstripe pulled by hand along its top
 * and down its leading edge. The picked one sits recessed in the vinyl.
 */
.slab-moods {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  margin-top: 8px;
}
.slab-mood {
  --stripe: var(--gold);
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 58px;
  grid-template-rows: minmax(18px, auto) minmax(16px, auto);
  column-gap: 6px;
  align-items: center;
  min-height: 42px;
  padding: 4px 8px 4px 14px;
  text-align: left;
  border-radius: 4px;
  background: rgba(255, 210, 210, 0.04);
  box-shadow: inset 0 0 0 1px rgba(20, 0, 5, 0.85), inset 0 1px 0 rgba(255, 200, 205, 0.28), inset 0 -1px 0 rgba(0, 0, 0, 0.25);
  transition: transform 70ms ease-out;
}
.slab-stripe { position: absolute; left: 0; top: 0; color: var(--stripe); pointer-events: none; }
.slab-mood:hover { --stripe: var(--gold-bright); background: rgba(255, 210, 210, 0.08); transform: translateY(-1px); }
.slab-mood:active { transform: translateY(1px); }
.slab-mood-name {
  grid-column: 1;
  grid-row: 1;
  font-weight: 700;
  font-size: 14px;
  line-height: 17px;
  /* Wider text spacing wraps a long name onto a second line; it's never cut. */
  overflow-wrap: anywhere;
}
.slab-mood-curve { grid-column: 2; grid-row: 1 / 3; overflow: visible; color: var(--wall-soft); }
.slab-mood-zero { fill: none; stroke: currentColor; stroke-opacity: 0.3; stroke-width: 1; }
.slab-mood-line { fill: none; stroke: currentColor; stroke-width: 2.25; stroke-linecap: round; stroke-linejoin: round; }
.slab-mood-cents { grid-column: 1; grid-row: 2; color: var(--wall-soft); }
.slab-mood[aria-checked="true"] {
  --stripe: var(--wall);
  background: linear-gradient(180deg, #1E070A, #2A0C10);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.85), inset 0 0 0 1px rgba(0, 0, 0, 0.8), 0 1px 0 rgba(255, 214, 214, 0.25);
  transform: none;
}
.slab-mood[aria-checked="true"] .slab-mood-curve { color: var(--wall); }
/* A curve SLAB isn't allowed to apply (ModernEQ has the EQ, or there's no EQ) is only sketched. */
.slab-panel[data-eq="other"] .slab-mood[aria-checked="true"] .slab-mood-line { stroke-dasharray: 3 3; }
.slab-panel[data-primer="true"] .slab-mood:not([aria-checked="true"]) { background: rgba(255, 255, 255, 0.03); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.1); }
.slab-panel[data-primer="true"] .slab-stripe { display: none; }

/* Readout: two columns, on the same lines as the doors above. */
.slab-read { padding-top: 8px; }
.slab-read-top {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 4px;
  align-items: center;
  height: 32px;
  padding-right: 10px;
}
.slab-bpm { display: inline-flex; align-items: baseline; gap: 4px; padding-left: 14px; white-space: nowrap; }
.slab-bpm b { font: 700 26px/32px "SLAB Barlow Tall", "Barlow Condensed", "SLAB Barlow", "Bahnschrift Condensed", "Arial Narrow", sans-serif; }
.slab-bpm small { font-size: 12px; font-weight: 500; }
.slab-count { display: flex; align-items: center; gap: 8px; min-width: 0; padding-left: 14px; }
.slab-bar { white-space: nowrap; }
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
  white-space: nowrap;
}
.slab-play::before {
  content: "";
  width: 8px;
  height: 10px;
  background: var(--wall);
  clip-path: polygon(0 0, 34% 0, 34% 100%, 0 100%, 0 0, 66% 0, 100% 0, 100% 100%, 66% 100%, 66% 0);
}
.slab-panel[data-playing="true"] .slab-play { visibility: hidden; }
.slab-ruler-slot { position: relative; height: 16px; margin-top: 2px; }
.slab-ruler { position: absolute; left: 10px; top: 1px; width: 360px; height: 14px; }
.slab-ruler svg { position: absolute; left: 0; top: 0; }
.slab-ruler-clip { position: absolute; inset: 0; clip-path: inset(0 100% 0 0); }
.slab-ruler path { fill: none; stroke-width: 1; shape-rendering: crispEdges; }
.slab-ruler-dim { stroke: rgba(255, 243, 224, 0.36); }
.slab-ruler-lit { stroke: var(--wall); }
.slab-nogrid,
.slab-flash {
  position: absolute;
  /* On the readout's text line, with the BPM above it. */
  inset: 0 10px 0 14px;
  display: none;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.slab-nogrid { color: var(--wall-soft); }
.slab-flash { font-weight: 600; color: var(--wall); }
.slab-panel[data-grid="false"] .slab-nogrid { display: block; }
.slab-panel[data-grid="false"] .slab-ruler { visibility: hidden; }
/* A press's answer takes the ruler's place for a moment. */
.slab-panel[data-flash="true"] .slab-flash { display: block; }
.slab-panel[data-flash="true"] .slab-ruler,
.slab-panel[data-flash="true"] .slab-nogrid { visibility: hidden; }

/* Five pads; Stop, the one that halts the record, sits a hand's width apart. */
.slab-pads {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr)) 4px minmax(0, 1fr);
  gap: 4px;
  margin-top: 8px;
}
.slab-pad { --roll: 27px; height: 54px; gap: 1px; }
.slab-pad[data-pad="stop"] { grid-column: 6; }
.slab-pad b { font-weight: 700; font-size: 16px; line-height: 18px; }
.slab-pad small { font-size: 12px; line-height: 14px; color: var(--wall-soft); }
/* The number key that plays it, small in the corner like a pad number on a sampler. */
.slab-key {
  position: absolute;
  left: 6px;
  top: 3px;
  font-style: normal;
  font-weight: 600;
  line-height: 14px;
  color: var(--wall-soft);
}

.slab-auto {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 44px;
  padding-top: 4px;
}
.slab-auto-press { --roll: 30px; min-width: 104px; height: 30px; padding: 0 14px; flex-direction: row; font-weight: 600; font-size: 14px; }
.slab-auto-on { display: none; }
.slab-auto-press[aria-checked="true"] .slab-auto-on { display: inline; }
.slab-stepper { display: flex; align-items: center; gap: 6px; }
.slab-every { width: 150px; text-align: center; white-space: nowrap; color: var(--wall-soft); }
.slab-panel[data-auto="on"] .slab-every { color: var(--wall); }
.slab-step { --roll: 30px; width: 34px; height: 30px; font-weight: 600; font-size: 16px; line-height: 1; }

/*
 * The scuff plate: stainless, ribbed along its length at top and bottom, a
 * Phillips head at each end, the status stamped into the smooth field between.
 * Paint can go to primer; this can't. In a short window it stays pinned to the
 * bottom edge and the car scrolls behind it.
 */
.slab-sill {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  margin: 0 -10px;
  padding: 13px 18px 12px;
  border-radius: 0 0 10px 10px;
  background:
    repeating-linear-gradient(180deg, #F2F4F5 0, #F2F4F5 1px, #5C6064 1px, #5C6064 2px, rgba(0, 0, 0, 0) 2px, rgba(0, 0, 0, 0) 3px) left 0 top 4px / 100% 9px no-repeat,
    repeating-linear-gradient(180deg, #F2F4F5 0, #F2F4F5 1px, #5C6064 1px, #5C6064 2px, rgba(0, 0, 0, 0) 2px, rgba(0, 0, 0, 0) 3px) left 0 bottom 3px / 100% 9px no-repeat,
    linear-gradient(180deg, #7B8187 0, #A3A8AC 45%, #6F757B 100%);
  box-shadow: inset 0 2px 0 #E4E7E9, inset 0 3px 0 rgba(0, 0, 0, 0.3), inset 0 -2px 0 #565C60;
}

/* When the car runs on behind the pinned plate, its edge fades into it. */
.slab-panel[data-more="true"] .slab-sill::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  height: 12px;
  background: linear-gradient(0deg, rgba(12, 2, 5, 0.6), rgba(12, 2, 5, 0));
  pointer-events: none;
}
.slab-screw-at { position: absolute; top: 50%; margin-top: -4px; }
.slab-screw-left { left: 5px; }
.slab-screw-right { right: 5px; }
/* Room for two lines in every state, so the panel never changes height when a second line comes or goes. */
.slab-sill-plate {
  flex: 1;
  min-width: 0;
  min-height: 38px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  padding: 3px 6px;
  border-radius: 2px;
  background: linear-gradient(180deg, #90969A, #9DA2A6);
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.35), inset 0 -1px 0 rgba(255, 255, 255, 0.35);
  font-weight: 600;
  color: #101114;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.3);
}
/* With ModernEQ the plate keeps room for its row as well, again in every state. */
.slab-sill[data-eq="on"] .slab-sill-plate { min-height: 62px; }
/* Status wraps rather than being cut off; the plate grows to hold it. */
.slab-status { overflow-wrap: anywhere; }
.slab-status:empty { display: none; }
.slab-eq { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 22px; flex: none; }
.slab-eq[hidden] { display: none; }
.slab-eq-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* A stamped metal key on the metal plate, not upholstery bolted to it. */
.slab-press.slab-eq-btn {
  flex: none;
  height: 22px;
  padding: 0 10px;
  border-radius: 3px;
  font-weight: 600;
  white-space: nowrap;
  color: #101114;
  text-shadow: none;
  background: linear-gradient(180deg, #E8EBED, #B4B9BD);
  box-shadow: inset 0 1px 0 #FFFFFF, inset 0 0 0 1px rgba(0, 0, 0, 0.25), 0 1px 0 #5C6064, 0 2px 2px rgba(0, 0, 0, 0.25);
}
.slab-press.slab-eq-btn::after { display: none; }
/* On the bright stainless a white ring vanishes; the plate gets a dark one. */
.slab-sill button:focus-visible { outline-color: #101114; }

/* Playbar chip. Same footprint as the client's own buttons, and its own active dot when on. */
.slab-chip {
  position: relative;
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
.slab-chip .slab-chip-vogue { display: none; }
.slab-chip[data-on="true"] { color: var(--spice-text, #fff); }
.slab-chip[data-on="true"] .slab-chip-vogue { display: inline; }
.slab-chip[data-on="true"] .slab-chip-plain { display: none; }
.slab-chip[data-on="true"] .slab-chip-tyre { stroke: #6E6E6E; }
.slab-chip[data-on="true"]::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: 1px;
  width: 4px;
  height: 4px;
  margin-left: -2px;
  border-radius: 50%;
  background: currentColor;
}
.slab-chip[aria-expanded="true"] { background: rgba(255, 255, 255, 0.1); }

@media (prefers-reduced-motion: reduce) {
  .slab-panel { animation: none; }
  .slab-press, .slab-press::before, .slab-press::after, .slab-mood { transition: none; }
  .slab-mood:hover { transform: none; }
  .slab-rail[data-rolling="true"] .slab-wheel,
  .slab-rail[data-rolling="true"] .slab-roll,
  .slab-rail[data-rolling="true"] .slab-rail-hot,
  .slab-rail[data-rolling="true"] .slab-rail-run { transition: none; }
}

/*
 * An engine without color-mix() would drop every gas mix: the lit tube would
 * vanish and hits would lose their light. These are the same mixes worked out
 * for the default argon, as plain colours.
 */
@supports not (color: color-mix(in srgb, red 50%, blue)) {
  .slab-panel { --gas-spill: rgba(62, 88, 255, 0.24); }
  .slab-press { --lit-rolls: repeating-linear-gradient(180deg,
    #0A0306 0, #0A0306 1px, #8D93D0 1px, #403E8A calc(var(--roll) * 0.22),
    #2F1730 calc(var(--roll) * 0.5), #1C070B calc(var(--roll) * 0.83),
    #130407 calc(var(--roll) * 0.94), #0A0306 var(--roll)); }
  .slab-bay::before { background: radial-gradient(72% 36% at 50% 20%, rgba(62, 88, 255, 0.24) 0, rgba(62, 88, 255, 0.08) 60%, rgba(62, 88, 255, 0) 100%); }
  .slab-rail-tube {
    background: linear-gradient(180deg, #2B3C8F 0, #4D6BFF 45%, #263680 100%);
    box-shadow: 0 0 2px rgba(77, 107, 255, 0.6), 0 0 6px rgba(77, 107, 255, 0.24), 0 5px 5px rgba(0, 0, 0, 0.5);
  }
  .slab-rail-hot { box-shadow: 0 0 2px 1px #4D6BFF, 0 0 8px 2px rgba(77, 107, 255, 0.7), 0 0 20px 5px rgba(77, 107, 255, 0.28); }
  .slab-panel[data-tube="idle"] .slab-rail-tube { background: linear-gradient(180deg, #424D7B, #596492 45%, #3B4673); }
  .slab-panel[data-tube="idle"] .slab-rail-hot { background: linear-gradient(180deg, #9CA8D7, #AFBBE9); }
  .slab-panel[data-tube="idle"] .slab-rail-run { background: #9CA8D7; }
}

/* Windows High Contrast and other forced palettes: state by outline, never by paint. */
@media (forced-colors: active) {
  .slab-press, .slab-mood { border: 1px solid ButtonText; }
  .slab-press[data-hit="true"], .slab-press[data-latched="true"], .slab-auto-press[aria-checked="true"], .slab-mood[aria-checked="true"] {
    outline: 3px solid Highlight;
    outline-offset: -3px;
  }
  .slab-press[aria-disabled="true"] { color: GrayText; border-color: GrayText; }
  .slab-lamps i { border: 1px solid CanvasText; }
  .slab-lamps i[data-on="true"] { background: Highlight; }
  .slab-rail-tube { background: CanvasText; }
  .slab-rail-hot, .slab-rail-run { background: Highlight; }
  .slab-panel .slab-stripe { display: none; }
  /* Neon becomes plain system-coloured line work: no glow, no shadow, readable on any palette. */
  .slab-tube [data-l="glass"], .slab-tube [data-l="core"], .slab-tube [data-l="frost"], .slab-tube [data-l="frostHi"] { stroke: CanvasText; }
  .slab-tube [data-l="bloom"], .slab-tube [data-l="halo"], .slab-tube-cast, .slab-tube [data-l="dark"] { display: none; }
}
`;
