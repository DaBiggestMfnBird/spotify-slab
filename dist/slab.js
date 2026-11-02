/* SLAB — Third Coast playback moods */
"use strict";
(() => {
  // src/core/clock.ts
  var subscribers = /* @__PURE__ */ new Set();
  var worker = null;
  var objectUrl = null;
  var SOURCE = `
let id = null;
self.onmessage = (event) => {
  if (event.data === "start") {
    if (id === null) id = setInterval(() => self.postMessage(Date.now()), 40);
  } else if (event.data === "stop") {
    if (id !== null) { clearInterval(id); id = null; }
  }
};
`;
  function boot() {
    if (worker) return;
    try {
      objectUrl = URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" }));
      worker = new Worker(objectUrl);
      worker.onmessage = (event) => {
        const now = typeof event.data === "number" ? event.data : Date.now();
        for (const tick of subscribers) {
          try {
            tick(now);
          } catch {
          }
        }
      };
      worker.postMessage("start");
    } catch {
      worker = null;
    }
  }
  function subscribe(tick) {
    boot();
    const wasIdle = subscribers.size === 0;
    subscribers.add(tick);
    if (wasIdle && worker) worker.postMessage("start");
    return () => {
      subscribers.delete(tick);
      if (subscribers.size === 0 && worker) worker.postMessage("stop");
    };
  }
  function disposeClock() {
    subscribers.clear();
    if (worker) {
      worker.postMessage("stop");
      worker.terminate();
      worker = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  // src/core/grid.ts
  var cache = /* @__PURE__ */ new Map();
  var inflight = /* @__PURE__ */ new Map();
  function currentUri() {
    return Spicetify.Player.data?.item?.uri ?? null;
  }
  async function loadGrid(uri) {
    const target = uri ?? currentUri();
    if (!target) return null;
    if (!target.startsWith("spotify:track:")) return null;
    const cached = cache.get(target);
    if (cached) return cached;
    const running = inflight.get(target);
    if (running) return running;
    const request2 = (async () => {
      try {
        const analysis = await Spicetify.getAudioData(target);
        const beats = (analysis.beats ?? []).map((beat) => beat.start * 1e3);
        const bars = (analysis.bars ?? []).map((bar) => bar.start * 1e3);
        if (beats.length < 2 || bars.length < 2) return null;
        const durationMs = (analysis.track?.duration ?? 0) * 1e3 || Spicetify.Player.getDuration() || bars[bars.length - 1] + 4e3;
        const grid = {
          uri: target,
          tempo: analysis.track?.tempo ?? 0,
          timeSignature: analysis.track?.time_signature ?? 4,
          beats,
          bars,
          durationMs
        };
        cache.set(target, grid);
        return grid;
      } catch {
        return null;
      } finally {
        inflight.delete(target);
      }
    })();
    inflight.set(target, request2);
    return request2;
  }
  function gridFor(uri) {
    const target = uri ?? currentUri();
    return target ? cache.get(target) ?? null : null;
  }
  function indexAt(markers, ms) {
    let low = 0;
    let high = markers.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = low + high >> 1;
      if (markers[mid] <= ms) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }
  function barIndexAt(grid, ms) {
    return indexAt(grid.bars, ms);
  }
  function barStartMs(grid, index) {
    const clamped = Math.max(0, Math.min(grid.bars.length - 1, index));
    return grid.bars[clamped];
  }
  function beatIndexAt(grid, ms) {
    return indexAt(grid.beats, ms);
  }
  function barLengthMs(grid, index) {
    const start = barStartMs(grid, index);
    const next = grid.bars[index + 1];
    return next !== void 0 ? next - start : 2e3;
  }
  function barCount(grid) {
    return grid.bars.length;
  }

  // src/core/chops.ts
  var listener = null;
  var busy = false;
  var autoUnsub = null;
  var autoEvery = 4;
  var autoLastBar = -1;
  var autoCounter = 0;
  var autoCooldownUntil = 0;
  var loopUnsub = null;
  function onChop(fn) {
    listener = fn;
  }
  function emit(kind, label) {
    listener?.({ kind, label });
  }
  async function ensureGrid() {
    return gridFor() ?? await loadGrid();
  }
  function seek(ms) {
    try {
      Spicetify.Player.seek(Math.max(0, Math.round(ms)));
    } catch {
    }
  }
  async function chopBars(bars) {
    if (busy) return false;
    busy = true;
    try {
      const grid = await ensureGrid();
      if (!grid) return false;
      const now = Spicetify.Player.getProgress();
      const index = barIndexAt(grid, now);
      const from = index < 0 ? 0 : index;
      const span = Math.max(1, Math.round(bars));
      let target = barStartMs(grid, from - (span - 1));
      if (now - target < 250) target = barStartMs(grid, from - span);
      if (now - target < 250) return false;
      seek(target);
      emit(span >= 4 ? "spin" : "chop", `\u2212${span} bar${span === 1 ? "" : "s"}`);
      return true;
    } finally {
      busy = false;
    }
  }
  function cancelLoop() {
    loopUnsub?.();
    loopUnsub = null;
  }
  async function loopBars(times = 4) {
    const grid = await ensureGrid();
    if (!grid) return false;
    cancelLoop();
    const index = Math.max(0, barIndexAt(grid, Spicetify.Player.getProgress()));
    const start = barStartMs(grid, index);
    const length = barLengthMs(grid, index);
    if (length < 300) return false;
    const total = Math.max(1, Math.round(times));
    let remaining = total;
    let due = Date.now() + length;
    loopUnsub = subscribe(() => {
      if (!Spicetify.Player.isPlaying()) {
        cancelLoop();
        return;
      }
      if (Date.now() < due) return;
      seek(start);
      remaining -= 1;
      due += length;
      if (remaining <= 0) {
        cancelLoop();
        emit("loop", `${total} bars`);
      }
    });
    emit("loop", `${total} bars`);
    return true;
  }
  async function tapeStop(options = {}) {
    if (!Spicetify.Player.isPlaying()) {
      emit("stop", "already stopped");
      return false;
    }
    const fade = options.fade !== false;
    const startVolume = Spicetify.Player.getVolume();
    const duration = fade ? 420 : Math.max(0, options.pauseDelayMs ?? 0);
    const origin = Date.now();
    await new Promise((resolve) => {
      const unsub = subscribe(() => {
        const progress = duration === 0 ? 1 : Math.min(1, (Date.now() - origin) / duration);
        if (fade) {
          try {
            Spicetify.Player.setVolume(startVolume * Math.pow(1 - progress, 1.8));
          } catch {
          }
        }
        if (progress >= 1) {
          unsub();
          resolve();
        }
      });
    });
    try {
      Spicetify.Player.pause();
    } catch {
    }
    try {
      Spicetify.Player.setVolume(startVolume);
    } catch {
    }
    emit("stop", "tape stopped");
    return true;
  }
  function setAuto(enabled, every = 4) {
    autoEvery = Math.max(1, Math.min(16, Math.round(every)));
    if (!enabled) {
      stopAuto();
      return;
    }
    startAuto();
  }
  function startAuto() {
    stopAuto();
    autoLastBar = -1;
    autoCounter = 0;
    autoCooldownUntil = 0;
    autoUnsub = subscribe(() => {
      if (busy) return;
      if (!Spicetify.Player.isPlaying()) return;
      const grid = gridFor();
      if (!grid) return;
      const index = barIndexAt(grid, Spicetify.Player.getProgress());
      if (index < 0) return;
      if (index === autoLastBar) return;
      autoLastBar = index;
      if (Date.now() < autoCooldownUntil) return;
      autoCounter += 1;
      if (autoCounter < autoEvery) return;
      autoCounter = 0;
      autoCooldownUntil = Date.now() + 900;
      void chopBars(1).then((did) => {
        if (did) emit("auto", `auto \xB7 ${autoEvery} bars`);
      });
    });
  }
  function stopAuto() {
    autoUnsub?.();
    autoUnsub = null;
    autoLastBar = -1;
    autoCounter = 0;
    autoCooldownUntil = 0;
  }
  function resetForTrack() {
    cancelLoop();
    autoLastBar = -1;
    autoCounter = 0;
    autoCooldownUntil = 0;
  }
  function disposeChops() {
    stopAuto();
    cancelLoop();
    listener = null;
  }

  // src/core/moods.ts
  var BANDS = [60, 150, 400, 1e3, 2400, 15e3];
  var dry = {
    pitch: 0,
    reverb: 0,
    reverbPreset: "largeHall2",
    delayTime: 0.36,
    delayFeedback: 0,
    delayMix: 0,
    lowpass: 2e4,
    gain: 0
  };
  var MOODS = [
    {
      id: "slowed",
      name: "Slowed + Reverb",
      sub: "tape drowned in the room",
      gains: [3.5, 2, 0.8, -0.6, -2.6, -4.2],
      dsp: { ...dry, pitch: -320, reverb: 34, reverbPreset: "largeHall2", lowpass: 11e3 },
      note: "The highs come off first when a record is dragged. Presence drops, the low-mids swell, the top turns to air, and the helper adds the room."
    },
    {
      id: "screwed",
      name: "Houston Screwed",
      sub: "slowed, not chopped",
      gains: [5, 3.2, 0.4, -1.2, -3, -6],
      dsp: { ...dry, pitch: -560, reverb: 16, reverbPreset: "largeRoom", lowpass: 8e3 },
      note: "Screw mixed for a trunk. Sub and low-mid pushed hard, everything above 2k pulled back so the 808 owns the room."
    },
    {
      id: "chopped",
      name: "Houston Chopped",
      sub: "dry, bright, cuts",
      gains: [2.2, 1, -0.2, 1.4, 3, 1.2],
      dsp: { ...dry, reverbPreset: "smallRoom" },
      note: "Chopped records stay dry and forward. The cut has to land, so the presence band comes up instead of down."
    },
    {
      id: "memphis",
      name: "Memphis Tape",
      sub: "midrange honk, hiss on top",
      gains: [1.4, 0.8, 3, 2.2, -1, -5],
      dsp: { ...dry, pitch: -160, reverb: 10, reverbPreset: "plate", lowpass: 6500 },
      note: "Cassette dub: 400-1k pushed until it honks, top rolled off, bottom kept loose."
    },
    {
      id: "sped",
      name: "Sped Up",
      sub: "nightcore bright, lean low end",
      gains: [-1.2, -0.2, -0.6, 1, 2.4, 3.6],
      dsp: { ...dry, pitch: 400 },
      note: "The other direction. Low end leans out, presence and air come up, the whole thing gets lighter."
    },
    {
      id: "flat",
      name: "Flat",
      sub: "back to your own curve",
      gains: [0, 0, 0, 0, 0, 0],
      dsp: { ...dry },
      note: "Returns every filter to the gains it had when SLAB loaded, and the helper to dry."
    }
  ];
  function moodById(id) {
    return MOODS.find((mood) => mood.id === id) ?? MOODS[MOODS.length - 1];
  }
  function curvePath(gains, width = 62, height = 18) {
    const min = Math.log(BANDS[0]);
    const max = Math.log(BANDS[BANDS.length - 1]);
    const mid = height / 2;
    const span = mid - 1.5;
    const ceiling = 6.5;
    const points = gains.map((gain, index) => {
      const x = (Math.log(BANDS[index]) - min) / (max - min) * width;
      const value = Math.max(-ceiling, Math.min(ceiling, gain));
      const y = mid - value / ceiling * span;
      return [x, y];
    });
    return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  }

  // src/core/eq.ts
  var BASELINE_KEY = "slab:baseline:v1";
  var GAIN_LIMIT = 12;
  var filters = [];
  var baseline = null;
  var chain = Promise.resolve();
  var ready = false;
  function readBaseline() {
    try {
      const raw = localStorage.getItem(BASELINE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
  function writeBaseline(value) {
    try {
      localStorage.setItem(BASELINE_KEY, JSON.stringify(value));
    } catch {
    }
  }
  function eqAvailable() {
    return ready && filters.length > 0;
  }
  async function initEq() {
    const api = Spicetify.Platform.EqualizerAPI;
    if (!api) return false;
    try {
      const list = await api.getFilters();
      if (!list.length) return false;
      filters = [...list].sort((a, b) => a.frequency - b.frequency);
      const saved = readBaseline();
      baseline = saved ?? Object.fromEntries(filters.map((filter) => [filter.key, filter.gain]));
      if (!saved) writeBaseline(baseline);
      ready = true;
      return true;
    } catch {
      return false;
    }
  }
  function clamp(value) {
    return Math.max(-GAIN_LIMIT, Math.min(GAIN_LIMIT, value));
  }
  function applyCurve(gainsDb) {
    const api = Spicetify.Platform.EqualizerAPI;
    if (!api || !filters.length) return Promise.resolve();
    chain = chain.then(async () => {
      api.setEnabledState(true);
      for (let index = 0; index < filters.length; index += 1) {
        const filter = filters[index];
        const band = nearestBand(filter.frequency);
        const gain = clamp(gainsDb[band] ?? 0);
        try {
          await api.setFilterGain(filter.key, gain);
        } catch {
        }
      }
    }).catch(() => void 0);
    return chain;
  }
  function nearestBand(frequency) {
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < BANDS.length; index += 1) {
      const distance = Math.abs(Math.log(frequency) - Math.log(BANDS[index]));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  }
  function restoreBaseline() {
    const api = Spicetify.Platform.EqualizerAPI;
    if (!api || !baseline || !filters.length) return Promise.resolve();
    chain = chain.then(async () => {
      for (const filter of filters) {
        const gain = baseline?.[filter.key];
        if (typeof gain !== "number") continue;
        try {
          await api.setFilterGain(filter.key, gain);
        } catch {
        }
      }
    }).catch(() => void 0);
    return chain;
  }

  // src/core/state.ts
  var KEY = "slab:state:v1";
  var DEFAULTS = {
    moodId: "flat",
    auto: false,
    open: false,
    every: 4
  };
  function loadState() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      return {
        moodId: typeof parsed.moodId === "string" ? parsed.moodId : DEFAULTS.moodId,
        auto: parsed.auto === true,
        open: parsed.open === true,
        every: typeof parsed.every === "number" && parsed.every >= 1 && parsed.every <= 16 ? parsed.every : DEFAULTS.every
      };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function saveState(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
    }
  }

  // src/core/dsp.ts
  var DSP_ORIGIN = "http://127.0.0.1:47832";
  var status = { linked: false };
  var lastProbe = 0;
  var listeners = /* @__PURE__ */ new Set();
  function onDspChange(listener2) {
    listeners.add(listener2);
    listener2(status);
    return () => listeners.delete(listener2);
  }
  function dspStatus() {
    return status;
  }
  function publish(next) {
    const changed = next.linked !== status.linked || next.version !== status.version;
    status = next;
    if (changed) for (const listener2 of listeners) listener2(status);
  }
  async function request(path, init, timeout = 700) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${DSP_ORIGIN}${path}`, {
        ...init,
        signal: controller.signal,
        cache: "no-store"
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function probeDsp(force = false) {
    const now = Date.now();
    if (!force && now - lastProbe < 4e3) return status;
    lastProbe = now;
    const payload = await request("/status");
    if (payload?.ok) {
      publish({
        linked: true,
        version: payload.version,
        sampleRate: payload.sampleRate,
        latencyMs: payload.latencyMs,
        params: payload.params
      });
    } else {
      publish({ linked: false });
    }
    return status;
  }
  async function sendDsp(params) {
    const payload = await request("/params", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
    if (!payload) {
      publish({ linked: false });
      return false;
    }
    publish({ ...status, linked: true, params: { ...status.params, ...params } });
    return true;
  }
  async function dspTapeStop() {
    const payload = await request("/tapstop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ downMs: 380, holdMs: 70, upMs: 240 })
    });
    return Boolean(payload);
  }

  // src/ui/styles.ts
  var STYLE_ID = "slab-styles";
  var CSS = `
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
}
.slab-dsp[data-linked="true"] {
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

  // src/ui/deck.ts
  function isPlaying() {
    try {
      return Spicetify.Player?.isPlaying?.() === true;
    } catch {
      return false;
    }
  }
  function progressMs() {
    try {
      return Spicetify.Player?.getProgress?.() ?? 0;
    } catch {
      return 0;
    }
  }
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === void 0 || value === null) continue;
      if (key === "class") node.className = String(value);
      else if (key === "html") node.innerHTML = String(value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (typeof value === "boolean") {
        node.toggleAttribute(key, value);
      } else {
        node.setAttribute(key, String(value));
      }
    }
    for (const child of children) {
      node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }
  var CASSETTE = `
<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.4" stroke="currentColor" stroke-width="1.6"/>
  <rect x="6.2" y="8.2" width="11.6" height="4.6" rx="1.2" stroke="currentColor" stroke-width="1.3" opacity=".75"/>
  <circle cx="8.6" cy="10.5" r="1.15" fill="currentColor"/>
  <circle cx="15.4" cy="10.5" r="1.15" fill="currentColor"/>
  <path d="M7.6 16.9l1.1-2.2h6.6l1.1 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;
  var REEL = `
<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <circle cx="24" cy="24" r="20.5" stroke="rgba(255,255,255,.16)" stroke-width="1.8"/>
  <circle cx="24" cy="24" r="11.5" stroke="rgba(255,255,255,.20)" stroke-width="1.3"/>
  <circle cx="24" cy="24" r="3.6" fill="rgba(255,255,255,.38)"/>
  <g stroke="rgba(255,255,255,.32)" stroke-width="1.5" stroke-linecap="round">
    <path d="M24 20.4V13.2"/><path d="M24 27.6v7.2"/>
    <path d="M27.1 25.8l6.2 3.6"/><path d="M20.9 22.2l-6.2-3.6"/>
    <path d="M27.1 22.2l6.2-3.6"/><path d="M20.9 25.8l-6.2 3.6"/>
  </g>
</svg>`;
  var Deck = class {
    constructor(state) {
      this.moodButtons = /* @__PURE__ */ new Map();
      this.disposeDsp = null;
      this.pads = [];
      this.refreshTimer = null;
      this.chipTimer = null;
      this.activityTimer = null;
      this.lastGridUri = null;
      this.lastGridAttempt = 0;
      this.onDocumentClick = (event) => this.handleOutside(event);
      this.onKey = (event) => this.handleKey(event);
      this.onResize = () => this.position();
      this.state = state;
      this.chip = this.buildChip();
      this.bpmEl = h("span", { class: "slab-bpm" }, "--.-", h("small", {}, "BPM"));
      this.posEl = h("div", { class: "slab-pos" }, "NO GRID FOR THIS TRACK");
      this.barFill = h("span");
      this.activityEl = h("span", { class: "slab-activity" });
      this.switchEl = h("button", {
        class: "slab-switch",
        role: "switch",
        "aria-checked": String(state.auto),
        "aria-label": "Automatic chop",
        onclick: () => this.toggleAuto()
      });
      this.dotEl = h("span", { class: "slab-dot" });
      this.speedEl = h("span", { class: "slab-speed" }, "\u2026");
      this.dspDot = h("span", { class: "slab-dsp-dot" });
      this.dspText = h("span", { class: "slab-dsp-text" }, "checking DSP helper\u2026");
      this.dspEl = h("div", { class: "slab-dsp", "data-linked": "false" }, this.dspDot, this.dspText);
      this.panel = this.buildPanel();
      onChop((event) => this.flashActivity(event.label));
    }
    mount() {
      this.injectStyles();
      this.mountChip();
      document.body.append(this.panel);
      document.addEventListener("click", this.onDocumentClick, true);
      document.addEventListener("keydown", this.onKey);
      window.addEventListener("resize", this.onResize);
      if (this.state.open) this.open();
      else this.panel.hidden = true;
      this.renderMoodState();
      this.renderAutoState();
      let wasLinked = false;
      this.disposeDsp = onDspChange((status2) => {
        this.renderDsp(status2.linked, status2.latencyMs);
        if (status2.linked && !wasLinked) void sendDsp(moodById(this.state.moodId).dsp);
        wasLinked = status2.linked;
      });
      void probeDsp(true);
      void this.applyMood(this.state.moodId, false);
      void this.syncGrid();
      this.refresh();
      this.refreshTimer = window.setInterval(() => this.refresh(), 100);
      this.chipTimer = window.setInterval(() => this.ensureChip(), 1200);
    }
    destroy() {
      if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
      if (this.chipTimer !== null) window.clearInterval(this.chipTimer);
      if (this.activityTimer !== null) window.clearTimeout(this.activityTimer);
      document.removeEventListener("click", this.onDocumentClick, true);
      document.removeEventListener("keydown", this.onKey);
      window.removeEventListener("resize", this.onResize);
      this.chip.remove();
      this.panel.remove();
      onChop(null);
      this.disposeDsp?.();
      this.disposeDsp = null;
    }
    onTrackChange() {
      resetForTrack();
      this.lastGridUri = null;
      void this.syncGrid();
      this.refresh();
    }
    injectStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const style = h("style", { id: STYLE_ID });
      style.textContent = CSS;
      document.head.append(style);
    }
    mountChip() {
      const lyrics = document.querySelector('[data-testid="lyrics-button"]');
      const host = lyrics?.parentElement;
      if (host) {
        host.insertBefore(this.chip, lyrics);
        return;
      }
      const bar = document.querySelector('[data-testid="now-playing-bar"]');
      (bar ?? document.body).append(this.chip);
    }
    /** Spotify rebuilds the playbar on some navigation — put the chip back. */
    ensureChip() {
      if (this.chip.isConnected) return;
      this.mountChip();
    }
    buildChip() {
      const chip = h("button", {
        class: "slab-chip",
        "aria-label": "SLAB \u2014 playback moods",
        title: "SLAB \u2014 Third Coast playback moods",
        onclick: (event) => {
          event.stopPropagation();
          this.toggle();
        }
      });
      chip.innerHTML = CASSETTE;
      return chip;
    }
    buildPanel() {
      const panel = h("div", {
        class: "slab-panel",
        role: "dialog",
        "aria-label": "SLAB playback moods"
      });
      panel.hidden = true;
      const close = h("button", {
        class: "slab-close",
        "aria-label": "Close SLAB",
        onclick: () => this.close()
      }, "\xD7");
      const head = h(
        "div",
        { class: "slab-head" },
        h(
          "div",
          {},
          h("div", { class: "slab-mark" }, "SLAB"),
          h("div", { class: "slab-kicker" }, "Third Coast playback")
        ),
        close
      );
      const moodGrid = h("div", { class: "slab-moods" });
      for (const mood of MOODS) {
        const button = h("button", {
          class: "slab-mood",
          "data-mood": mood.id,
          "aria-pressed": "false",
          onclick: () => void this.applyMood(mood.id, true)
        });
        button.innerHTML = `
        <span class="slab-mood-name">${mood.name}</span>
        <svg viewBox="0 0 62 18" preserveAspectRatio="none" aria-hidden="true">
          <path d="${curvePath(mood.gains, 62, 18)}" />
        </svg>
        <span class="slab-mood-sub">${mood.sub}</span>`;
        this.moodButtons.set(mood.id, button);
        moodGrid.append(button);
      }
      const tape = h(
        "div",
        { class: "slab-tape" },
        h("div", { class: "slab-reel", html: REEL }),
        h(
          "div",
          { class: "slab-read" },
          this.bpmEl,
          this.posEl,
          h("div", { class: "slab-bars" }, this.barFill)
        )
      );
      const padRow = h("div", { class: "slab-pads" });
      const padDefs = [
        { id: "chop", label: "Chop", sub: "1 bar", run: () => void chopBars(1) },
        { id: "screw", label: "Screw", sub: "2 bars", run: () => void chopBars(2) },
        { id: "spin", label: "Spin", sub: "4 bars", run: () => void chopBars(4) },
        { id: "loop", label: "Loop", sub: "4\xD7 bar", run: () => void loopBars(4) },
        {
          id: "stop",
          label: "Stop",
          sub: "fader",
          run: () => {
            const linked = dspStatus().linked;
            if (linked) void dspTapeStop();
            void tapeStop(linked ? { fade: false, pauseDelayMs: 470 } : void 0);
          }
        }
      ];
      for (const def of padDefs) {
        const pad = h("button", {
          class: "slab-pad",
          "data-pad": def.id,
          onclick: (event) => {
            event.stopPropagation();
            def.run();
          }
        });
        pad.innerHTML = `${def.label}<small>${def.sub}</small>`;
        this.pads.push(pad);
        padRow.append(pad);
      }
      const auto = h(
        "div",
        { class: "slab-auto" },
        h(
          "div",
          { class: "slab-auto-text" },
          h("span", { class: "slab-auto-title" }, "Auto chop"),
          h("span", { class: "slab-auto-sub" }, "cuts a bar every 4, in time")
        ),
        this.switchEl
      );
      const foot = h(
        "div",
        { class: "slab-foot" },
        this.activityEl,
        h("div", { class: "slab-foot-right" }, this.dotEl, this.speedEl)
      );
      panel.append(
        head,
        h("div", { class: "slab-label" }, "Moods"),
        moodGrid,
        h("div", { class: "slab-label" }, "Tape"),
        tape,
        h("div", { class: "slab-label" }, "Pads"),
        padRow,
        auto,
        this.dspEl,
        foot
      );
      panel.addEventListener("click", (event) => event.stopPropagation());
      return panel;
    }
    handleOutside(event) {
      if (this.panel.hidden) return;
      const target = event.target;
      if (!target) return;
      if (this.panel.contains(target) || this.chip.contains(target)) return;
      this.close();
    }
    handleKey(event) {
      if (event.key === "Escape" && !this.panel.hidden) {
        this.close();
        return;
      }
      if (this.panel.hidden) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const index = Number.parseInt(event.key, 10);
      if (!Number.isFinite(index) || index < 1 || index > this.pads.length) return;
      const target = event.target;
      if (target && /input|textarea/i.test(target.tagName)) return;
      event.preventDefault();
      this.pads[index - 1].click();
    }
    toggle() {
      if (this.panel.hidden) this.open();
      else this.close();
    }
    open() {
      this.panel.hidden = false;
      this.state.open = true;
      saveState(this.state);
      this.chip.dataset.on = "true";
      this.position();
      this.renderMoodState();
      this.refresh();
    }
    close() {
      this.panel.hidden = true;
      this.state.open = false;
      saveState(this.state);
      this.chip.dataset.on = this.state.moodId !== "flat" ? "true" : "false";
    }
    position() {
      if (this.panel.hidden) return;
      const rect = this.chip.getBoundingClientRect();
      const width = this.panel.offsetWidth || 372;
      const height = this.panel.offsetHeight || 420;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      const left = Math.max(8, Math.min(maxLeft, rect.right - width));
      let top = rect.top - height - 10;
      if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 10);
      this.panel.style.left = `${Math.round(left)}px`;
      this.panel.style.top = `${Math.round(Math.max(8, top))}px`;
    }
    async applyMood(id, announce) {
      this.state.moodId = id;
      saveState(this.state);
      this.renderMoodState();
      this.chip.dataset.on = id !== "flat" ? "true" : "false";
      if (id === "flat") await restoreBaseline();
      else await applyCurve(moodById(id).gains);
      void sendDsp(moodById(id).dsp);
      if (announce) {
        const mood = moodById(id);
        this.flashActivity(`${mood.name} \u2014 ${mood.sub}`);
      }
    }
    renderDsp(linked, latencyMs) {
      this.dspEl.dataset.linked = linked ? "true" : "false";
      if (linked) {
        const latency = typeof latencyMs === "number" ? ` \xB7 ${Math.round(latencyMs)} ms` : "";
        this.dspText.textContent = `DSP linked \u2014 pitch, reverb, delay live${latency}`;
        this.dspEl.title = "SLAB DSP is running and processing Spotify's audio.";
      } else {
        this.dspText.textContent = "DSP helper offline \u2014 EQ only";
        this.dspEl.title = "Run SLAB DSP to get real pitch, reverb and delay. Without it SLAB only shapes the native EQ.";
      }
    }
    renderMoodState() {
      for (const [id, button] of this.moodButtons) {
        button.setAttribute("aria-pressed", id === this.state.moodId ? "true" : "false");
      }
    }
    toggleAuto() {
      this.state.auto = !this.state.auto;
      saveState(this.state);
      setAuto(this.state.auto, this.state.every);
      this.renderAutoState();
      this.flashActivity(this.state.auto ? "auto chop on" : "auto chop off");
    }
    renderAutoState() {
      this.switchEl.setAttribute("aria-checked", String(this.state.auto));
      setAuto(this.state.auto, this.state.every);
    }
    flashActivity(text) {
      this.activityEl.textContent = text;
      if (this.activityTimer !== null) window.clearTimeout(this.activityTimer);
      this.activityTimer = window.setTimeout(() => {
        this.activityEl.textContent = "";
      }, 1800);
    }
    async syncGrid(force = false) {
      const uri = Spicetify.Player.data?.item?.uri;
      if (!uri) return;
      if (!force && uri === this.lastGridUri && gridFor(uri)) return;
      this.lastGridUri = uri;
      this.lastGridAttempt = Date.now();
      await loadGrid(uri);
      this.refresh();
    }
    refresh() {
      void probeDsp();
      if (!gridFor() && Date.now() - this.lastGridAttempt > 5e3) {
        void this.syncGrid(true);
      }
      if (this.panel.hidden) return;
      const playing = isPlaying();
      this.panel.dataset.playing = playing ? "true" : "false";
      const grid = gridFor();
      if (!grid) {
        this.bpmEl.innerHTML = `--.-<small>BPM</small>`;
        this.posEl.textContent = "NO GRID FOR THIS TRACK";
        this.barFill.style.width = "0%";
      } else {
        const progress = progressMs();
        const bar = barIndexAt(grid, progress);
        const beat = beatIndexAt(grid, progress);
        const total = barCount(grid);
        const beatsPerBar = Math.max(1, grid.timeSignature || 4);
        const beatInBar = (beat - Math.max(0, bar) * beatsPerBar) % beatsPerBar + 1;
        const tempo = grid.tempo > 0 ? grid.tempo.toFixed(1) : "--.-";
        this.bpmEl.innerHTML = `${tempo}<small>BPM</small>`;
        this.posEl.textContent = `BAR ${Math.max(1, bar + 1)}/${total} \xB7 BEAT ${beatInBar}/${beatsPerBar}`;
        const ratio = total > 0 ? (Math.max(0, bar) + 1) / total : 0;
        this.barFill.style.width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
      }
      const speed = this.speedInfo();
      this.dotEl.dataset.state = speed.ok ? "ok" : "locked";
      this.speedEl.textContent = speed.text;
      this.speedEl.title = speed.hint;
      this.speedEl.className = speed.ok ? "slab-speed" : "slab-speed slab-lock";
      for (const pad of this.pads) {
        const needsGrid = pad.dataset.pad !== "stop";
        pad.disabled = needsGrid && !grid;
      }
    }
    speedInfo() {
      if (dspStatus().linked) {
        return {
          ok: true,
          text: "pitch live",
          hint: "SLAB DSP is shifting pitch and adding effects outside the player. Tempo stays locked."
        };
      }
      const api = Spicetify.Platform.PlayerAPI;
      const capabilities = api.getCapabilities?.();
      const state = api.getState();
      const reasons = state?.restrictions?.disallowSettingPlaybackSpeedReasons ?? [];
      if (!capabilities?.canChangeSpeed) {
        return {
          ok: false,
          text: "speed unsupported",
          hint: "This client does not expose playback speed."
        };
      }
      if (reasons.length > 0) {
        const reason = reasons[0];
        return {
          ok: false,
          text: reason === "unknown" ? "speed locked for music" : `speed locked \xB7 ${reason}`,
          hint: "Spotify blocks playback speed for music on this build. SLAB shapes tone and edits instead of pretending."
        };
      }
      return {
        ok: true,
        text: "speed available",
        hint: "This build allows playback speed."
      };
    }
  };

  // src/main.ts
  var VERSION = "0.2.0";
  var LOG = "[SLAB]";
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(predicate, timeout = 2e4) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try {
        const value = predicate();
        if (value) return value;
      } catch {
      }
      await sleep(120);
    }
    return null;
  }
  async function boot2() {
    const player = await waitFor(
      () => typeof Spicetify !== "undefined" && Spicetify.Player ? Spicetify.Player : null
    );
    if (!player) {
      console.warn(LOG, "player never appeared, giving up");
      return;
    }
    const eqApi = await waitFor(() => Spicetify.Platform.EqualizerAPI ?? null, 1e4);
    const eqReady = eqApi ? await initEq() : false;
    if (!eqReady) console.warn(LOG, "equalizer unavailable \u2014 moods will be inert");
    const state = loadState();
    const deck = new Deck(state);
    deck.mount();
    const onSongChange = () => deck.onTrackChange();
    Spicetify.Player.addEventListener("songchange", onSongChange);
    const destroy = () => {
      try {
        Spicetify.Player.removeEventListener("songchange", onSongChange);
      } catch {
      }
      deck.destroy();
      disposeChops();
      disposeClock();
      if (window.SLAB) window.SLAB = void 0;
    };
    window.SLAB = {
      version: VERSION,
      deck,
      state,
      eq: eqAvailable(),
      open: () => deck.open(),
      close: () => deck.close(),
      toggle: () => deck.toggle(),
      destroy
    };
    console.info(LOG, `v${VERSION} ready \xB7 eq=${eqReady ? "on" : "off"}`);
  }
  try {
    const previous = window.SLAB;
    if (previous?.destroy) previous.destroy();
  } catch {
  }
  void boot2().catch((error) => console.error(LOG, "boot failed", error));
})();
