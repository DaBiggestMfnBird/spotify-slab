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
    const running2 = inflight.get(target);
    if (running2) return running2;
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
      emit(span >= 4 ? "spin" : "chop", `Back ${span} bar${span === 1 ? "" : "s"}`);
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
        emit("loop", "Loop done");
      }
    });
    emit("loop", `Looping this bar ${total} times`);
    return true;
  }
  async function tapeStop(options = {}) {
    if (!Spicetify.Player.isPlaying()) {
      emit("stop", "Already stopped");
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
    emit("stop", "Tape stopped");
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
        if (did) emit("auto", `Auto chop, every ${autoEvery} bar${autoEvery === 1 ? "" : "s"}`);
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
  function applyCurveAtFrequencies(points) {
    const api = Spicetify.Platform.EqualizerAPI;
    if (!api || !filters.length || !points.length) return Promise.resolve();
    chain = chain.then(async () => {
      api.setEnabledState(true);
      for (const filter of filters) {
        let best = points[0];
        let bestDistance = Infinity;
        for (const point of points) {
          const distance = Math.abs(
            Math.log(filter.frequency) - Math.log(point.frequency)
          );
          if (distance < bestDistance) {
            bestDistance = distance;
            best = point;
          }
        }
        try {
          await api.setFilterGain(filter.key, clamp(best.gain));
        } catch {
        }
      }
    }).catch(() => void 0);
    return chain;
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
    every: 4,
    pitch: 0,
    eqOwner: "auto"
  };
  function clampPitch(value) {
    return Math.max(-1200, Math.min(1200, Math.round(value / 10) * 10));
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      return {
        moodId: typeof parsed.moodId === "string" ? parsed.moodId : DEFAULTS.moodId,
        auto: parsed.auto === true,
        open: parsed.open === true,
        every: typeof parsed.every === "number" && parsed.every >= 1 && parsed.every <= 16 ? parsed.every : DEFAULTS.every,
        // State saved before the slider existed has no pitch; the mood's is the truth.
        pitch: typeof parsed.pitch === "number" ? clampPitch(parsed.pitch) : moodById(parsed.moodId ?? DEFAULTS.moodId).dsp.pitch,
        eqOwner: parsed.eqOwner === "slab" || parsed.eqOwner === "modern" ? parsed.eqOwner : DEFAULTS.eqOwner
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
    const changed = next.linked !== status.linked || next.version !== status.version || next.tapping !== status.tapping || next.audio !== status.audio;
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
        // Helpers before 0.3.0 don't report these and only ran while tapping.
        tapping: payload.tapping !== false,
        audio: payload.audio !== false,
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

  // src/core/moderneq.ts
  var STATE_KEY = "moderneq:state";
  var BANDS2 = [32, 64, 125, 250, 500, 1e3, 2e3, 4e3, 8e3, 16e3, 24e3];
  function modernEqPresent() {
    try {
      if (localStorage.getItem(STATE_KEY) !== null) return true;
    } catch {
    }
    return Boolean(document.querySelector(".meq-menu-item, .meq-overlay"));
  }
  function modernEqBands() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.bands) || parsed.bands.length !== BANDS2.length) return null;
      const gains = parsed.bands.map((value) => typeof value === "number" ? value : 0);
      return BANDS2.map((frequency, index) => ({ frequency, gain: gains[index] }));
    } catch {
      return null;
    }
  }

  // src/ui/art.ts
  function fmt(value) {
    return String(Math.round(value * 100) / 100);
  }
  function polar(radius, degrees, cx = 0, cy = 0) {
    const angle = degrees * Math.PI / 180;
    return `${fmt(cx + radius * Math.cos(angle))} ${fmt(cy + radius * Math.sin(angle))}`;
  }
  var WHEEL_SIZE = 57;
  var TYRE_RADIUS = 18.5;
  var BOX = `viewBox="-28.5 -28.5 57 57" width="57" height="57" aria-hidden="true" focusable="false"`;
  var CHROME = (id) => `
  <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#F7F9F9"/><stop offset=".42" stop-color="#D7DCDF"/>
    <stop offset=".56" stop-color="#8F979C"/><stop offset=".78" stop-color="#C9CFD3"/>
    <stop offset="1" stop-color="#EEF1F2"/>
  </linearGradient>`;
  var WHEEL_STATIC = `
<svg class="slab-wheel-base" ${BOX}>
  <defs>${CHROME("slab-chrome-rim")}</defs>
  <circle cy="2" r="19.5" fill="#000" opacity=".5"/>
  <circle r="${TYRE_RADIUS}" fill="#0E0D0D"/>
  <circle r="${TYRE_RADIUS - 0.5}" fill="none" stroke="#343332"/>
  <circle r="13.2" fill="none" stroke="#F6F0E4" stroke-width="2.6"/>
  <circle r="13.2" fill="none" stroke="#C4122C" stroke-width=".9"/>
  <circle r="11.8" fill="#15171A"/>
  <circle r="10.9" fill="none" stroke="url(#slab-chrome-rim)" stroke-width="1.9"/>
</svg>`;
  function elbow(angle) {
    const out = (radius, side, lean = 0) => {
      const a = (angle + lean) * Math.PI / 180;
      const radial = [Math.cos(a), Math.sin(a)];
      const tangent = [-radial[1], radial[0]];
      return `${fmt(radial[0] * radius + tangent[0] * side)} ${fmt(radial[1] * radius + tangent[1] * side)}`;
    };
    const body = `M${out(11.5, -2)}L${out(21, -1.9)}L${out(28.2, -1.5, 8)}L${out(28.2, 1.5, 8)}L${out(21, 1.9)}L${out(11.5, 2)}Z`;
    const shine = `M${out(12.5, -0.4)}L${out(21, -0.4)}L${out(27.2, -0.1, 8)}`;
    return `<path d="${body}" fill="#C4CACE" stroke="#0C0D0E" stroke-width=".8" stroke-linejoin="round"/><path d="${shine}" fill="none" stroke="#FFFFFF" stroke-width="1.1" stroke-linecap="butt" stroke-linejoin="round"/>`;
  }
  function wheelSpin() {
    let spokes = "";
    for (let i = 0; i < 10; i++) {
      spokes += `<path d="M${polar(2, i * 36)}L${polar(9.8, i * 36)}"/>`;
    }
    let elbows = "";
    for (let i = 0; i < 5; i++) elbows += elbow(i * 72 + 18);
    return `
<svg class="slab-wheel-spin" ${BOX}>
  <defs>${CHROME("slab-chrome-hub")}</defs>
  <g fill="none" stroke="#AEB5BA" stroke-width="1.2">${spokes}</g>
  ${elbows}
  <path d="M-7 -2.2L-2.2 -1.5L2.2 -1.5L7 -2.2L7 2.2L2.2 1.5L-2.2 1.5L-7 2.2Z" fill="url(#slab-chrome-hub)" stroke="#16181A" stroke-width=".7" stroke-linejoin="round"/>
  <circle r="2.2" fill="url(#slab-chrome-hub)" stroke="#16181A" stroke-width=".6"/>
</svg>`;
  }
  var WHEEL_SPIN = wheelSpin();
  function chipIcon() {
    let pokes = "";
    for (const a of [25, 115, 205, 295]) pokes += `<path d="M${polar(6.6, a, 10, 10)}L${polar(9.4, a, 10, 10)}"/>`;
    return `
<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
  <g stroke="currentColor" stroke-width="2.2" stroke-linecap="round">${pokes}</g>
  <circle cx="10" cy="10" r="7.2" fill="currentColor"/>
  <circle cx="10" cy="10" r="4.6" fill="#141414" stroke="#FFFFFF" stroke-width="1.4"/>
  <circle cx="10" cy="10" r="1.7" fill="currentColor"/>
</svg>`;
  }
  var CHIP_ICON = chipIcon();
  var LETTERS = [
    // S
    "M2.5 0H14V4H4V8H11.5L14 10.5V17.5L11.5 20H0V16H10V12H2.5L0 9.5V2.5Z",
    // L
    "M16.5 0H20.5V16H28.5V20H18.5L16.5 18Z",
    // A
    "M33.5 0H42.5L45.5 3V20H41.5V14H34.5V20H30.5V3ZM34.5 4V10H41.5V4Z",
    // B
    "M48 0H60L63 3V7.5L60.8 10L63 12.5V17L60 20H48ZM52 4V8H59V4ZM52 12V16H59V12Z"
  ].join("");
  var EMBLEM = `
<svg class="slab-emblem" viewBox="0 0 64 22" width="64" height="22" role="img" aria-label="SLAB" focusable="false">
  <defs>${CHROME("slab-chrome-badge")}</defs>
  <path d="${LETTERS}" transform="translate(.4 1.3)" fill="#1E0208" fill-rule="evenodd" opacity=".8"/>
  <path d="${LETTERS}" fill="url(#slab-chrome-badge)" fill-rule="evenodd"/>
</svg>`;
  var CLOSE_ICON = `
<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
  <path d="M1.5 1.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;
  function screw(x, y, slot) {
    return `<g transform="translate(${x} ${y})"><circle r="3.6" fill="#55595D"/><circle r="3" fill="#C9CDD0"/><path d="M${polar(2.7, slot)}L${polar(2.7, slot + 180)}" stroke="#2B2D30" stroke-width="1"/></g>`;
  }
  var SILL_SCREWS = `
<svg class="slab-sill-screws" viewBox="0 0 400 84" width="400" height="84" aria-hidden="true" focusable="false">
  ${screw(9, 11, 20)}${screw(9, 73, 110)}${screw(391, 11, 70)}${screw(391, 73, 150)}
