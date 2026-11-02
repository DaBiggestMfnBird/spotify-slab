export const STYLE_ID = "slab-styles";

export const CSS = `
.slab-panel,
.slab-root {
  --slab-ink: #f7eef5;
  --slab-dim: #a896a4;
  --slab-candy: #ff2f6d;
  --slab-orange: #ff8a3d;
  --slab-gold: #f3c98b;
  --slab-line: rgba(255, 255, 255, 0.10);
  --slab-panel-w: 372px;
}

.slab-chip {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 0;
  padding: 0;
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--spice-subtext, #b3b3b3);
  cursor: pointer;
  position: relative;
  transition: background 120ms ease, color 120ms ease;
}
.slab-chip:hover { background: rgba(255, 255, 255, 0.08); color: var(--spice-text, #fff); }
.slab-chip:focus-visible { outline: 2px solid var(--slab-orange); outline-offset: 2px; }
.slab-chip[data-on="true"] {
  color: #fff;
  background: linear-gradient(180deg, rgba(255, 47, 109, 0.92), rgba(255, 138, 61, 0.72));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18), 0 2px 10px rgba(255, 47, 109, 0.35);
}

.slab-panel {
  position: fixed;
  z-index: 2147483000;
  width: var(--slab-panel-w);
  box-sizing: border-box;
  padding: 15px 15px 11px;
  border-radius: 18px;
  color: var(--slab-ink);
  background:
    radial-gradient(120% 80% at 100% 0%, rgba(255, 47, 109, 0.20), transparent 62%),
    radial-gradient(90% 70% at 0% 100%, rgba(255, 138, 61, 0.13), transparent 66%),
    linear-gradient(180deg, rgba(31, 17, 29, 0.97), rgba(13, 7, 13, 0.985));
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 26px 64px rgba(0, 0, 0, 0.58), inset 0 1px 0 rgba(255, 255, 255, 0.10);
  backdrop-filter: blur(26px) saturate(150%);
  -webkit-backdrop-filter: blur(26px) saturate(150%);
  font-family: ui-sans-serif, -apple-system, "Helvetica Neue", sans-serif;
  animation: slab-rise 150ms cubic-bezier(0.2, 0.9, 0.3, 1);
}
.slab-panel[hidden] { display: none; }

@keyframes slab-rise {
  from { opacity: 0; transform: translateY(6px) scale(0.99); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.slab-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.slab-mark {
  font-family: "Times New Roman", ui-serif, Georgia, serif;
  font-size: 25px;
  line-height: 1;
  font-weight: 700;
  letter-spacing: 0.20em;
  background: linear-gradient(180deg, #ffffff 0%, #ecdce9 36%, #8d7d8c 53%, #ffffff 76%, #b9a7b7 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  padding-right: 0.20em;
}
.slab-kicker {
  margin-top: 4px;
  font-size: 8.5px;
  letter-spacing: 0.30em;
  text-transform: uppercase;
  color: var(--slab-dim);
}

.slab-close {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--slab-dim);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.slab-close:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }

.slab-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 7px;
  font-size: 8.5px;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--slab-dim);
}
.slab-label::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--slab-line), transparent);
}

.slab-moods {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  margin-bottom: 13px;
}
.slab-mood {
  display: grid;
  gap: 5px;
  padding: 8px 9px 7px;
  border-radius: 11px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.045);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, transform 60ms ease;
}
.slab-mood:hover { background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.17); }
.slab-mood:active { transform: translateY(1px); }
.slab-mood[aria-pressed="true"] {
  border-color: rgba(255, 138, 61, 0.58);
  background: linear-gradient(180deg, rgba(255, 47, 109, 0.17), rgba(255, 138, 61, 0.07));
}
.slab-mood-name {
  font-size: 11.5px;
  font-weight: 650;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.slab-mood-sub {
  font-size: 8.5px;
  letter-spacing: 0.05em;
  color: var(--slab-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.slab-mood svg { display: block; width: 100%; height: 18px; overflow: visible; }
.slab-mood svg path { fill: none; stroke: rgba(255, 255, 255, 0.52); stroke-width: 1.6; stroke-linecap: round; }
.slab-mood[aria-pressed="true"] svg path { stroke: var(--slab-gold); }

.slab-tape {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 11px;
  margin-bottom: 12px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.30);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.slab-reel { width: 42px; height: 42px; flex: none; }
.slab-reel svg { width: 100%; height: 100%; animation: slab-spin 3.4s linear infinite; animation-play-state: paused; }
.slab-reel svg circle { stroke: rgba(255, 255, 255, 0.30); }
.slab-reel svg circle:nth-of-type(2) { stroke: rgba(255, 255, 255, 0.38); }
.slab-reel svg circle:nth-of-type(3) { fill: rgba(255, 255, 255, 0.62); }
.slab-reel svg path { stroke: rgba(255, 255, 255, 0.52); }
.slab-panel[data-playing="true"] .slab-reel svg { animation-play-state: running; }
@keyframes slab-spin { to { transform: rotate(360deg); } }

.slab-read { flex: 1; min-width: 0; }
.slab-bpm {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 19px;
  letter-spacing: 0.01em;
  line-height: 1.05;
}
.slab-bpm small {
  font-size: 8px;
  letter-spacing: 0.22em;
  color: var(--slab-dim);
  margin-left: 4px;
}
.slab-pos {
  margin-top: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9.5px;
  letter-spacing: 0.10em;
  color: var(--slab-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.slab-bars {
  margin-top: 5px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.09);
  overflow: hidden;
}
.slab-bars span {
  display: block;
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, var(--slab-candy), var(--slab-orange));
  transition: width 90ms linear;
}

.slab-pads {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
}
.slab-pad {
  height: 50px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 1px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0.028));
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 90ms ease, border-color 90ms ease, transform 50ms ease;
}
.slab-pad:hover { border-color: rgba(255, 255, 255, 0.28); }
.slab-pad:active,
.slab-pad[data-hit="true"] {
  transform: translateY(1px);
  border-color: rgba(255, 255, 255, 0.52);
  background: linear-gradient(180deg, rgba(255, 47, 109, 0.88), rgba(255, 138, 61, 0.52));
}
.slab-pad small {
  font-size: 7.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: none;
  color: rgba(255, 255, 255, 0.52);
}
.slab-pad:disabled { opacity: 0.35; cursor: not-allowed; }

.slab-auto {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 9px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.slab-auto-text { display: grid; gap: 1px; }
.slab-auto-title { font-size: 10px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; }
.slab-auto-sub { font-size: 8.5px; color: var(--slab-dim); }
.slab-switch {
  width: 38px;
  height: 21px;
  flex: none;
  border-radius: 11px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(0, 0, 0, 0.40);
  position: relative;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}
.slab-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.62);
  transition: transform 140ms cubic-bezier(0.3, 0.9, 0.3, 1), background 140ms ease;
}
.slab-switch[aria-checked="true"] {
  background: linear-gradient(90deg, rgba(255, 47, 109, 0.85), rgba(255, 138, 61, 0.85));
  border-color: rgba(255, 255, 255, 0.30);
}
.slab-switch[aria-checked="true"]::after { transform: translateX(17px); background: #fff; }

.slab-pitch {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 13px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: linear-gradient(180deg, rgba(255, 47, 109, 0.10), rgba(255, 138, 61, 0.04));
  transition: opacity 140ms ease;
}
.slab-pitch[data-enabled="false"] { opacity: 0.42; }
.slab-pitch-title {
  flex: none;
  font-size: 8.5px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--slab-dim);
}
.slab-pitch-range {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  min-width: 0;
  height: 14px;
  margin: 0;
  background: transparent;
  cursor: pointer;
}
.slab-pitch-range:disabled { cursor: not-allowed; }
.slab-pitch-range::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0.12));
}
.slab-pitch-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 13px;
  height: 13px;
  margin-top: -5px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.55);
  background: linear-gradient(180deg, var(--slab-candy), var(--slab-orange));
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.55);
}
.slab-pitch-range:focus-visible { outline: 2px solid var(--slab-orange); outline-offset: 3px; border-radius: 3px; }
.slab-pitch-value {
  flex: none;
  width: 46px;
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  letter-spacing: 0.02em;
  color: var(--slab-gold);
}

.slab-eq {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(255, 255, 255, 0.02);
  font-size: 8.5px;
  letter-spacing: 0.05em;
  color: var(--slab-dim);
}
.slab-eq[hidden] { display: none; }
.slab-eq-text { flex: 1; line-height: 1.35; }
.slab-eq-btn {
  flex: none;
  padding: 3px 7px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font: inherit;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.slab-eq-btn:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }

.slab-dsp {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(255, 255, 255, 0.02);
  font-size: 8.5px;
  letter-spacing: 0.05em;
  color: var(--slab-dim);
}.slab-dsp[data-linked="true"] {
  border-color: rgba(110, 231, 168, 0.28);
  background: rgba(110, 231, 168, 0.07);
  color: #b8f0d0;
}
.slab-dsp-dot {
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 50%;
  background: #7d6a72;
}
.slab-dsp[data-linked="true"] .slab-dsp-dot {
  background: #6ee7a8;
  box-shadow: 0 0 6px rgba(110, 231, 168, 0.7);
}
.slab-dsp-text { line-height: 1.35; }

.slab-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  font-size: 8.5px;
  letter-spacing: 0.07em;
  color: var(--slab-dim);
}
.slab-foot-right { display: flex; align-items: center; gap: 7px; }
.slab-lock { color: #e3a9bb; }
.slab-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--slab-dim);
}
.slab-dot[data-state="ok"] { background: #6ee7a8; box-shadow: 0 0 6px rgba(110, 231, 168, 0.6); }
.slab-dot[data-state="locked"] { background: #e3a9bb; }

.slab-activity {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 8.5px;
  color: var(--slab-gold);
  min-height: 11px;
  letter-spacing: 0.04em;
}

@media (prefers-reduced-motion: reduce) {
  .slab-panel { animation: none; }
  .slab-reel svg { animation: none; }
  .slab-bars span { transition: none; }
}
`;