</svg>`;

  // src/ui/neon-glyphs.ts
  var NEON_GLYPHS = {
    "0": { a: 48, l: "M17 0L8.5 0Q0 0 0.6 -8.5L5.4 -77Q6.3 -90 19.3 -90L31.3 -90Q44.3 -90 43.4 -77L38.5 -6.5Q38 0 31.5 0L25 0", d: "", i: [17, 0], o: [25, 0] },
    "1": { a: 34, l: "M7 -72L24.1 -88Q26.3 -90 26.1 -87L20 0", d: "M20 0L26.1 -87Q26.3 -90 24.1 -88L7 -72", i: [20, 0], o: [20, 0] },
    "2": { a: 48, l: "M5 -72L5.7 -81Q6.3 -90 15.3 -90L31.3 -90Q44.3 -90 43.4 -77L42.4 -63Q41.5 -50 29.9 -44.1L13.7 -35.9Q2.1 -30 1.2 -17L0.9 -13Q0 0 13 0L38 0", d: "M0 0L1.2 -17Q2.1 -30 13.7 -35.9L29.9 -44.1Q41.5 -50 42.4 -63L43.4 -77Q44.3 -90 31.3 -90L15.3 -90Q6.3 -90 5.7 -81L5 -72", i: [0, 0], o: [38, 0] },
    "3": { a: 48, l: "M5 -72L5.7 -81Q6.3 -90 15.3 -90L31.3 -90Q44.3 -90 43.4 -77L42.4 -62.5Q41.5 -50 29 -50L16.5 -50M41.5 -50L38.9 -13Q38 0 25 0L9 0Q0 0 0.6 -9L1.3 -18", d: "M0 0L25 0Q38 0 38.9 -13L43.4 -77Q44.3 -90 31.3 -90L15.3 -90Q6.3 -90 5.7 -81L5 -72M16.5 -50L41.5 -50M1.3 -18L0 0", i: [0, 0], o: [0, 0] },
    "4": { a: 50, l: "M29 0L30.4 -20M31.8 -40L35.1 -87Q35.3 -90 33.8 -87.4L3.6 -32.6Q2.1 -30 5.1 -30L44.1 -30", d: "M30.4 -20L31.8 -40M44.1 -30L34.1 -30Q31.1 -30 30.9 -27L29 0", i: [29, 0], o: [29, 0] },
    "5": { a: 48, l: "M42.3 -90L19.3 -90Q6.3 -90 5.4 -77L4.5 -65Q3.6 -52 16.6 -52L28.6 -52Q41.6 -52 40.7 -39L38.9 -13Q38 0 25 0L9 0Q0 0 0.6 -9L1.3 -18", d: "M0 0L25 0Q38 0 38.9 -13L40.7 -39Q41.6 -52 28.6 -52L16.6 -52Q3.6 -52 4.5 -65L5.4 -77Q6.3 -90 19.3 -90L42.3 -90M1.3 -18L0 0", i: [0, 0], o: [0, 0] },
    "6": { a: 48, l: "M43.2 -74L43.7 -82Q44.3 -90 36.3 -90L19.3 -90Q6.3 -90 5.4 -77L0.9 -13Q0 0 13 0L25 0Q38 0 38.9 -13L40.6 -37Q41.5 -50 28.5 -50L15.5 -50", d: "M0 0L5.4 -77Q6.3 -90 19.3 -90L36.3 -90Q44.3 -90 43.7 -82L43.2 -74M15.5 -50L28.5 -50Q41.5 -50 40.6 -37L38 0", i: [0, 0], o: [38, 0] },
    "7": { a: 44, l: "M6.3 -90L41.3 -90Q44.3 -90 43.3 -87.2L14 0", d: "M14 0L43.3 -87.2Q44.3 -90 41.3 -90L6.3 -90", i: [14, 0], o: [14, 0] },
    "8": { a: 48, l: "M26 0L32 0Q38 0 38.4 -6L40.3 -33.2Q40.7 -38 37.4 -41.5L37.4 -41.5Q34.1 -45 37.6 -48.3L37.9 -48.5Q41.6 -52 42 -57.1L43.4 -77Q44.3 -90 31.3 -90L19.3 -90Q6.3 -90 5.4 -77L4 -56.8Q3.6 -52 6.9 -48.5L6.9 -48.5Q10.1 -45 6.7 -41.7L6.4 -41.5Q2.7 -38 2.3 -32.9L0.5 -7Q0 0 7 0L14 0M16.1 -45L28.1 -45", d: "M14 0L7 0Q0 0 0.5 -7L2.3 -32.9Q2.7 -38 6.4 -41.5L8 -43Q10.1 -45 13.1 -45L16.1 -45M28.1 -45L31.1 -45Q34.1 -45 36.2 -42.8L37.4 -41.5Q40.7 -38 40.3 -33.2L38.4 -6Q38 0 32 0L26 0", i: [26, 0], o: [26, 0] },
    "9": { a: 48, l: "M1.3 -18L0.6 -9Q0 0 9 0L25 0Q38 0 38.9 -13L43.4 -77Q44.3 -90 31.3 -90L19.3 -90Q6.3 -90 5.4 -77L3.7 -53Q2.8 -40 15.8 -40L28.8 -40", d: "M0 0L1.3 -18M28.8 -40L15.8 -40Q2.8 -40 3.7 -53L5.4 -77Q6.3 -90 19.3 -90L31.3 -90Q44.3 -90 43.4 -77L38 0", i: [0, 0], o: [38, 0] },
    "a": { a: 50, l: "M3.9 -56L4.4 -63Q4.9 -70 11.9 -70L25.9 -70Q38.9 -70 38 -57L34.3 -5Q34 0 39 0L44 0M25.7 -38L14.2 -38Q2.7 -38 1.9 -26.5L0.8 -11.5Q0 0 11.5 0L23 0", d: "M0 0L3.9 -56M44 0L39 0Q34 0 34.3 -5L36.3 -32.5Q36.7 -38 31.2 -38L25.7 -38", i: [0, 0], o: [23, 0] },
    "b": { a: 42, l: "M7 -100L0.9 -13Q0 0 13 0L21 0Q34 0 34.9 -13L38.1 -58.5Q38.9 -70 27.4 -70L15.9 -70", d: "M0 0L7 -100M15.9 -70L27.4 -70Q38.9 -70 38.1 -58.5L34 0", i: [0, 0], o: [34, 0] },
    "c": { a: 38, l: "M35.9 -56L36.4 -63Q36.9 -70 29.9 -70L17.9 -70Q4.9 -70 4 -57L0.9 -13Q0 0 13 0L25 0Q32 0 32.5 -7L33 -14", d: "M0 0L4 -57Q4.9 -70 17.9 -70L29.9 -70Q36.9 -70 36.4 -63L35.9 -56M33 -14L32 0", i: [0, 0], o: [32, 0] },
    "d": { a: 42, l: "M41 -100L34.9 -13Q34 0 21 0L13 0Q0 0 0.9 -13L4.1 -58.5Q4.9 -70 16.4 -70L27.9 -70", d: "M0 0L4.1 -58.5Q4.9 -70 16.4 -70L22.4 -70Q27.9 -70 33.4 -70L33.4 -70Q38.9 -70 39.3 -75.5L41 -100M27.9 -70L16.4 -70Q4.9 -70 4.1 -58.5L0.9 -13Q0 0 13 0L34 0", i: [0, 0], o: [34, 0] },
    "e": { a: 42, l: "M13.6 -37L25.1 -37Q36.6 -37 37.4 -48.5L38 -57Q38.9 -70 25.9 -70L17.9 -70Q4.9 -70 4 -57L0.9 -13Q0 0 13 0L28 0Q34 0 34.4 -6L34.8 -12", d: "M0 0L2.2 -31.5Q2.6 -37 8.1 -37L13.6 -37M34.8 -12L34 0", i: [0, 0], o: [34, 0] },
    "h": { a: 50, l: "M7 -100L0 0M15.9 -70L27.4 -70Q38.9 -70 38.1 -58.5L34.3 -5Q34 0 39 0L44 0", d: "M0 0L7 -100M0 0L4.5 -64.5Q4.9 -70 10.4 -70L15.9 -70", i: [0, 0], o: [44, 0] },
    "i": { a: 22, l: "M5.9 -84L6.7 -96M4.9 -70L0.4 -5.5Q0 0 5.5 0L11 0", d: "M0 0L5.9 -84M6.7 -96L4.9 -70", i: [0, 0], o: [11, 0] },
    "l": { a: 22, l: "M7 -100L0.4 -5.5Q0 0 5.5 0L11 0", d: "M0 0L7 -100", i: [0, 0], o: [11, 0] },
    "m": { a: 76, l: "M4.9 -70L0 0M14.9 -70L24.4 -70Q33.9 -70 33.2 -60.5L29 0M43.9 -70L53.9 -70Q63.9 -70 63.2 -60L59.3 -5Q59 0 64 0L69 0", d: "M0 0L4.9 -70M0 0L4.5 -65Q4.9 -70 9.9 -70L14.9 -70M29 0L33.5 -65Q33.9 -70 38.9 -70L43.9 -70", i: [0, 0], o: [69, 0] },
    "n": { a: 50, l: "M4.9 -70L0 0M15.9 -70L27.4 -70Q38.9 -70 38.1 -58.5L34.3 -5Q34 0 39 0L44 0", d: "M0 0L4.9 -70M0 0L4.5 -64.5Q4.9 -70 10.4 -70L15.9 -70", i: [0, 0], o: [44, 0] },
    "o": { a: 42, l: "M18 0L9 0Q0 0 0.6 -9L4 -57Q4.9 -70 17.9 -70L25.9 -70Q38.9 -70 38 -57L34.3 -4Q34 0 30 0L26 0", d: "", i: [18, 0], o: [26, 0] },
    "p": { a: 42, l: "M-1.8 26L4 -57Q4.9 -70 17.9 -70L25.9 -70Q38.9 -70 38 -57L34.8 -11.5Q34 0 22.5 0L11 0", d: "M0 0L4.9 -70M4.9 -70L-1.8 26M11 0L34 0", i: [0, 0], o: [34, 0] },
    "r": { a: 36, l: "M4.9 -70L0 0M15.9 -70L27.9 -70Q34.9 -70 34.4 -63L33.9 -56", d: "M0 0L4.9 -70M0 0L4.5 -64.5Q4.9 -70 10.4 -70L15.9 -70M33.9 -56L34.4 -63Q34.9 -70 27.9 -70L17.9 -70Q4.9 -70 4 -57L0 0", i: [0, 0], o: [0, 0] },
    "s": { a: 38, l: "M0.9 -13L0.5 -6.5Q0 0 6.5 0L18 0Q31 0 31.9 -13L32.2 -17Q33.1 -30 21 -34.8L15 -37.2Q2.9 -42 3.8 -55L4 -57Q4.9 -70 17.9 -70L29.4 -70Q35.9 -70 35.4 -63.5L35 -57", d: "M0 0L0.9 -13M35 -57L35.4 -63.5Q35.9 -70 29.4 -70L17.9 -70Q4.9 -70 4 -57L3.8 -55Q2.9 -42 15 -37.2L21 -34.8Q33.1 -30 32.2 -17L31 0", i: [0, 0], o: [31, 0] },
    "t": { a: 36, l: "M4.9 -70L10.9 -70M26.9 -70L33.9 -70M20.4 -92L14.5 -7.5Q14 0 21.5 0L29 0", d: "M14 0L18.4 -63Q18.9 -70 11.9 -70L4.9 -70M10.9 -70L26.9 -70M33.9 -70L26.4 -70Q18.9 -70 19.4 -77.5L20.4 -92", i: [14, 0], o: [29, 0] },
    "u": { a: 50, l: "M4.9 -70L0.8 -11.5Q0 0 11.5 0L23 0M38.9 -70L34.3 -5Q34 0 39 0L44 0", d: "M0 0L4.9 -70M23 0L28.5 0Q34 0 34.4 -5.5L38.9 -70", i: [0, 0], o: [44, 0] },
    "v": { a: 42, l: "M4.9 -70L16.5 -3Q17 0 17.9 -2.9L38.9 -70", d: "M17 0L4.9 -70M38.9 -70L17 0", i: [17, 0], o: [17, 0] },
    "w": { a: 62, l: "M4.9 -70L12.7 -3Q13 0 13.9 -2.9L30.2 -55.1Q31.1 -58 31.6 -55L40.5 -3Q41 0 41.7 -2.9L58.9 -70", d: "M13 0L4.9 -70M58.9 -70L41 0", i: [13, 0], o: [41, 0] },
    "C": { a: 50, l: "M47.6 -80L48.3 -90Q49 -100 39 -100L20 -100Q7 -100 6.1 -87L0.9 -13Q0 0 13 0L32 0Q42 0 42.7 -10L43.4 -20", d: "M0 0L6.1 -87Q7 -100 20 -100L39 -100Q49 -100 48.3 -90L47.6 -80M43.4 -20L42 0", i: [0, 0], o: [42, 0] },
    "F": { a: 48, l: "M0 0L6.1 -87Q7 -100 20 -100L47 -100M14.8 -54L36.8 -54", d: "M47 -100L20 -100Q7 -100 6.1 -87L4.2 -59.5Q3.8 -54 9.3 -54L14.8 -54M36.8 -54L16.8 -54Q3.8 -54 2.9 -41L0 0", i: [0, 0], o: [0, 0] },
    "H": { a: 56, l: "M7 -100L0 0M14.6 -52L38.6 -52M53 -100L46 0", d: "M0 0L7 -100M0 0L3.3 -46.5Q3.6 -52 9.1 -52L14.6 -52M38.6 -52L44.1 -52Q49.6 -52 50 -57.5L53 -100", i: [0, 0], o: [46, 0] },
    "M": { a: 68, l: "M0 0L6.8 -97Q7 -100 8 -97.2L30.3 -36.8Q31.4 -34 32.7 -36.7L63.6 -97.3Q65 -100 64.8 -97L58 0", d: "", i: [0, 0], o: [58, 0] },
    "R": { a: 52, l: "M7 -100L0 0M18 -100L36 -100Q49 -100 48.1 -87L46.4 -63Q45.5 -50 32.5 -50L16.5 -50M28.7 -39L43 0", d: "M0 0L7 -100M0 0L6.6 -94.5Q7 -100 12.5 -100L18 -100M16.5 -50L24 -50Q29.5 -50 29.1 -44.5L28.7 -39", i: [0, 0], o: [43, 0] },
    "S": { a: 50, l: "M1.4 -20L0.7 -10Q0 0 10 0L28 0Q41 0 41.9 -13L43 -29Q43.9 -42 32.1 -47.4L16 -54.6Q4.2 -60 5.1 -73L6.1 -87Q7 -100 20 -100L38 -100Q48 -100 47.3 -90L46.6 -80", d: "M0 0L1.4 -20M46.6 -80L47.3 -90Q48 -100 38 -100L20 -100Q7 -100 6.1 -87L5.1 -73Q4.2 -60 16 -54.6L32.1 -47.4Q43.9 -42 43 -29L41 0", i: [0, 0], o: [41, 0] },
    "T": { a: 50, l: "M21 0L27.2 -88M7 -100L49 -100", d: "M27.2 -88L27.6 -94Q28 -100 22 -100L7 -100M49 -100L38.5 -100Q28 -100 27.3 -89.5L21 0", i: [21, 0], o: [21, 0] },
    "U": { a: 54, l: "M7 -100L0.9 -13Q0 0 13 0L31 0Q44 0 44.9 -13L51 -100", d: "M0 0L7 -100M51 -100L44 0", i: [0, 0], o: [44, 0] },
    "+": { a: 46, l: "M20 -14L21 -28M2.7 -39L40.7 -39M22.5 -50L23.5 -64", d: "M19 0L20 -14M21 -28L21.3 -33.5Q21.7 -39 16.2 -39L2.7 -39M40.7 -39L27.2 -39Q21.7 -39 22.1 -44.5L22.5 -50M23.5 -64L19 0", i: [19, 0], o: [19, 0] },
    "\u2212": { a: 44, l: "M3.1 -45L37.1 -45", d: "", i: [3.1, -45], o: [37.1, -45] }
  };

  // src/ui/neon.ts
  var NUMBER = /-?\d*\.?\d+/g;
  var SPACE_ADVANCE = 34;
  var SHARED_BOOT = 8;
  var BOOT_LENGTH = 3.5;
  function fmt2(value) {
    return String(Math.round(value * 10) / 10);
  }
  function place(d, sx, sy, dx, dy) {
    let isX = true;
    return d.replace(NUMBER, (token) => {
      const value = Number(token) * (isX ? sx : sy) + (isX ? dx : dy);
      isX = !isX;
      return fmt2(value);
    });
  }
  function placeText(text, sx, sy, tracking, x, y) {
    const units = [[]];
    let pen = x;
    const chars = [...text];
    chars.forEach((char, index) => {
      if (char === " ") {
        if (chars[index + 1] !== "+" && units[units.length - 1].length) units.push([]);
        pen += SPACE_ADVANCE * sx + tracking;
        return;
      }
      const glyph = NEON_GLYPHS[char];
      if (!glyph) return;
      units[units.length - 1].push({
        lit: place(glyph.l, sx, sy, pen, y),
        dark: place(glyph.d, sx, sy, pen, y),
        entry: [glyph.i[0] * sx + pen, glyph.i[1] * sy + y],
        exit: [glyph.o[0] * sx + pen, glyph.o[1] * sy + y]
      });
      pen += glyph.a * sx + tracking;
    });
    return units.filter((unit) => unit.length > 0);
  }
  function inkBounds(units) {
    let left = Infinity;
    let right = -Infinity;
    for (const unit of units) {
      for (const glyph of unit) {
        glyph.lit.match(NUMBER)?.forEach((token, index) => {
          if (index % 2) return;
          const value = Number(token);
          if (value < left) left = value;
          if (value > right) right = value;
        });
      }
    }
    return [left, right];
  }
  function thread(units, baseline2, drop) {
    let lit = "";
    let dark = "";
    let boots = "";
    const rail = baseline2 + drop;
    for (const unit of units) {
      let previous = null;
      for (const glyph of unit) {
        if (previous) {
          dark += `M${fmt2(previous[0])} ${fmt2(previous[1])}V${fmt2(rail)}H${fmt2(glyph.entry[0])}V${fmt2(glyph.entry[1])}`;
        }
        lit += glyph.lit;
        dark += glyph.dark;
        previous = glyph.exit;
      }
      const start = unit[0].entry;
      const end = previous;
      const shared = Math.abs(end[0] - start[0]) < SHARED_BOOT;
      const bootAt = shared ? [(start[0] + end[0]) / 2] : [start[0], end[0]];
      dark += `M${fmt2(start[0])} ${fmt2(start[1])}V${fmt2(rail)}M${fmt2(end[0])} ${fmt2(end[1])}V${fmt2(rail)}`;
      if (shared) dark += `M${fmt2(start[0])} ${fmt2(rail)}H${fmt2(end[0])}`;
      for (const x of bootAt) boots += `M${fmt2(x)} ${fmt2(rail)}v${BOOT_LENGTH}`;
    }
    return { lit, dark, boots };
  }
  var SIGN_WIDTH = 360;
  var SIGN_HEIGHT = 70;
  var SIGN_FIT = {
    sped: { tracking: 7, margin: 30, wide: 1 },
    flat: { tracking: 7, margin: 10, wide: 1, level: true },
    chopped: { tracking: 2.5, margin: 2, wide: 1 },
    slowed: { tracking: 2.5, margin: 2, wide: 1 },
    memphis: { tracking: 3, margin: 6, wide: 1 },
    screwed: { tracking: 2.5, margin: 2, wide: 1 }
  };
  var CAP_HEIGHT = 100;
  var DESCENDER = 26;
  var LEVEL_GAP = 14;
  var UNDER = 9;
  function signLayout(id, name, height = SIGN_HEIGHT) {
    const fit = SIGN_FIT[id] ?? { tracking: 2, margin: 6, wide: 1 };
    const gaps = [...name].length - 1;
    const descends = /[pq]/.test(name);
    const room = height - 3;
    const sy = (descends ? Math.min(room - UNDER, room * CAP_HEIGHT / (CAP_HEIGHT + DESCENDER)) : room - UNDER) / CAP_HEIGHT;
    const [unitLeft, unitRight] = inkBounds(placeText(name, 1, sy, 0, 0, 0));
    const byWidth = (SIGN_WIDTH - fit.margin * 2 - fit.tracking * gaps) / (unitRight - unitLeft);
    const sx = Math.min(byWidth, sy * fit.wide);
    const baseline2 = 3 + CAP_HEIGHT * sy;
    const [left, right] = inkBounds(placeText(name, sx, sy, fit.tracking, 0, baseline2));
    const dx = (SIGN_WIDTH - (right - left)) / 2 - left;
    const units = placeText(name, sx, sy, fit.tracking, dx, baseline2);
    const layout = thread(units, baseline2, 3);
    if (fit.level) {
      const y = fmt2(baseline2 - 50 * sy);
      const start = fmt2(left + dx - LEVEL_GAP);
      const end = fmt2(right + dx + LEVEL_GAP);
      layout.lit += `M${fit.margin} ${y}H${start}M${end} ${y}H${SIGN_WIDTH - fit.margin}`;
      const rail = fmt2(baseline2 + 3);
      layout.dark += `M${fit.margin} ${y}V${rail}M${start} ${y}V${rail}M${end} ${y}V${rail}M${SIGN_WIDTH - fit.margin} ${y}V${rail}`;
      layout.boots += `M${fit.margin} ${rail}v${BOOT_LENGTH}M${start} ${rail}v${BOOT_LENGTH}M${end} ${rail}v${BOOT_LENGTH}M${SIGN_WIDTH - fit.margin} ${rail}v${BOOT_LENGTH}`;
    }
    return layout;
  }
  var NUMBER_WIDTH = 118;
  var NUMBER_HEIGHT = 42;
  var NUMBER_SX = 0.4;
  var NUMBER_SY = 0.33;
  var NUMBER_TRACKING = 0.5;
  var NUMBER_BASELINE = 33;
  function numberLayout(cents) {
    const text = cents === 0 ? "0" : `${cents < 0 ? "\u2212" : "+"}${Math.abs(cents)}`;
    const [, right] = inkBounds(placeText(text, NUMBER_SX, NUMBER_SY, NUMBER_TRACKING, 0, NUMBER_BASELINE));
    const units = placeText(text, NUMBER_SX, NUMBER_SY, NUMBER_TRACKING, NUMBER_WIDTH - right - 4, NUMBER_BASELINE);
    return thread(units, NUMBER_BASELINE, 2.5);
  }

  // src/ui/fonts.generated.ts
  var FONT_CSS = '@font-face{font-family:"SLAB Barlow";font-weight:500;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,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) format("woff2")}\n@font-face{font-family:"SLAB Barlow";font-weight:600;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,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) format("woff2")}\n@font-face{font-family:"SLAB Barlow";font-weight:700;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,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) format("woff2")}\n@font-face{font-family:"SLAB Barlow Tall";font-weight:700;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,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) format("woff2")}\n';

  // src/ui/styles.ts
  var STYLE_ID = "slab-styles";
  var CSS = `
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

  // src/ui/deck.ts
  var PITCH_LIMIT = 1200;
  var EVERY_MIN = 1;
  var EVERY_MAX = 16;
  var DEVICE_NAME_MAX = 56;
  var DEAD_LINE_CHARS = 58;
  var COMPACT_SIGN_HEIGHT = 50;
  var SPIN_MS = 1600;
  var ROLL_MS = 640;
  var TAGLINE = "Slow, loud and bangin\u2019";
  var PX_PER_CENT = 12 / 100;
  var RAIL_WIDTH = WHEEL_SIZE + PX_PER_CENT * PITCH_LIMIT * 2;
  var RULER_WIDTH = 360;
  var THUMB_SIZE = TYRE_RADIUS * 2;
  function railX(cents) {
    return WHEEL_SIZE / 2 + (cents + PITCH_LIMIT) * PX_PER_CENT;
  }
  function remoteDeviceName() {
    try {
      const device = Spicetify.Platform.ConnectAPI?.state?.activeDevice;
      return device && device.isLocal === false ? device.name ?? "another device" : null;
    } catch {
      return null;
    }
  }
  function deviceSentence(name) {
    if (name.length <= DEVICE_NAME_MAX) return `${name}.`;
    const cut = name.slice(0, DEVICE_NAME_MAX);
    const word = cut.lastIndexOf(" ");
    return `${(word > 12 ? cut.slice(0, word) : cut).trimEnd()}\u2026`;
  }
  function formatCents(cents) {
    if (cents === 0) return "0";
    return `${cents > 0 ? "+" : "\u2212"}${Math.abs(cents)}`;
  }
  function formatSemitones(cents) {
    const value = Math.abs(cents) / 100;
    const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return `${text} semitone${value === 1 ? "" : "s"}`;
  }
  function listWords(words) {
    if (words.length < 2) return words.join("");
    return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  }
  function capitalise(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  function reducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }
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
  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }
  function setAttr(node, name, value) {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }
  function setData(node, name, value) {
    if (node.dataset[name] !== value) node.dataset[name] = value;
  }
  function setOff(button, off) {
    setAttr(button, "aria-disabled", off ? "true" : "false");
  }
  function isOff(button) {
    return button.getAttribute("aria-disabled") === "true";
  }
  var MOODS_BY_PITCH = [...MOODS].sort(
    (a, b) => b.dsp.pitch - a.dsp.pitch || Number(b.id === "flat") - Number(a.id === "flat")
  );
  var Tube = class {
    constructor(className, width, height) {
      this.current = "";
      const box = `viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true" focusable="false"`;
      this.node = h("div", {
        class: `slab-tube ${className}`,
        html: `
<svg class="slab-tube-glass" ${box}>
  <g class="slab-tube-cast"><path data-l="shadowWide"/><path data-l="shadow"/></g>
  <path data-l="dark"/><path data-l="boots"/><path data-l="bootsHi"/>
  <g class="slab-tube-frosted"><path data-l="frost"/><path data-l="frostHi"/></g>
</svg>
<svg class="slab-tube-gas" ${box}>
  <path data-l="bloom"/><path data-l="halo"/><path data-l="glass"/><path data-l="core"/>
</svg>`
      });
      const find = (name) => this.node.querySelector(`[data-l="${name}"]`);
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
        core: find("core")
      };
      this.gas = this.node.querySelector(".slab-tube-gas");
    }
    set(layout) {
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
  };
  var Deck = class {
    constructor(state) {
      this.moodButtons = /* @__PURE__ */ new Map();
      this.moodClips = /* @__PURE__ */ new Map();
      this.moodFeet = /* @__PURE__ */ new Map();
      this.lamps = [];
      this.rulerKey = "";
      this.rulerBar = -2;
      this.pads = [];
      this.padTimers = /* @__PURE__ */ new Map();
      this.lastHelperState = null;
      this.disposed = false;
      this.disposeDsp = null;
      this.refreshTimer = null;
      this.chipTimer = null;
      this.activityTimer = null;
      this.rollTimer = null;
      this.lastGridUri = null;
      this.lastGridAttempt = 0;
      this.lastDspSync = 0;
      this.pitchTimer = null;
      this.pendingPitch = null;
      this.renderedCents = null;
      this.spinAnimation = null;
      this.strikeAnimation = null;
      this.spinning = false;
      this.modernEq = false;
      this.lastEqCheck = 0;
      this.lastRemote = null;
      this.onDocumentClick = (event) => this.handleOutside(event);
      this.onKey = (event) => this.handleKey(event);
      this.onResize = () => this.position();
      this.onScroll = () => this.renderScrollCue();
      this.state = state;
      this.chip = this.buildChip();
      this.tagEl = h("span", { class: "slab-tag" }, TAGLINE);
      this.signTube = new Tube("slab-sign-tube", SIGN_WIDTH, SIGN_HEIGHT);
      this.signEl = h("div", { class: "slab-sign", role: "img" }, this.signTube.node);
      this.subEl = h("p", { class: "slab-sub" });
      this.deadEl = h("p", { class: "slab-dead", "aria-live": "polite" });
      this.numberTube = new Tube("slab-number-tube", NUMBER_WIDTH, NUMBER_HEIGHT);
      this.semiEl = h("span", { class: "slab-semi" });
      this.nudgeDown = h("button", {
        class: "slab-press slab-nudge",
        type: "button",
        "aria-label": "Down 10 cents",
        onclick: () => {
          if (!isOff(this.nudgeDown)) this.setPitch(this.state.pitch - 10, false);
        }
      }, h("span", {}, "\u221210"));
      this.nudgeUp = h("button", {
        class: "slab-press slab-nudge",
        type: "button",
        "aria-label": "Up 10 cents",
        onclick: () => {
          if (!isOff(this.nudgeUp)) this.setPitch(this.state.pitch + 10, false);
        }
      }, h("span", {}, "+10"));
      this.normalButton = h("button", {
        class: "slab-press slab-normal",
        type: "button",
        "aria-label": "Back to normal pitch",
        onclick: () => {
          if (!isOff(this.normalButton)) this.setPitch(0, true);
        }
      }, h("span", {}, "Normal"));
      this.pitchInput = h("input", {
        class: "slab-range",
        id: "slab-pitch",
        type: "range",
        min: String(-PITCH_LIMIT),
        max: String(PITCH_LIMIT),
        step: "10",
        oninput: () => this.onPitchInput(false),
        onchange: () => this.onPitchInput(true)
      });
      this.hotUp = h("span", { class: "slab-rail-hot slab-rail-hot-up" });
      this.hotDown = h("span", { class: "slab-rail-hot slab-rail-hot-down" });
      this.runUp = h("span", { class: "slab-rail-run slab-rail-hot-up" });
      this.runDown = h("span", { class: "slab-rail-run slab-rail-hot-down" });
      this.spinEl = h("span", { class: "slab-spin", html: WHEEL_SPIN });
      this.rollEl = h("span", { class: "slab-roll" }, this.spinEl);
      this.wheelEl = h("span", { class: "slab-wheel", html: WHEEL_STATIC }, this.rollEl);
      this.railEl = this.buildRail();
      this.bpmEl = h("b", {}, "\u2013");
      this.barEl = h("span", { class: "slab-bar" }, "Bar \u2013");
      this.lampsEl = h("span", { class: "slab-lamps", role: "img", "aria-label": "No beat" });
      this.setLampCount(4);
      this.playEl = h("span", { class: "slab-play" }, "Paused");
      this.rulerEl = h("div", {
        class: "slab-ruler",
        "aria-hidden": "true",
        html: `<svg width="${RULER_WIDTH}" height="14" viewBox="0 0 ${RULER_WIDTH} 14" focusable="false"><path class="slab-ruler-dim"/></svg>
<div class="slab-ruler-clip"><svg width="${RULER_WIDTH}" height="14" viewBox="0 0 ${RULER_WIDTH} 14" focusable="false"><path class="slab-ruler-lit"/></svg></div>`
      });
      this.rulerDim = this.rulerEl.querySelector(".slab-ruler-dim");
      this.rulerLit = this.rulerEl.querySelector(".slab-ruler-lit");
      this.rulerClip = this.rulerEl.querySelector(".slab-ruler-clip");
      this.noGridEl = h("p", { class: "slab-nogrid", id: "slab-nogrid" });
      this.switchEl = h("button", {
        class: "slab-switch",
        type: "button",
        role: "switch",
        "aria-checked": String(state.auto),
        onclick: () => this.toggleAuto()
      }, h("span", { class: "slab-switch-track" }, h("i")), h("span", { class: "slab-auto-title" }, "Auto chop"));
      this.everyEl = h("span", { class: "slab-every", "aria-live": "polite" });
      this.everyDown = h("button", {
        class: "slab-press slab-step",
        type: "button",
        "aria-label": "Chop more often",
        onclick: () => {
          if (!isOff(this.everyDown)) this.setEvery(this.state.every - 1);
        }
      }, h("span", {}, "\u2212"));
      this.everyUp = h("button", {
        class: "slab-press slab-step",
        type: "button",
        "aria-label": "Chop less often",
        onclick: () => {
          if (!isOff(this.everyUp)) this.setEvery(this.state.every + 1);
        }
      }, h("span", {}, "+"));
      this.eqNoteText = h("span", { class: "slab-eq-text" });
      this.eqNoteButton = h("button", {
        class: "slab-press slab-eq-btn",
        type: "button",
        onclick: (event) => {
          event.stopPropagation();
          this.toggleEqOwner();
        }
      }, h("span", {}, "Use SLAB EQ"));
      this.eqNote = h("div", { class: "slab-eq" }, this.eqNoteText, this.eqNoteButton);
      this.eqNote.hidden = true;
      this.helperEl = h("p", { class: "slab-status" }, "Looking for the helper.");
      this.speedEl = h("p", { class: "slab-status" });
      this.statusEl = h("span", { class: "slab-sr", role: "status", "aria-live": "polite" });
      this.modernEq = modernEqPresent();
      this.panel = this.buildPanel();
      onChop((event) => {
        this.flashActivity(event.label);
        if (event.kind === "auto") this.hitPad(this.pads[0]);
      });
    }
    mount() {
      this.injectStyles();
      this.mountChip();
      document.body.append(this.panel);
      document.addEventListener("click", this.onDocumentClick, true);
      document.addEventListener("keydown", this.onKey);
      window.addEventListener("resize", this.onResize);
      this.panel.addEventListener("scroll", this.onScroll, { passive: true });
      if (this.state.open) this.open();
      else this.panel.hidden = true;
      this.renderMoodState();
      this.renderAutoState();
      this.renderPitch();
      this.renderEqNote();
      if (this.modernEq && !this.slabOwnsEq()) void this.restoreModernEqCurve();
      let wasLinked = false;
      this.disposeDsp = onDspChange((status2) => {
        this.renderDsp();
        if (status2.linked && !wasLinked) {
          void sendDsp({ ...moodById(this.state.moodId).dsp, pitch: this.state.pitch });
        }
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
      this.disposed = true;
      if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
      if (this.chipTimer !== null) window.clearInterval(this.chipTimer);
      if (this.activityTimer !== null) window.clearTimeout(this.activityTimer);
      if (this.rollTimer !== null) window.clearTimeout(this.rollTimer);
      if (this.pitchTimer !== null) window.clearTimeout(this.pitchTimer);
      for (const timer of this.padTimers.values()) window.clearTimeout(timer);
      this.padTimers.clear();
      this.spinAnimation?.cancel();
      this.spinAnimation = null;
      this.spinning = false;
      this.strikeAnimation?.cancel();
      this.strikeAnimation = null;
      document.removeEventListener("click", this.onDocumentClick, true);
      document.removeEventListener("keydown", this.onKey);
      window.removeEventListener("resize", this.onResize);
      this.panel.removeEventListener("scroll", this.onScroll);
      this.chip.remove();
      this.panel.remove();
      document.getElementById(STYLE_ID)?.remove();
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
    /** An older copy that stood aside may have left its sheet behind; this one wins. */
    injectStyles() {
      const existing = document.getElementById(STYLE_ID);
      if (existing) {
        if (existing.textContent !== CSS) existing.textContent = CSS;
        return;
      }
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
    /** Spotify rebuilds the playbar on some navigation, so put the chip back. */
    ensureChip() {
      if (this.chip.isConnected) return;
      this.mountChip();
    }
    buildChip() {
      const chip = h("button", {
        class: "slab-chip",
        type: "button",
        "aria-label": "SLAB playback moods",
        "aria-expanded": "false",
        title: "SLAB, Third Coast playback moods",
        onclick: (event) => {
          event.stopPropagation();
          this.toggle(event.detail === 0);
        }
      });
      chip.innerHTML = CHIP_ICON;
      return chip;
    }
    /**
     * The tube, its marks and the wheel. Everything takes its x from railX, which
     * is the same line the native range thumb travels, so a tick, a clip and the
     * wheel's centre can only ever agree.
     */
    buildRail() {
      let ticks = "";
      for (let cents = -PITCH_LIMIT; cents <= PITCH_LIMIT; cents += 100) {
        const major = cents % PITCH_LIMIT === 0;
        const x = railX(cents);
        ticks += major ? `<rect x="${x - 1}" y="1" width="2" height="9"/>` : `<rect x="${x - 0.5}" y="2" width="1" height="4"/>`;
      }
      const rail = h("div", { class: "slab-rail" });
      rail.style.width = `${RAIL_WIDTH}px`;
      const tube = h("span", { class: "slab-rail-tube" });
      tube.style.left = `${railX(-PITCH_LIMIT)}px`;
      tube.style.width = `${railX(PITCH_LIMIT) - railX(-PITCH_LIMIT)}px`;
      this.hotUp.style.left = `${railX(0)}px`;
      this.hotUp.style.width = `${railX(PITCH_LIMIT) - railX(0)}px`;
      this.hotDown.style.left = `${railX(-PITCH_LIMIT)}px`;
      this.hotDown.style.width = `${railX(0) - railX(-PITCH_LIMIT)}px`;
      this.runUp.style.left = this.hotUp.style.left;
      this.runUp.style.width = this.hotUp.style.width;
      this.runDown.style.left = this.hotDown.style.left;
      this.runDown.style.width = this.hotDown.style.width;
      rail.append(tube, this.hotDown, this.hotUp);
      const line = h("span", { class: "slab-rail-line" });
      line.style.left = tube.style.left;
      line.style.width = tube.style.width;
      const marks = h(
        "div",
        { class: "slab-rail-marks" },
        h("span", {
          class: "slab-rail-ticks",
          html: `<svg width="${RAIL_WIDTH}" height="11" viewBox="0 0 ${RAIL_WIDTH} 11" aria-hidden="true" focusable="false">${ticks}</svg>`
        }),
        line,
        this.runDown,
        this.runUp
      );
      for (const mood of MOODS) {
        const cents = mood.dsp.pitch;
        if (this.moodClips.has(cents)) continue;
        const clip = h("span", { class: "slab-clip" });
        clip.style.left = `${railX(cents)}px`;
        this.moodClips.set(cents, clip);
        rail.append(clip);
        const foot = h("span", { class: "slab-clip-foot" });
        foot.style.left = clip.style.left;
        this.moodFeet.set(cents, foot);
        marks.append(foot);
      }
      this.pitchInput.style.left = `${(WHEEL_SIZE - THUMB_SIZE) / 2}px`;
      this.pitchInput.style.width = `${RAIL_WIDTH - (WHEEL_SIZE - THUMB_SIZE)}px`;
      rail.append(this.pitchInput, this.wheelEl, marks);
      return rail;
    }
    buildPanel() {
      const panel = h("div", {
        class: "slab-panel",
        role: "dialog",
        "aria-label": "SLAB playback moods",
        "data-gas": "on",
        "data-tube": "off",
        "data-primer": "false",
        "data-grid": "false"
      });
      panel.hidden = true;
      this.chip.dataset.remote = "false";
      const close = h("button", {
        class: "slab-close",
        type: "button",
        "aria-label": "Close SLAB",
        html: CLOSE_ICON,
        onclick: () => this.close()
      });
      const head = h("div", { class: "slab-head" }, h("span", { html: EMBLEM, class: "slab-badge" }), this.tagEl, close);
      const scale = h(
        "div",
        { class: "slab-scale" },
        h("span", { class: "slab-scale-end", style: `left:${railX(-PITCH_LIMIT)}px` }, "Octave down"),
        this.normalButton,
        h("span", { class: "slab-scale-end", style: `left:${railX(PITCH_LIMIT)}px` }, "Octave up")
      );
      this.normalButton.style.left = `${railX(0)}px`;
      const stage = h("div", { class: "slab-stage" }, this.signEl, this.subEl, this.deadEl);
      const pitchHead = h(
        "div",
        { class: "slab-pitch-head" },
        h(
          "div",
          { class: "slab-pitch-words" },
          h("label", { class: "slab-pitch-label", for: "slab-pitch" }, "Pitch in cents"),
          this.semiEl
        ),
        this.numberTube.node,
        h("div", { class: "slab-nudges" }, this.nudgeDown, this.nudgeUp)
      );
      const bay = h("div", { class: "slab-bay" }, stage, pitchHead, this.railEl, scale);
      const trim = h("div", { class: "slab-trim" }, bay);
      const moodGrid = h("div", {
        class: "slab-moods",
        role: "radiogroup",
        "aria-label": "Mood",
        onkeydown: (event) => this.handleMoodKey(event)
      });
      for (const mood of MOODS_BY_PITCH) {
        const button = h("button", {
          class: "slab-mood",
          type: "button",
          role: "radio",
          "data-mood": mood.id,
          "aria-checked": "false",
          tabindex: "-1",
          onclick: () => void this.applyMood(mood.id, true)
        });
        button.innerHTML = `
        <span class="slab-mood-name">${mood.name}</span>
        <span class="slab-mood-cents">${formatCents(mood.dsp.pitch)}</span>
        <svg class="slab-mood-curve" viewBox="0 0 58 32" width="58" height="32" aria-hidden="true" focusable="false">
          <path class="slab-mood-zero" d="M0 16H58"/>
          <path class="slab-mood-line" d="${curvePath(mood.gains, 58, 32)}"/>
        </svg>`;
        this.moodButtons.set(mood.id, button);
        moodGrid.append(button);
      }
      const readout = h(
        "div",
        { class: "slab-read" },
        h(
          "div",
          { class: "slab-read-top" },
          h("span", { class: "slab-bpm" }, this.bpmEl, h("small", {}, "BPM")),
          h("span", { class: "slab-count" }, this.barEl, this.lampsEl),
          this.playEl
        ),
        h("div", { class: "slab-ruler-slot" }, this.rulerEl, this.noGridEl)
      );
      const padRow = h("div", { class: "slab-pads", role: "group", "aria-label": "Beat-synced edits" });
      const padDefs = [
        { id: "chop", label: "Chop", sub: "1 bar", run: () => void chopBars(1) },
        { id: "screw", label: "Screw", sub: "2 bars", run: () => void chopBars(2) },
        { id: "spin", label: "Spin", sub: "4 bars", run: () => void chopBars(4) },
        { id: "loop", label: "Loop", sub: "4x bar", run: () => void loopBars(4) },
        {
          id: "stop",
          label: "Stop",
          sub: "Tape stop",
          run: () => {
            const linked = dspStatus().linked;
            if (linked) void dspTapeStop();
            void tapeStop(linked ? { fade: false, pauseDelayMs: 470 } : void 0);
          }
        }
      ];
      for (const def of padDefs) {
        const pad = h("button", {
          class: "slab-press slab-pad",
          type: "button",
          "data-pad": def.id,
          onclick: (event) => {
            event.stopPropagation();
            if (isOff(pad)) return;
            this.hitPad(pad);
            def.run();
          }
        }, h("b", {}, def.label), h("small", {}, def.sub));
        this.pads.push(pad);
        padRow.append(pad);
      }
      const auto = h(
        "div",
        { class: "slab-auto" },
        this.switchEl,
        h("div", { class: "slab-stepper" }, this.everyDown, this.everyEl, this.everyUp)
      );
      const sill = h(
        "div",
        { class: "slab-sill", html: SILL_SCREWS },
        h("div", { class: "slab-sill-plate" }, this.eqNote, this.helperEl, this.speedEl)
      );
      const lower = h("div", { class: "slab-lower" }, readout, padRow, auto);
      const body = h("div", { class: "slab-body" }, head, trim, moodGrid, lower, sill);
      panel.append(h("div", { class: "slab-lip slab-lip-top" }), body, h("div", { class: "slab-lip slab-lip-end" }), this.statusEl);
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
      if (!isOff(this.pads[index - 1])) this.pads[index - 1].click();
    }
    /** Radiogroup keys, matching the grid: sideways is one mood, up and down a whole row. */
    handleMoodKey(event) {
      const order = MOODS_BY_PITCH.map((mood) => mood.id);
      const from = order.indexOf(moodById(this.state.moodId).id);
      let to;
      switch (event.key) {
        case "ArrowRight":
          to = (from + 1) % order.length;
          break;
        case "ArrowLeft":
          to = (from - 1 + order.length) % order.length;
          break;
        case "ArrowDown":
          to = (from + 2) % order.length;
          break;
        case "ArrowUp":
          to = (from - 2 + order.length) % order.length;
          break;
        case "Home":
          to = 0;
          break;
        case "End":
          to = order.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      void this.applyMood(order[to], true);
      this.moodButtons.get(order[to])?.focus();
    }
    toggle(fromKeyboard = false) {
      if (this.panel.hidden) this.open(fromKeyboard);
      else this.close();
    }
    /** Boot restores an open panel without taking focus; only a key press moves it. */
    open(fromKeyboard = false) {
      this.panel.hidden = false;
      this.state.open = true;
      saveState(this.state);
      this.chip.setAttribute("aria-expanded", "true");
      this.position();
      this.renderMoodState();
      this.refresh();
      if (fromKeyboard) this.moodButtons.get(moodById(this.state.moodId).id)?.focus();
    }
    close() {
      if (this.panel.contains(document.activeElement) && this.chip.isConnected) this.chip.focus();
      this.panel.hidden = true;
      this.state.open = false;
      saveState(this.state);
      this.chip.setAttribute("aria-expanded", "false");
      this.updateSpin();
    }
    /**
     * Above the chip, then below it, then beside it, so a short window never opens
     * the panel over the button that closes it. The CSS caps height to the window.
     */
    position() {
      if (this.panel.hidden) return;
      const rect = this.chip.getBoundingClientRect();
      const width = this.panel.offsetWidth || 400;
      const height = this.panel.offsetHeight || 680;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      const maxTop = Math.max(8, window.innerHeight - height - 8);
      let left = Math.max(8, Math.min(maxLeft, rect.right - width));
      let top = rect.top - height - 10;
      if (top < 8) {
        top = rect.bottom + 10;
        if (top > maxTop) {
          top = Math.max(8, Math.min(maxTop, rect.bottom - height));
          if (rect.left - width - 10 >= 8) left = rect.left - width - 10;
          else if (rect.right + 10 <= maxLeft) left = rect.right + 10;
        }
      }
      this.panel.style.left = `${Math.round(left)}px`;
      this.panel.style.top = `${Math.round(top)}px`;
      this.renderScrollCue();
    }
    /** Only when a short window has hidden part of the panel. Writes only on change. */
    renderScrollCue() {
      const hidden = this.panel.scrollHeight - this.panel.clientHeight;
      setData(this.panel, "more", hidden - this.panel.scrollTop > 2 ? "true" : "false");
      setData(this.panel, "above", this.panel.scrollTop > 2 ? "true" : "false");
    }
    async applyMood(id, announce) {
      this.state.moodId = id;
      const mood = moodById(id);
      if (announce) this.state.pitch = mood.dsp.pitch;
      saveState(this.state);
      this.renderMoodState();
      this.renderPitch(announce);
      this.renderDsp();
      if (announce) this.strikeSign();
      this.chip.dataset.on = id !== "flat" ? "true" : "false";
      if (this.slabOwnsEq()) {
        if (id === "flat") await restoreBaseline();
        else await applyCurve(mood.gains);
      }
      void sendDsp({ ...mood.dsp, pitch: this.state.pitch });
      if (announce) this.flashActivity(mood.name);
    }
    /** The one flourish: a neon sign catching as the gas strikes. */
    strikeSign() {
      if (reducedMotion() || this.panel.hidden || this.panel.dataset.gas !== "on") return;
      this.strikeAnimation?.cancel();
      this.strikeAnimation = this.signTube.gas.animate(
        [
          { opacity: 0.1, offset: 0 },
          { opacity: 1, offset: 0.16 },
          { opacity: 0.28, offset: 0.3 },
          { opacity: 1, offset: 0.46 },
          { opacity: 1, offset: 1 }
        ],
        { duration: 420, easing: "linear" }
      );
    }
    /**
     * Pitch is the one control people actually want, so it gets a real slider.
     * Dragging fires every frame; the helper is throttled to ~90 ms of updates
     * and the last value always wins on release.
     */
    onPitchInput(commit) {
      const cents = Number.parseInt(this.pitchInput.value, 10);
      if (!Number.isFinite(cents)) return;
      this.state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.round(cents / 10) * 10));
      this.renderPitch();
      this.pendingPitch = this.state.pitch;
      if (commit) {
        this.flushPitch(true);
        return;
      }
      if (this.pitchTimer !== null) return;
      this.pitchTimer = window.setTimeout(() => this.flushPitch(false), 90);
    }
    /** Nudges and Normal, which arrive as one committed value. */
    setPitch(cents, roll) {
      this.state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, cents));
      this.renderPitch(roll);
      this.pendingPitch = this.state.pitch;
      this.flushPitch(true);
    }
    flushPitch(persist) {
      if (this.pitchTimer !== null) {
        window.clearTimeout(this.pitchTimer);
        this.pitchTimer = null;
      }
      const value = this.pendingPitch;
      this.pendingPitch = null;
      if (value === null) return;
      void sendDsp({ pitch: value });
      if (persist) saveState(this.state);
    }
    /**
     * The wheel's rotation is a function of where it sits, so it always rolls the
     * exact distance it travels, whether dragged or sent there by a mood. With
     * `roll` both moves and the bright tube ride the same CSS transition.
     */
    renderPitch(roll = false) {
      const cents = this.state.pitch;
      const status2 = dspStatus();
      const linked = status2.linked;
      const applied = linked && status2.tapping === true && status2.audio === true && !remoteDeviceName();
      if (this.pitchInput.value !== String(cents)) this.pitchInput.value = String(cents);
      if (!linked && document.activeElement === this.pitchInput) this.normalButton.focus();
      if (this.pitchInput.disabled === linked) this.pitchInput.disabled = !linked;
      setOff(this.nudgeDown, !linked || cents <= -PITCH_LIMIT);
      setOff(this.nudgeUp, !linked || cents >= PITCH_LIMIT);
      setOff(this.normalButton, !linked);
      setAttr(
        this.railEl,
        "title",
        linked ? "Pitch shift applied to Spotify's audio by the SLAB helper." : "Pitch needs the SLAB helper running. The browser cannot repitch a DRM-protected stream."
      );
      setText(
        this.semiEl,
        !linked ? "Pitch needs the helper" : cents === 0 ? "Original key" : `${applied ? "" : "Set to "}${formatSemitones(cents)} ${cents < 0 ? "down" : "up"}`
      );
      if (this.renderedCents === cents) return;
      const first = this.renderedCents === null;
      this.renderedCents = cents;
      setAttr(
        this.pitchInput,
        "aria-valuetext",
        cents === 0 ? "Normal pitch, 0 cents" : `${Math.abs(cents)} cents ${cents < 0 ? "down" : "up"}, ${formatSemitones(cents)}`
      );
      this.numberTube.set(numberLayout(cents));
      if (roll && !first && !reducedMotion()) {
        this.railEl.dataset.rolling = "true";
        if (this.rollTimer !== null) window.clearTimeout(this.rollTimer);
        this.rollTimer = window.setTimeout(() => {
          delete this.railEl.dataset.rolling;
          this.rollTimer = null;
        }, ROLL_MS + 60);
      } else if (this.rollTimer === null) {
        delete this.railEl.dataset.rolling;
      }
      const x = railX(cents) - WHEEL_SIZE / 2;
      const turned = x / TYRE_RADIUS * (180 / Math.PI);
      this.wheelEl.style.transform = `translateX(${x}px)`;
      this.rollEl.style.transform = `rotate(${turned.toFixed(1)}deg)`;
      const reach = Math.abs(cents) / PITCH_LIMIT;
      this.hotUp.style.transform = `scaleX(${cents > 0 ? reach : 0})`;
      this.hotDown.style.transform = `scaleX(${cents < 0 ? reach : 0})`;
      this.runUp.style.transform = this.hotUp.style.transform;
      this.runDown.style.transform = this.hotDown.style.transform;
      if (this.spinAnimation) this.spinAnimation.playbackRate = 2 ** (cents / 1200);
    }
    /**
     * The spokes turn only while this computer is making the sound being shifted.
     * A long-lived animation with a playback rate, so a pitch change speeds the
     * wheel up in place instead of snapping it back to the start of a turn.
     */
    updateSpin() {
      if (this.disposed) return;
      const status2 = dspStatus();
      const should = !this.panel.hidden && isPlaying() && status2.linked === true && status2.tapping === true && status2.audio === true && !remoteDeviceName() && !reducedMotion();
      if (should === this.spinning) return;
      this.spinning = should;
      if (!should) {
        this.spinAnimation?.pause();
        return;
      }
      if (!this.spinAnimation) {
        this.spinAnimation = this.spinEl.animate(
          [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
          { duration: SPIN_MS, iterations: Infinity, easing: "linear" }
        );
        this.spinAnimation.playbackRate = 2 ** (this.state.pitch / 1200);
      }
      this.spinAnimation.play();
    }
    /** True when SLAB is allowed to write the six native EQ bands. */
    slabOwnsEq() {
      if (this.state.eqOwner === "slab") return true;
      if (this.state.eqOwner === "modern") return false;
      return !this.modernEq;
    }
    toggleEqOwner() {
      this.state.eqOwner = this.slabOwnsEq() ? "modern" : "slab";
      saveState(this.state);
      this.renderEqNote();
      this.renderDsp();
      if (this.slabOwnsEq()) void applyCurve(moodById(this.state.moodId).gains);
      else void this.restoreModernEqCurve();
      this.flashActivity(this.slabOwnsEq() ? "SLAB has the EQ" : "ModernEQ has the EQ");
    }
    /** With no ModernEQ the row goes and the sill's fixed height re-centres the rest. */
    renderEqNote() {
      if (!this.modernEq) {
        this.eqNote.hidden = true;
        return;
      }
      this.eqNote.hidden = false;
      const label = this.eqNoteButton.firstElementChild;
      if (this.slabOwnsEq()) {
        setText(this.eqNoteText, "SLAB has the EQ.");
        setText(label, "Use ModernEQ");
      } else {
        setText(this.eqNoteText, "ModernEQ has the EQ.");
        setText(label, "Use SLAB EQ");
      }
    }
    /** Hand the bands back with the curve ModernEQ last saved. */
    async restoreModernEqCurve() {
      const bands = modernEqBands();
      if (!bands) return;
      await applyCurveAtFrequencies(bands);
    }
    /** ModernEQ can appear after SLAB does; re-check slowly, not every tick. */
    refreshEqOwner() {
      const now = Date.now();
      if (now - this.lastEqCheck < 2e3) return;
      this.lastEqCheck = now;
      const present = modernEqPresent();
      if (present === this.modernEq) return;
      this.modernEq = present;
      this.renderEqNote();
      this.renderDsp();
      if (this.slabOwnsEq()) void applyCurve(moodById(this.state.moodId).gains);
      else void this.restoreModernEqCurve();
    }
    /**
     * The panel states what is true now, including the cases where SLAB is doing
     * nothing audible: the EQ and the tap both only reach audio on this computer.
     * The sign is lit while the mood has a way into the sound, by the EQ or by a
     * helper with audio flowing. The pitch tube is lit only while the helper is
     * shifting audio, and sits idle while it is running with nothing to shift. The
     * paint only goes when the sound has left the room.
     */
    renderDsp() {
      const status2 = dspStatus();
      const remote = remoteDeviceName();
      const processing = status2.linked && status2.tapping === true && status2.audio === true && !remote;
      setData(this.panel, "primer", remote ? "true" : "false");
      setData(this.panel, "gas", !remote && (this.slabOwnsEq() || processing) ? "on" : "off");
      setData(this.panel, "tube", remote || !status2.linked ? "off" : processing ? "on" : "idle");
      setData(this.chip, "remote", remote ? "true" : "false");
      if (remote) {
        setText(this.deadEl, `Playing on ${deviceSentence(remote)} SLAB only reaches this computer.`);
        setAttr(this.deadEl, "title", `Playing on ${remote}. Moods, pitch and effects apply when Spotify plays here.`);
      } else {
        setText(this.deadEl, "");
        this.deadEl.removeAttribute("title");
      }
      this.renderSign();
      this.renderHelperLine();
      this.renderPitch();
      this.updateSpin();
    }
    /** What the helper is doing, built from the parameters actually sent to it. */
    helperLine() {
      const status2 = dspStatus();
      if (remoteDeviceName()) {
        return {
          state: "remote",
          text: status2.linked ? "Helper has nothing to process until this computer plays." : "Helper isn't running.",
          title: "The EQ and the helper only touch audio on this computer."
        };
      }
      if (!status2.linked) {
        return {
          state: "offline",
          text: this.slabOwnsEq() ? "Helper isn't running, so SLAB only shapes the EQ." : "Helper isn't running, so SLAB isn't changing the sound.",
          title: "Run the SLAB helper to get real pitch, reverb and delay. Without it SLAB only shapes the native EQ."
        };
      }
      if (!status2.tapping) {
        return {
          state: "waiting",
          text: "Helper is waiting for Spotify to open an audio stream.",
          title: "The SLAB helper is running and will attach as soon as Spotify opens an audio stream."
        };
      }
      if (!status2.audio) {
        return {
          state: "silent",
          text: "Helper is attached. No audio coming through yet.",
          title: "The SLAB helper is attached to Spotify and nothing is playing here yet."
        };
      }
      const dsp = moodById(this.state.moodId).dsp;
      const behind = typeof status2.latencyMs === "number" ? `, ${Math.round(status2.latencyMs)} ms behind` : "";
      const effects = [
        ...this.state.pitch !== 0 ? ["pitch"] : [],
        ...dsp.reverb > 0 ? ["reverb"] : [],
        ...dsp.delayMix > 0 ? ["delay"] : []
      ];
      const doing = effects.length === 0 ? "live and dry" : effects.length === 1 && effects[0] === "pitch" ? "shifting pitch" : `running ${listWords(effects)}`;
      return {
        state: "live",
        text: `Helper is ${doing}${behind}.`,
        title: "The SLAB helper is running and processing Spotify's audio."
      };
    }
    /** Runs from the refresh loop so the latency and the mood can't go stale. */
    renderHelperLine() {
      const { state, text, title } = this.helperLine();
      setText(this.helperEl, text);
      setAttr(this.helperEl, "title", title);
      if (this.lastHelperState !== null && this.lastHelperState !== state) this.announce(text);
      this.lastHelperState = state;
    }
    announce(text) {
      setText(this.statusEl, text);
    }
    /** Playback can move to another device at any moment. */
    refreshConnect() {
      const remote = remoteDeviceName();
      if (remote === this.lastRemote) return;
      this.lastRemote = remote;
      this.renderDsp();
    }
    renderMoodState() {
      const mood = moodById(this.state.moodId);
      for (const [id, button] of this.moodButtons) {
        const selected = id === mood.id;
        setAttr(button, "aria-checked", selected ? "true" : "false");
        setAttr(button, "tabindex", selected ? "0" : "-1");
      }
      for (const [cents, clip] of this.moodClips) {
        setData(clip, "lit", cents === mood.dsp.pitch ? "true" : "false");
      }
      for (const [cents, foot] of this.moodFeet) {
        setData(foot, "lit", cents === mood.dsp.pitch ? "true" : "false");
      }
      this.renderSign();
      setAttr(this.signEl, "aria-label", `Mood: ${mood.name}`);
      setText(this.subEl, capitalise(mood.sub));
      this.chip.dataset.on = mood.id !== "flat" ? "true" : "false";
      setAttr(this.chip, "aria-label", mood.id === "flat" ? "SLAB playback moods, no mood on" : `SLAB playback moods, ${mood.name} on`);
    }
    /** The tube keeps its gauge at any size; two lines of message get the sign's lower part. */
    renderSign() {
      const mood = moodById(this.state.moodId);
      const compact = (this.deadEl.textContent ?? "").length > DEAD_LINE_CHARS;
      this.signTube.set(signLayout(mood.id, mood.name, compact ? COMPACT_SIGN_HEIGHT : SIGN_HEIGHT));
    }
    toggleAuto() {
      this.state.auto = !this.state.auto;
      saveState(this.state);
      this.renderAutoState();
      this.flashActivity(this.state.auto ? "Auto chop on" : "Auto chop off");
    }
    setEvery(every) {
      const next = Math.max(EVERY_MIN, Math.min(EVERY_MAX, every));
      if (next === this.state.every) return;
      this.state.every = next;
      saveState(this.state);
      this.renderAutoState();
    }
    renderAutoState() {
      const every = this.state.every;
      setAttr(this.switchEl, "aria-checked", String(this.state.auto));
      setText(this.everyEl, `Every ${every} bar${every === 1 ? "" : "s"}`);
      setOff(this.everyDown, every <= EVERY_MIN);
      setOff(this.everyUp, every >= EVERY_MAX);
      setAuto(this.state.auto, every);
    }
    /** Activity borrows the tagline's slot, so nothing else in the panel moves. */
    flashActivity(text) {
      this.tagEl.textContent = text;
      this.tagEl.dataset.flash = "true";
      this.announce(text);
      if (this.activityTimer !== null) window.clearTimeout(this.activityTimer);
      this.activityTimer = window.setTimeout(() => {
        this.tagEl.textContent = TAGLINE;
        delete this.tagEl.dataset.flash;
      }, 1800);
    }
    /** A press lights on the way down; a keyboard or auto hit lights for a moment. */
    hitPad(pad) {
      if (!pad) return;
      pad.dataset.hit = "true";
      const running2 = this.padTimers.get(pad);
      if (running2 !== void 0) window.clearTimeout(running2);
      this.padTimers.set(pad, window.setTimeout(() => {
        delete pad.dataset.hit;
        this.padTimers.delete(pad);
      }, 180));
    }
    /**
     * The helper can restart with neutral parameters, and a linked/unlinked
     * transition is not guaranteed to be observed. Compare what it reports
     * against the selected mood and correct it, throttled.
     */
    syncDspParams() {
      const status2 = dspStatus();
      if (!status2.linked) return;
      const now = Date.now();
      if (now - this.lastDspSync < 3e3) return;
      const want = { ...moodById(this.state.moodId).dsp, pitch: this.state.pitch };
      const have = status2.params ?? {};
      const drifted = Math.abs((have.pitch ?? 0) - want.pitch) > 1 || Math.abs((have.reverb ?? 0) - want.reverb) > 1 || Math.abs((have.lowpass ?? 2e4) - want.lowpass) > 50;
      if (!drifted) return;
      this.lastDspSync = now;
      void sendDsp(want);
    }
    async syncGrid(force = false) {
      const uri = Spicetify.Player.data?.item?.uri;
      if (!uri) return;
      if (!force && uri === this.lastGridUri && gridFor(uri)) return;
      this.lastGridUri = uri;
      this.lastGridAttempt = Date.now();
      await loadGrid(uri);
      if (!this.disposed) this.refresh();
    }
    /**
     * One tick per real bar at its real time, every fourth taller, closing on the
     * track's end. A track too long for that at two pixels a tick draws every
     * fourth bar instead, or every sixteenth, and the title says so.
     */
    buildRuler(grid) {
      const key = `${grid.uri}:${grid.bars.length}`;
      if (key === this.rulerKey) return;
      this.rulerKey = key;
      this.rulerBar = -2;
      const span = grid.durationMs || grid.bars[grid.bars.length - 1] || 1;
      let every = 1;
      while (RULER_WIDTH / grid.bars.length * every < 2) every *= 4;
      let d = "";
      grid.bars.forEach((start, index) => {
        if (index % every !== 0) return;
        const x = Math.min(RULER_WIDTH - 0.5, Math.round(start / span * (RULER_WIDTH - 1)) + 0.5);
        d += `M${x} ${index % (every * 4) === 0 ? 1 : 7}V14`;
      });
      d += `M${RULER_WIDTH - 0.5} 1V14`;
      setAttr(this.rulerEl, "title", every > 1 ? `One tick for every ${every} bars on a track this long.` : "");
      this.rulerDim.setAttribute("d", d);
      this.rulerLit.setAttribute("d", d);
    }
    setLampCount(count) {
      if (this.lamps.length === count) return;
      this.lamps = [];
      this.lampsEl.textContent = "";
      for (let i = 0; i < count; i++) {
        const lamp = h("i");
        this.lamps.push(lamp);
        this.lampsEl.append(lamp);
      }
    }
    renderLamps(active) {
      this.lamps.forEach((lamp, index) => setData(lamp, "on", index === active ? "true" : "false"));
    }
    refresh() {
      if (this.disposed) return;
      void probeDsp();
      if (!gridFor() && Date.now() - this.lastGridAttempt > 5e3) {
        void this.syncGrid(true);
      }
      this.syncDspParams();
      this.refreshEqOwner();
      this.refreshConnect();
      this.updateSpin();
      if (this.panel.hidden) return;
      this.renderHelperLine();
      const playing = isPlaying();
      setData(this.panel, "playing", playing ? "true" : "false");
      setText(this.playEl, playing ? "Playing" : "Paused");
      const grid = gridFor();
      setData(this.panel, "grid", grid ? "true" : "false");
      if (!grid) {
        setText(this.bpmEl, "\u2013");
        setText(this.barEl, "Bar \u2013");
        setText(this.noGridEl, "No beat grid for this track, so only Stop works.");
        setAttr(this.lampsEl, "aria-label", "No beat");
        this.setLampCount(4);
        this.renderLamps(-1);
      } else {
        const progress = progressMs();
        const bar = barIndexAt(grid, progress);
        const beat = beatIndexAt(grid, progress);
        const total = barCount(grid);
        const beatsPerBar = Math.max(1, grid.timeSignature || 4);
        const beatInBar = ((beat - Math.max(0, bar) * beatsPerBar) % beatsPerBar + beatsPerBar) % beatsPerBar;
        setText(this.bpmEl, grid.tempo > 0 ? grid.tempo.toFixed(1) : "\u2013");
        setText(this.barEl, `Bar ${Math.max(1, bar + 1)} of ${total}`);
        setText(this.noGridEl, "");
        this.setLampCount(Math.min(7, beatsPerBar));
        this.renderLamps(beatInBar);
        setAttr(this.lampsEl, "aria-label", `Beat ${beatInBar + 1} of ${beatsPerBar}`);
        this.buildRuler(grid);
        if (bar !== this.rulerBar) {
          this.rulerBar = bar;
          const span = grid.durationMs || 1;
          const start = grid.bars[Math.max(0, bar)] ?? 0;
          const lit = bar < 0 ? 0 : Math.min(RULER_WIDTH, Math.round(start / span * (RULER_WIDTH - 1)) + 1);
          this.rulerClip.style.clipPath = `inset(0 ${RULER_WIDTH - lit}px 0 0)`;
        }
      }
      const speed = this.speedInfo();
      setText(this.speedEl, speed.text);
      setAttr(this.speedEl, "title", speed.hint);
      for (const pad of this.pads) {
        const off = pad.dataset.pad !== "stop" && !grid;
        setOff(pad, off);
        if (off) setAttr(pad, "aria-describedby", "slab-nogrid");
        else if (pad.hasAttribute("aria-describedby")) pad.removeAttribute("aria-describedby");
      }
    }
    /** The speed lock only explains anything while the helper is absent; otherwise it's noise. */
    speedInfo() {
      const dsp = dspStatus();
      const remote = remoteDeviceName();
      if (dsp.linked && dsp.tapping && dsp.audio && !remote) {
        return {
          text: this.state.pitch === 0 ? "Tempo is untouched." : "Tempo stays the same.",
          hint: "The SLAB helper works outside the player, so tempo is never changed."
        };
      }
      if (dsp.linked || remote) return { text: "", hint: "" };
      const api = Spicetify.Platform.PlayerAPI;
      const capabilities = api.getCapabilities?.();
      const state = api.getState();
      const reasons = state?.restrictions?.disallowSettingPlaybackSpeedReasons ?? [];
      if (!capabilities?.canChangeSpeed) {
        return {
          text: "This client has no playback speed control.",
          hint: "This client does not expose playback speed."
        };
      }
      if (reasons.length > 0) {
        const reason = reasons[0];
        return {
          text: reason === "unknown" ? "Spotify locks playback speed for music." : `Speed is locked: ${reason.replace(/_/g, " ")}.`,
          hint: "Spotify blocks playback speed for music on this build. SLAB shapes tone and edits instead."
        };
      }
      return {
        text: "This build allows playback speed.",
        hint: "This build allows playback speed."
      };
    }
  };

  // src/main.ts
  var VERSION = "0.4.0";
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
  function isNewer(a, b) {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const difference = (left[i] ?? 0) - (right[i] ?? 0);
      if (difference !== 0) return difference > 0;
    }
    return false;
  }
  async function boot2(claim) {
    const player = await waitFor(
      () => typeof Spicetify !== "undefined" && Spicetify.Player ? Spicetify.Player : null
    );
    if (!player) {
      console.warn(LOG, "player never appeared, giving up");
      return;
    }
    const eqApi = await waitFor(() => Spicetify.Platform.EqualizerAPI ?? null, 1e4);
    const eqReady = eqApi ? await initEq() : false;
    if (!eqReady) console.warn(LOG, "equalizer unavailable, moods will be inert");
    if (window.__slabClaim !== claim) return;
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
    console.info(LOG, `v${VERSION} ready, eq=${eqReady ? "on" : "off"}`);
  }
  var running = window.SLAB;
  var claimed = window.__slabClaim;
  var rival = running?.version ?? claimed?.version;
  if (rival && isNewer(rival, VERSION)) {
    console.info(LOG, `v${VERSION} standing down, v${rival} is already loaded`);
  } else {
    const claim = { version: VERSION };
    window.__slabClaim = claim;
    try {
      running?.destroy?.();
    } catch {
    }
    void boot2(claim).catch((error) => console.error(LOG, "boot failed", error));
  }
})();
