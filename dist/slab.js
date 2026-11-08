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
  var mode = null;
  var mainTimer = null;
  var watchdog = null;
  var lastTick = 0;
  var WORKER_SILENT_MS = 3e3;
  function tickAll(now) {
    for (const tick2 of subscribers) {
      try {
        tick2(now);
      } catch {
      }
    }
  }
  function startMainTimer() {
    if (mainTimer === null) mainTimer = window.setInterval(() => tickAll(Date.now()), 40);
  }
  function stopTimers() {
    if (mainTimer !== null) window.clearInterval(mainTimer);
    if (watchdog !== null) window.clearInterval(watchdog);
    mainTimer = null;
    watchdog = null;
  }
  function useMainThread() {
    if (mode === "main") return;
    mode = "main";
    if (watchdog !== null) window.clearInterval(watchdog);
    watchdog = null;
    if (worker) {
      worker.terminate();
      worker = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    if (subscribers.size) startMainTimer();
  }
  function watchWorker() {
    if (watchdog !== null) return;
    const armedAt = Date.now();
    watchdog = window.setInterval(() => {
      if (mode === "worker" && subscribers.size && Date.now() - Math.max(lastTick, armedAt) > WORKER_SILENT_MS) useMainThread();
    }, 1e3);
  }
  function boot() {
    if (mode) return;
    try {
      objectUrl = URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" }));
      worker = new Worker(objectUrl);
      mode = "worker";
      worker.onmessage = (event) => {
        lastTick = Date.now();
        tickAll(typeof event.data === "number" ? event.data : Date.now());
      };
      worker.onerror = () => useMainThread();
    } catch {
      useMainThread();
    }
  }
  function subscribe(tick2) {
    boot();
    const wasIdle = subscribers.size === 0;
    subscribers.add(tick2);
    if (wasIdle) {
      if (mode === "worker" && worker) {
        worker.postMessage("start");
        watchWorker();
      } else {
        startMainTimer();
      }
    }
    return () => {
      if (!subscribers.delete(tick2) || subscribers.size > 0) return;
      stopTimers();
      if (worker) worker.postMessage("stop");
    };
  }
  function disposeClock() {
    subscribers.clear();
    stopTimers();
    mode = null;
    lastTick = 0;
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

  // src/core/dsp.ts
  var DSP_ORIGIN = "http://127.0.0.1:47832";
  var status = { checked: false, linked: false };
  var lastProbe = 0;
  var misses = 0;
  var probeSeq = 0;
  var paramsSeq = 0;
  var listeners = /* @__PURE__ */ new Set();
  var PROBE_LINKED_MS = 4e3;
  var PROBE_ABSENT_MS = 3e4;
  var PROBE_FAST_TRIES = 3;
  function onDspChange(listener4) {
    listeners.add(listener4);
    listener4(status);
    return () => listeners.delete(listener4);
  }
  function dspStatus() {
    return status;
  }
  function publish(next) {
    const changed = next.checked !== status.checked || next.linked !== status.linked || next.version !== status.version || next.tapping !== status.tapping || next.audio !== status.audio || next.jump !== status.jump || next.spin !== status.spin || next.hold !== status.hold || next.tape !== status.tape;
    status = next;
    if (changed) for (const listener4 of listeners) listener4(status);
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
  async function probeDsp(force = false, eager = false) {
    const now = Date.now();
    const every = status.linked || eager || misses < PROBE_FAST_TRIES ? PROBE_LINKED_MS : PROBE_ABSENT_MS;
    if (!force && now - lastProbe < every) return status;
    lastProbe = now;
    const seq = ++probeSeq;
    const paramsAtStart = paramsSeq;
    const payload = await request("/status");
    if (seq !== probeSeq) return status;
    if (payload?.ok) {
      misses = 0;
      publish({
        checked: true,
        linked: true,
        // Helpers before 0.3.0 don't report these and only ran while tapping.
        tapping: payload.tapping !== false,
        audio: payload.audio !== false,
        version: payload.version,
        sampleRate: payload.sampleRate,
        latencyMs: payload.latencyMs,
        // Params the helper accepted after this probe went out are newer than what it reported.
        params: paramsSeq === paramsAtStart ? payload.params : status.params,
        jump: Array.isArray(payload.features) && payload.features.includes("jump"),
        spin: Array.isArray(payload.features) && payload.features.includes("spin"),
        hold: Array.isArray(payload.features) && payload.features.includes("hold"),
        tape: Array.isArray(payload.features) && payload.features.includes("tape"),
        throw: Array.isArray(payload.features) && payload.features.includes("throw"),
        seekGapMs: typeof payload.seekGapMs === "number" ? payload.seekGapMs : void 0,
        seekGapHighMs: typeof payload.seekGapHighMs === "number" ? payload.seekGapHighMs : void 0,
        wentLive: typeof payload.chops?.wentLive === "number" ? payload.chops.wentLive : void 0
      });
    } else {
      misses += 1;
      publish({ checked: true, linked: false });
    }
    return status;
  }
  var pending = null;
  var waiting = [];
  var draining = false;
  function sendDsp(params) {
    pending = { ...pending, ...params };
    const result = new Promise((resolve) => waiting.push(resolve));
    if (!draining) void drain();
    return result;
  }
  async function drain() {
    draining = true;
    try {
      while (pending) {
        const body = pending;
        const settle = waiting;
        pending = null;
        waiting = [];
        const payload = await request("/params", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (payload) {
          misses = 0;
          paramsSeq += 1;
          const applied = payload.params;
          publish({ ...status, checked: true, linked: true, params: { ...status.params, ...body, ...applied } });
        } else {
          void probeDsp(true);
        }
        for (const resolve of settle) resolve(Boolean(payload));
      }
    } finally {
      draining = false;
    }
  }
  async function dspTapeStop() {
    const payload = await request(
      "/tapstop",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ downMs: 380, holdMs: 70, upMs: 240 })
      },
      // On loopback the answer is near-instant; don't hold the stop up waiting on a stuck helper.
      300
    );
    return Boolean(payload);
  }
  var DEFAULT_SEEK_GAP_MS = 250;
  var SEEK_MARGIN_MS = 60;
  function canJump() {
    return status.linked && status.tapping === true && status.audio === true && status.jump === true;
  }
  function seekAheadMs() {
    const gap = status.seekGapHighMs ?? status.seekGapMs ?? DEFAULT_SEEK_GAP_MS;
    return Math.round(Math.max(60, Math.min(900, gap + SEEK_MARGIN_MS)));
  }
  var measureTimer = null;
  async function dspJump(order) {
    if (!canJump()) return false;
    const payload = await request(
      "/jump",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(order)
      },
      250
    );
    const ok = payload?.ok === true;
    if (ok) {
      if (measureTimer !== null) window.clearTimeout(measureTimer);
      measureTimer = window.setTimeout(() => {
        measureTimer = null;
        void probeDsp(true);
      }, 2600 + (order.inMs ?? 0));
    }
    return ok;
  }
  async function dspCancelJump() {
    if (!status.linked || !status.jump) return;
    await request("/jump/cancel", { method: "POST" }, 250);
  }
  function canSpin() {
    return canJump() && status.spin === true;
  }
  async function dspSpin(order) {
    if (!canSpin()) return false;
    const payload = await request(
      "/spin",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) },
      250
    );
    const ok = payload?.ok === true;
    if (ok) {
      if (measureTimer !== null) window.clearTimeout(measureTimer);
      measureTimer = window.setTimeout(() => {
        measureTimer = null;
        void probeDsp(true);
      }, 2600 + order.spinMs);
    }
    return ok;
  }
  function canTape() {
    return status.linked && status.tapping === true && status.audio === true && status.tape === true;
  }
  function canHold() {
    return status.linked && status.tapping === true && status.audio === true && status.hold === true;
  }
  var holdChain = Promise.resolve();
  function dspHold(overlay2, ms) {
    const body = JSON.stringify({ ...overlay2, ms: Math.round(ms) });
    const sent2 = holdChain.then(
      () => request("/hold", { method: "POST", headers: { "Content-Type": "application/json" }, body }, 400)
    );
    holdChain = sent2.catch(() => null);
    return sent2.then((payload) => payload?.ok === true);
  }

  // src/core/grid.ts
  var cache = /* @__PURE__ */ new Map();
  var inflight = /* @__PURE__ */ new Map();
  var CACHE_LIMIT = 24;
  function remember(uri2, grid) {
    cache.delete(uri2);
    cache.set(uri2, grid);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === void 0) break;
      cache.delete(oldest);
    }
  }
  function currentUri() {
    return Spicetify.Player.data?.item?.uri ?? null;
  }
  async function loadGrid(uri2) {
    const target = uri2 ?? currentUri();
    if (!target) return null;
    if (!target.startsWith("spotify:track:")) return null;
    const cached = cache.get(target);
    if (cached) {
      remember(target, cached);
      return cached;
    }
    const running3 = inflight.get(target);
    if (running3) return running3;
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
          durationMs,
          sections: (analysis.sections ?? []).map((section) => ({ start: section.start * 1e3, loudness: section.loudness ?? -60 })).filter((section) => Number.isFinite(section.start))
        };
        remember(target, grid);
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
  function gridFor(uri2) {
    const target = uri2 ?? currentUri();
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
  function beatStartMs(grid, index) {
    const clamped = Math.max(0, Math.min(grid.beats.length - 1, index));
    return grid.beats[clamped];
  }
  function beatLengthMs(grid, index) {
    const start = beatStartMs(grid, index);
    const next = grid.beats[index + 1];
    if (next !== void 0) return next - start;
    const previous = grid.beats[index - 1];
    return previous !== void 0 ? start - previous : 500;
  }
  function barLengthMs(grid, index) {
    const start = barStartMs(grid, index);
    const next = grid.bars[index + 1];
    if (next !== void 0) return next - start;
    const previous = grid.bars[index - 1];
    if (previous !== void 0) return start - previous;
    return Math.max(300, grid.durationMs - start);
  }
  function barCount(grid) {
    return grid.bars.length;
  }

  // src/core/lyrics.ts
  var JUST_BEGUN_MS = 450;
  var CACHE_LIMIT2 = 24;
  var cache2 = /* @__PURE__ */ new Map();
  var inflight2 = /* @__PURE__ */ new Map();
  function remember2(uri2, lines2) {
    cache2.delete(uri2);
    cache2.set(uri2, lines2);
    while (cache2.size > CACHE_LIMIT2) {
      const oldest = cache2.keys().next().value;
      if (oldest === void 0) break;
      cache2.delete(oldest);
    }
  }
  function currentUri2() {
    return Spicetify.Player.data?.item?.uri ?? null;
  }
  async function loadLines(uri2) {
    const target = uri2 ?? currentUri2();
    if (!target) return null;
    if (cache2.has(target)) {
      const cached = cache2.get(target) ?? null;
      remember2(target, cached);
      return cached;
    }
    const running3 = inflight2.get(target);
    if (running3) return running3;
    const id = /^spotify:track:([A-Za-z0-9]+)$/.exec(target)?.[1];
    const cosmos = Spicetify.CosmosAsync;
    if (!id || !cosmos) {
      remember2(target, null);
      return null;
    }
    const request2 = (async () => {
      try {
        const body = await cosmos.get(
          `https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&vocalRemoval=false&market=from_token`
        );
        const lyrics = body?.lyrics;
        if (lyrics?.syncType !== "LINE_SYNCED" || !Array.isArray(lyrics.lines)) {
          remember2(target, null);
          return null;
        }
        const lines2 = lyrics.lines.map((line) => ({ startMs: Number(line.startTimeMs), words: String(line.words ?? "").trim() })).filter((line) => Number.isFinite(line.startMs) && line.words !== "" && line.words !== "\u266A").sort((a, b) => a.startMs - b.startMs);
        const result = lines2.length >= 2 ? lines2 : null;
        remember2(target, result);
        return result;
      } catch {
        remember2(target, null);
        return null;
      } finally {
        inflight2.delete(target);
      }
    })();
    inflight2.set(target, request2);
    return request2;
  }
  function lineJustHeard(lines2, ms) {
    let index = -1;
    for (let i = 0; i < lines2.length; i++) {
      if (lines2[i].startMs > ms) break;
      index = i;
    }
    if (index < 0) return null;
    if (ms - lines2[index].startMs < JUST_BEGUN_MS && index > 0) index -= 1;
    return lines2[index];
  }

  // src/core/chops.ts
  var listener = null;
  var busy = false;
  var MAX_CHOP_BARS = 4;
  var padJumpAt = 0;
  var PAD_JUMP_GRACE_MS = 1500;
  var manualBar = -2;
  var TRACK_END_MARGIN_MS = 150;
  var autoLastIndex = null;
  var autoUnsub = null;
  var autoEvery = 4;
  var autoMaxBar = -1;
  var autoCooldownUntil = 0;
  var loopUnsub = null;
  var loopLeft = 0;
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
  var MOVED_MS = 600;
  var HEARD_MARGIN_MS = 350;
  var RECKON_MS = 8e3;
  var runFrom = null;
  var lastAt = 0;
  var lastTime = 0;
  var lastPlaying = false;
  var lastUri = null;
  var sentTo = 0;
  var sentAt = 0;
  var sentKeepsRun = false;
  var reckon = null;
  var nextReckon = null;
  var reckonWentLive = 0;
  var pendingSend = null;
  var helperCutUntil = 0;
  function forgetReckoning() {
    reckon = null;
    nextReckon = null;
  }
  function dropHelperCut() {
    if (pendingSend !== null) window.clearTimeout(pendingSend);
    pendingSend = null;
    if (Date.now() < helperCutUntil) void dspCancelJump();
    helperCutUntil = 0;
  }
  function watchNeedle() {
    let playing2 = false;
    let at2 = 0;
    let uri2 = null;
    try {
      playing2 = Spicetify.Player.isPlaying();
      at2 = Spicetify.Player.getProgress();
      uri2 = Spicetify.Player.data?.item?.uri ?? null;
    } catch {
      return;
    }
    const now = Date.now();
    if (uri2 !== lastUri) {
      runFrom = playing2 ? at2 : null;
      forgetReckoning();
      if (lastUri !== null) dropHelperCut();
    } else if (!playing2) {
      forgetReckoning();
      if (lastPlaying) dropHelperCut();
    } else if (!lastPlaying) {
      runFrom = at2;
      forgetReckoning();
    } else if (Math.abs(at2 - (lastAt + (now - lastTime))) > MOVED_MS) {
      const ours = now - sentAt < 2e3 && Math.abs(at2 - (sentTo + (now - sentAt))) < MOVED_MS;
      if (!ours) {
        runFrom = at2;
        forgetReckoning();
      } else if (!sentKeepsRun) {
        runFrom = sentTo;
      }
    }
    if (runFrom === null && playing2) runFrom = at2;
    lastAt = at2;
    lastTime = now;
    lastPlaying = playing2;
    lastUri = uri2;
  }
  function needlePosition() {
    const now = Date.now();
    if (nextReckon && now >= nextReckon.time) {
      reckon = nextReckon;
      nextReckon = null;
    }
    if ((dspStatus().wentLive ?? 0) > reckonWentLive) forgetReckoning();
    if (reckon && now - reckon.time < RECKON_MS) return reckon.at + (now - reckon.time);
    const at2 = Spicetify.Player.getProgress();
    return canJump() ? at2 - (dspStatus().latencyMs ?? 0) : at2;
  }
  function unbrokenMs(heard) {
    if (runFrom === null) return 0;
    return Math.max(0, heard - runFrom - HEARD_MARGIN_MS);
  }
  function sent(to, keepsRun) {
    sentTo = to;
    sentAt = Date.now();
    sentKeepsRun = keepsRun;
    if (!keepsRun) {
      runFrom = to;
      forgetReckoning();
    }
  }
  async function cut(target, from, inMs = 0, spin = false) {
    if (spin ? canSpin() : canJump()) {
      const ahead = seekAheadMs();
      const asked = Date.now();
      const order = {
        backMs: Math.round(from - target),
        seekAheadMs: ahead,
        availableMs: Math.round(unbrokenMs(from))
      };
      const jumped = spin ? await dspSpin({ ...order, spinMs: Math.round(inMs) }) : await dspJump({ ...order, inMs: Math.round(inMs) });
      if (jumped) {
        const fires = asked + (Date.now() - asked) / 2 + inMs;
        const send = () => {
          pendingSend = null;
          const to = target + ahead + Math.max(0, Date.now() - fires);
          sent(to, true);
          seek(to);
        };
        if (pendingSend !== null) window.clearTimeout(pendingSend);
        pendingSend = null;
        helperCutUntil = fires + 3e3;
        reckonWentLive = dspStatus().wentLive ?? 0;
        nextReckon = { at: target, time: fires };
        if (inMs > 0) pendingSend = window.setTimeout(send, inMs);
        else send();
        return true;
      }
    }
    if (pendingSend !== null) dropHelperCut();
    const plain = () => {
      sent(target, false);
      seek(target);
    };
    if (inMs > 0) window.setTimeout(plain, inMs);
    else plain();
    return false;
  }
  async function chopBars(bars, auto = false) {
    if (busy) return false;
    busy = true;
    try {
      const grid = await ensureGrid();
      if (!grid) return false;
      const now = needlePosition();
      const index = barIndexAt(grid, now);
      const span = Math.max(1, Math.round(bars));
      if (index < span) return false;
      const back = index - span;
      const phase = (now - barStartMs(grid, index)) / barLengthMs(grid, index);
      await cut(barStartMs(grid, back) + phase * barLengthMs(grid, back), now);
      if (auto) return true;
      padJumpAt = Date.now();
      manualBar = index;
      emit("chop", `${span} bar${span === 1 ? "" : "s"} back`);
      return true;
    } finally {
      busy = false;
    }
  }
  var LINE_REACH_MS = 15e3;
  function onTheBeat(grid, at2, start) {
    const here = beatIndexAt(grid, at2);
    let there = beatIndexAt(grid, start);
    if (here < 0 || there < 0) return start;
    const phase = (at2 - beatStartMs(grid, here)) / beatLengthMs(grid, here);
    let target = beatStartMs(grid, there) + phase * beatLengthMs(grid, there);
    if (target > start + 25 && there > 0) {
      there -= 1;
      target = beatStartMs(grid, there) + phase * beatLengthMs(grid, there);
    }
    return target;
  }
  function quote(words) {
    return words.length > 34 ? `${words.slice(0, 33).trimEnd()}\u2026` : words;
  }
  async function runLineBack() {
    if (busy) return false;
    const grid = await ensureGrid();
    if (!grid) return false;
    const lines2 = await loadLines();
    const heard = needlePosition();
    const line = lines2 ? lineJustHeard(lines2, heard) : null;
    if (!line || heard - line.startMs > LINE_REACH_MS) {
      const did = await chopBars(1, true);
      if (did) {
        padJumpAt = Date.now();
        manualBar = barIndexAt(grid, heard);
        emit("chop", lines2 ? "No line here, so a bar back" : "No synced lyrics, so a bar back");
      }
      return did;
    }
    busy = true;
    try {
      const target = onTheBeat(grid, heard, line.startMs);
      if (heard - target < 250) return false;
      await cut(target, heard);
      padJumpAt = Date.now();
      manualBar = barIndexAt(grid, heard);
      emit("chop", `Back to \u201C${quote(line.words)}\u201D`);
      return true;
    } finally {
      busy = false;
    }
  }
  var SPIN_MIN_MS = 350;
  var SPIN_MAX_MS = 650;
  async function spinBack() {
    if (!canSpin()) {
      const did = await chopBars(1, true);
      if (did) {
        padJumpAt = Date.now();
        emit("chop", dspStatus().linked ? "1 bar back. Spinning needs a newer SLAB DSP." : "1 bar back. Spinning needs SLAB DSP.");
      }
      return did;
    }
    if (busy) return false;
    busy = true;
    try {
      const grid = await ensureGrid();
      if (!grid) return false;
      const heard = needlePosition();
      const beat = beatLengthMs(grid, Math.max(0, beatIndexAt(grid, heard)));
      const turn = Math.max(SPIN_MIN_MS, Math.min(SPIN_MAX_MS, beat));
      const end = heard + turn;
      const index = barIndexAt(grid, end);
      if (index < 1) return false;
      const phase = (end - barStartMs(grid, index)) / barLengthMs(grid, index);
      const target = barStartMs(grid, index - 1) + phase * barLengthMs(grid, index - 1);
      await cut(target, heard, turn, true);
      padJumpAt = Date.now();
      manualBar = index;
      emit("chop", "Spun back a bar");
      return true;
    } finally {
      busy = false;
    }
  }
  function cancelLoop() {
    loopUnsub?.();
    loopUnsub = null;
    loopLeft = 0;
  }
  function isLooping() {
    return loopUnsub !== null;
  }
  function loopRemaining() {
    return loopUnsub ? loopLeft : 0;
  }
  var LOOP_LEAD_MS = 15;
  var LOOP_SEND_MS = 200;
  async function loopBars(times = 4) {
    const grid = await ensureGrid();
    if (!grid) return false;
    const index = barIndexAt(grid, needlePosition());
    if (index < 0) return false;
    cancelLoop();
    const start = barStartMs(grid, index);
    const trackLeft = (grid.durationMs || Number.POSITIVE_INFINITY) - TRACK_END_MARGIN_MS - start;
    const length = Math.min(barLengthMs(grid, index), trackLeft);
    if (length < 300) return false;
    const end = start + length;
    const total = Math.max(1, Math.round(times));
    let armed = true;
    loopLeft = total;
    const tick2 = () => {
      if (!Spicetify.Player.isPlaying()) {
        cancelLoop();
        return;
      }
      const at2 = needlePosition();
      if (at2 < start - 250 || at2 > end + length) {
        cancelLoop();
        return;
      }
      if (!armed) {
        if (at2 < end - length / 2) armed = true;
        return;
      }
      const helper = canJump();
      if (at2 < end - (helper ? LOOP_SEND_MS : LOOP_LEAD_MS)) return;
      if (loopLeft <= 0) {
        cancelLoop();
        emit("loop", "Loop done");
        return;
      }
      armed = false;
      loopLeft -= 1;
      manualBar = index;
      const late = Math.max(0, at2 - end);
      const to = start + Math.min(late, length / 4);
      if (helper) {
        void cut(to, late > 0 ? at2 : end, late > 0 ? 0 : end - at2);
        return;
      }
      sent(to, false);
      seek(to);
    };
    loopUnsub = subscribe(tick2);
    tick2();
    emit("loop", total === 1 ? "Looping this bar once more" : `Looping this bar ${total} times`);
    return true;
  }
  var stopping = null;
  function isStopping() {
    return stopping !== null;
  }
  function tapeStop(options = {}) {
    if (stopping) return stopping;
    stopping = runTapeStop(options).finally(() => {
      stopping = null;
    });
    return stopping;
  }
  async function runTapeStop(options) {
    if (!Spicetify.Player.isPlaying()) {
      emit("stop", "Already stopped");
      return false;
    }
    const spun = options.spinDown ? await options.spinDown() : false;
    const fade = !spun;
    const startVolume = Spicetify.Player.getVolume();
    const duration = fade ? 420 : Math.max(0, options.spinDownMs ?? 0);
    const origin = Date.now();
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        unsub2();
        resolve();
      };
      const unsub2 = subscribe(() => {
        const progress = duration === 0 ? 1 : Math.min(1, (Date.now() - origin) / duration);
        if (fade) {
          try {
            Spicetify.Player.setVolume(startVolume * Math.pow(1 - progress, 1.8));
          } catch {
          }
        }
        if (progress >= 1) finish();
      });
      window.setTimeout(finish, duration + 250);
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
    if (!autoUnsub) startAuto();
  }
  var autoBaseline = true;
  function startAuto() {
    autoBaseline = true;
    autoCooldownUntil = 0;
    autoUnsub = subscribe(() => {
      if (busy || loopUnsub || stopping) return;
      if (!Spicetify.Player.isPlaying()) return;
      const grid = gridFor();
      if (!grid) return;
      const index = barIndexAt(grid, needlePosition());
      if (index < 0) return;
      const last = autoLastIndex;
      autoLastIndex = index;
      if (autoBaseline || last === null) {
        autoBaseline = false;
        autoMaxBar = index;
        return;
      }
      if (index < last) {
        const padJumped = Date.now() - padJumpAt < PAD_JUMP_GRACE_MS;
        if (!padJumped && index < autoMaxBar - MAX_CHOP_BARS) autoMaxBar = index;
        return;
      }
      if (index > last + 1) {
        autoMaxBar = Math.max(autoMaxBar, index);
        return;
      }
      if (index <= autoMaxBar) return;
      autoMaxBar = index;
      if (Date.now() < autoCooldownUntil) return;
      if (index % autoEvery !== 0) return;
      if (manualBar >= index - 1) return;
      autoCooldownUntil = Date.now() + 900;
      void chopBars(1, true).then((did) => {
        if (did) emit("auto", `Auto chop, every ${autoEvery} bar${autoEvery === 1 ? "" : "s"}`);
      });
    });
  }
  function autoBarsAhead(index) {
    if (!autoUnsub || autoBaseline || index < 0) return null;
    const from = Math.max(autoMaxBar, index);
    return (Math.floor(from / autoEvery) + 1) * autoEvery - index;
  }
  function stopAuto() {
    autoUnsub?.();
    autoUnsub = null;
    autoLastIndex = null;
    autoMaxBar = -1;
    autoCooldownUntil = 0;
  }
  function resetForTrack() {
    cancelLoop();
    manualBar = -2;
    padJumpAt = 0;
    forgetReckoning();
    dropHelperCut();
    lastUri = null;
    autoBaseline = true;
    autoLastIndex = null;
    autoMaxBar = -1;
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
    gain: 0,
    wow: 0,
    hiss: 0,
    crackle: 0,
    crush: 0
  };
  var MOODS = [
    {
      id: "slowed",
      name: "Slowed + Reverb",
      sub: "slowed, big room, highs off",
      gains: [3.5, 2, 0.8, -0.6, -2.6, -4.2],
      dsp: { ...dry, pitch: -320, reverb: 34, reverbPreset: "largeHall2", lowpass: 11e3 },
      note: "The highs come off first when a record is dragged. Presence drops, the low-mids swell, the top turns to air, and the helper adds the room."
    },
    {
      id: "screwed",
      name: "Screwed",
      sub: "gray-tape low end, top rolled off",
      gains: [5, 3.2, 0.4, -1.2, -3, -6],
      dsp: { ...dry, pitch: -560, reverb: 16, reverbPreset: "largeRoom", lowpass: 8e3 },
      note: "Screw mixed for a trunk. Sub and low-mid pushed hard, everything above 2k pulled back so the 808 owns the room."
    },
    {
      id: "chopped",
      name: "Chopped",
      sub: "dry and forward so the chops land",
      gains: [2.2, 1, -0.2, 1.4, 3, 1.2],
      dsp: { ...dry, reverbPreset: "smallRoom" },
      note: "Chopped records stay dry and forward. The cut has to land, so the presence band comes up instead of down."
    },
    {
      id: "memphis",
      name: "Memphis Tape",
      sub: "midrange honk, highs cut",
      gains: [1.4, 0.8, 3, 2.2, -1, -5],
      dsp: { ...dry, pitch: -160, reverb: 10, reverbPreset: "plate", lowpass: 6500 },
      note: "Cassette dub: 400-1k pushed until it honks, top rolled off, bottom kept loose."
    },
    {
      id: "sped",
      name: "Sped Up",
      sub: "nightcore bright, thin low end",
      gains: [-1.2, -0.2, -0.6, 1, 2.4, 3.6],
      dsp: { ...dry, pitch: 400 },
      note: "The other direction. Low end thins out, presence and air come up, the whole thing gets lighter."
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
  var MINE_ID = "mine";
  var mine = null;
  function setMine(saved) {
    if (!saved) {
      mine = null;
      return;
    }
    const base = MOODS.find((mood) => mood.id === saved.from);
    mine = {
      id: MINE_ID,
      name: "Mine",
      sub: base ? `your own, made from ${base.name}` : "your own",
      gains: saved.gains.slice(0, BANDS.length),
      dsp: { ...saved.dsp },
      note: ""
    };
  }
  function mineMood() {
    return mine;
  }
  function moodById(id) {
    if (id === MINE_ID && mine) return mine;
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

  // src/core/tape.ts
  var ROOMS = [
    { id: "smallRoom", name: "Small room", wet: 18 },
    { id: "plate", name: "Plate", wet: 22 },
    { id: "mediumChamber", name: "Chamber", wet: 24 },
    { id: "largeHall", name: "Hall", wet: 28 },
    { id: "cathedral", name: "Cathedral", wet: 32 }
  ];
  var CLEAN_TAPE = { room: null, wow: false, hiss: false, crackle: false, crush: false };
  function withTape(dsp, tape) {
    const room = ROOMS.find((r) => r.id === tape.room);
    return {
      ...dsp,
      reverbPreset: room ? room.id : dsp.reverbPreset,
      reverb: room ? Math.max(dsp.reverb, room.wet) : dsp.reverb,
      wow: tape.wow ? 1 : dsp.wow,
      hiss: tape.hiss ? 1 : dsp.hiss,
      crackle: tape.crackle ? 1 : dsp.crackle,
      crush: tape.crush ? 1 : dsp.crush
    };
  }
  function nextRoom(id) {
    const index = ROOMS.findIndex((room) => room.id === id);
    if (index < 0) return ROOMS[0].id;
    return index + 1 < ROOMS.length ? ROOMS[index + 1].id : null;
  }
  function roomName(id) {
    return ROOMS.find((room) => room.id === id)?.name ?? "The mood's";
  }
  function isClean(tape) {
    return !tape.room && !tape.wow && !tape.hiss && !tape.crackle && !tape.crush;
  }
  function readTape(raw) {
    if (!raw || typeof raw !== "object") return { ...CLEAN_TAPE };
    const tape = raw;
    return {
      room: typeof tape.room === "string" && ROOMS.some((room) => room.id === tape.room) ? tape.room : null,
      wow: tape.wow === true,
      hiss: tape.hiss === true,
      crackle: tape.crackle === true,
      crush: tape.crush === true
    };
  }

  // src/core/state.ts
  var KEY = "slab:state:v1";
  var DEFAULTS = {
    moodId: "flat",
    auto: false,
    open: false,
    every: 4,
    pitch: 0,
    eqOwner: "auto",
    bank: "chop",
    screwDepth: 5,
    mine: null,
    tape: CLEAN_TAPE,
    dj: false,
    djBefore: null,
    djHand: 2
  };
  function clampPitch(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(-1200, Math.min(1200, Math.round(value / 10) * 10));
  }
  var SCREW_MIN = 1;
  var SCREW_MAX = 12;
  function finite(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
  function readMine(raw) {
    if (!raw || typeof raw !== "object") return null;
    const saved = raw;
    if (typeof saved.from !== "string" || !Array.isArray(saved.gains) || saved.gains.length !== BANDS.length) return null;
    if (!saved.gains.every((gain) => typeof gain === "number" && Number.isFinite(gain))) return null;
    const dsp = saved.dsp ?? {};
    return {
      from: saved.from,
      gains: saved.gains.map((gain) => Math.max(-12, Math.min(12, gain))),
      dsp: {
        pitch: clampPitch(finite(dsp.pitch, 0)),
        reverb: finite(dsp.reverb, 0),
        reverbPreset: typeof dsp.reverbPreset === "string" ? dsp.reverbPreset : "largeHall2",
        delayTime: finite(dsp.delayTime, 0.36),
        delayFeedback: finite(dsp.delayFeedback, 0),
        delayMix: finite(dsp.delayMix, 0),
        lowpass: finite(dsp.lowpass, 2e4),
        gain: finite(dsp.gain, 0),
        wow: Math.max(0, Math.min(1, finite(dsp.wow, 0))),
        hiss: Math.max(0, Math.min(1, finite(dsp.hiss, 0))),
        crackle: Math.max(0, Math.min(1, finite(dsp.crackle, 0))),
        crush: Math.max(0, Math.min(1, finite(dsp.crush, 0)))
      },
      ...saved.tape ? { tape: readTape(saved.tape) } : {}
    };
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) {
        setMine(null);
        return { ...DEFAULTS, tape: { ...CLEAN_TAPE } };
      }
      const parsed = JSON.parse(raw);
      const mine3 = readMine(parsed.mine);
      setMine(mine3);
      const moodId = typeof parsed.moodId === "string" && (parsed.moodId !== MINE_ID || mine3) ? parsed.moodId : DEFAULTS.moodId;
      return {
        moodId,
        auto: parsed.auto === true,
        open: parsed.open === true,
        every: typeof parsed.every === "number" && parsed.every >= 1 && parsed.every <= 16 ? parsed.every : DEFAULTS.every,
        // State saved before the slider existed has no pitch; the mood's is the truth.
        pitch: typeof parsed.pitch === "number" ? clampPitch(parsed.pitch) : moodById(moodId).dsp.pitch,
        eqOwner: parsed.eqOwner === "slab" || parsed.eqOwner === "modern" ? parsed.eqOwner : DEFAULTS.eqOwner,
        bank: parsed.bank === "screw" || parsed.bank === "tape" ? parsed.bank : "chop",
        screwDepth: typeof parsed.screwDepth === "number" && parsed.screwDepth >= SCREW_MIN && parsed.screwDepth <= SCREW_MAX ? Math.round(parsed.screwDepth) : DEFAULTS.screwDepth,
        mine: mine3,
        tape: readTape(parsed.tape),
        dj: parsed.dj === true,
        djBefore: parsed.djBefore && typeof parsed.djBefore.moodId === "string" && typeof parsed.djBefore.pitch === "number" ? { moodId: parsed.djBefore.moodId, pitch: clampPitch(parsed.djBefore.pitch), tape: readTape(parsed.djBefore.tape) } : null,
        djHand: typeof parsed.djHand === "number" && parsed.djHand >= 1 && parsed.djHand <= 4 ? Math.round(parsed.djHand) : DEFAULTS.djHand
      };
    } catch {
      setMine(null);
      return { ...DEFAULTS, tape: { ...CLEAN_TAPE } };
    }
  }
  function saveState(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
    }
  }

  // src/core/genre.ts
  var STYLES = ["houston", "trap", "rap", "slowjam", "band", "dance", "pop"];
  var STYLE_NAMES = {
    houston: "Houston",
    trap: "trap",
    rap: "rap",
    slowjam: "slow jam",
    band: "band",
    dance: "dance",
    pop: "pop"
  };
  var MATCHES = [
    ["houston", /houston|screw|chopped|texas|dirty south|southern hip hop|memphis/],
    ["trap", /trap|drill|plugg|rage|crunk/],
    ["slowjam", /r&b|rnb|soul|quiet storm|slow jam|funk|motown/],
    ["rap", /hip hop|rap|gangster|g funk|boom bap/],
    ["dance", /house|techno|edm|electro|dance|dubstep|drum and bass|trance|garage/],
    ["band", /rock|metal|punk|indie|grunge|alternative|emo|shoegaze|country|folk/],
    ["pop", /pop/]
  ];
  var GENRES_KEY = "slab:genres:v1";
  var GENRES_LIMIT = 500;
  var EMPTY_AGAIN_MS = 7 * 24 * 36e5;
  var FAILED_AGAIN_MS = 10 * 6e4;
  var genres = null;
  var failed = /* @__PURE__ */ new Map();
  var inflight3 = /* @__PURE__ */ new Map();
  function genreStore() {
    if (genres) return genres;
    genres = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(GENRES_KEY) ?? "{}");
      for (const [uri2, asked] of Object.entries(parsed ?? {})) {
        if (Array.isArray(asked?.genres) && typeof asked.at === "number") {
          genres[uri2] = { genres: asked.genres.filter((g) => typeof g === "string"), at: asked.at };
        }
      }
    } catch {
    }
    return genres;
  }
  function saveGenres() {
    const kept = Object.entries(genreStore()).sort((a, b) => b[1].at - a[1].at).slice(0, GENRES_LIMIT);
    genres = Object.fromEntries(kept);
    try {
      localStorage.setItem(GENRES_KEY, JSON.stringify(genres));
    } catch {
    }
  }
  async function artistGenres(artistUri) {
    const known = genreStore()[artistUri];
    if (known && (known.genres.length > 0 || Date.now() - known.at < EMPTY_AGAIN_MS)) return known.genres;
    if (Date.now() - (failed.get(artistUri) ?? -Infinity) < FAILED_AGAIN_MS) return known?.genres ?? [];
    const running3 = inflight3.get(artistUri);
    if (running3) return running3;
    const id = /^spotify:artist:([A-Za-z0-9]+)$/.exec(artistUri)?.[1];
    const cosmos = Spicetify.CosmosAsync;
    if (!id || !cosmos) return [];
    const request2 = (async () => {
      try {
        const body = await cosmos.get(`https://api.spotify.com/v1/artists/${id}`);
        if (!body || typeof body !== "object") throw new Error("no artist");
        const found = Array.isArray(body.genres) ? body.genres.filter((g) => typeof g === "string") : [];
        genreStore()[artistUri] = { genres: found, at: Date.now() };
        saveGenres();
        failed.delete(artistUri);
        return found;
      } catch {
        failed.set(artistUri, Date.now());
        return known?.genres ?? [];
      } finally {
        inflight3.delete(artistUri);
      }
    })();
    inflight3.set(artistUri, request2);
    return request2;
  }
  var sounds = /* @__PURE__ */ new Map();
  var SOUNDS_LIMIT = 64;
  function unit(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : void 0;
  }
  async function trackSound(trackUri) {
    if (sounds.has(trackUri)) return sounds.get(trackUri) ?? null;
    const id = /^spotify:track:([A-Za-z0-9]+)$/.exec(trackUri)?.[1];
    const cosmos = Spicetify.CosmosAsync;
    if (!id || !cosmos) return null;
    let sound = null;
    try {
      const body = await cosmos.get(
        `https://spclient.wg.spotify.com/audio-attributes/v1/audio-features/${id}?format=json`
      );
      if (body && typeof body === "object") {
        const read = {
          speechiness: unit(body.speechiness),
          energy: unit(body.energy),
          acousticness: unit(body.acousticness),
          instrumentalness: unit(body.instrumentalness),
          danceability: unit(body.danceability)
        };
        if (Object.values(read).some((value) => value !== void 0)) sound = read;
      }
    } catch {
    }
    if (sounds.size >= SOUNDS_LIMIT) {
      const oldest = sounds.keys().next().value;
      if (oldest !== void 0) sounds.delete(oldest);
    }
    sounds.set(trackUri, sound);
    return sound;
  }
  function styleBySound(sound, tempo) {
    if (!sound) return null;
    const { speechiness: speech, energy, acousticness: acoustic, instrumentalness: instrumental, danceability: dance } = sound;
    if (speech === void 0 && energy === void 0 && dance === void 0) return null;
    if (speech !== void 0 && speech >= 0.15) return tempo >= 130 && tempo <= 165 ? "trap" : "rap";
    if (instrumental !== void 0 && instrumental >= 0.5 && dance !== void 0 && dance >= 0.6) return "dance";
    if (energy !== void 0 && energy < 0.45 && (tempo > 0 && tempo < 100 || (acoustic ?? 0) >= 0.5)) return "slowjam";
    if (energy !== void 0 && energy >= 0.7 && dance !== void 0 && dance < 0.5) return "band";
    if (dance !== void 0 && dance >= 0.7 && (energy ?? 0) >= 0.6) return "dance";
    return "pop";
  }
  var PICKS_KEY = "slab:style-picks:v1";
  var picks = null;
  function pickStore() {
    if (picks) return picks;
    picks = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(PICKS_KEY) ?? "{}");
      for (const [uri2, style2] of Object.entries(parsed ?? {})) {
        if (STYLES.includes(style2)) picks[uri2] = style2;
      }
    } catch {
    }
    return picks;
  }
  function pickedStyle(artistUri) {
    return pickStore()[artistUri] ?? null;
  }
  function pickStyle(artistUri, style2) {
    const store = pickStore();
    if (style2) store[artistUri] = style2;
    else delete store[artistUri];
    try {
      localStorage.setItem(PICKS_KEY, JSON.stringify(store));
    } catch {
    }
  }
  function styleFor(genres2, tempo, sound = null) {
    const all = genres2.join(" | ").toLowerCase();
    for (const [style2, pattern] of MATCHES) if (pattern.test(all)) return { style: style2, by: "genres" };
    const heard = styleBySound(sound, tempo);
    if (heard) return { style: heard, by: "sound" };
    if (tempo > 0 && tempo < 85) return { style: "slowjam", by: "tempo" };
    if (tempo >= 130 && tempo <= 165) return { style: "trap", by: "tempo" };
    if (tempo >= 118 && tempo < 130) return { style: "dance", by: "tempo" };
    return { style: "rap", by: "tempo" };
  }

  // src/core/holds.ts
  var RAMP = {
    screw: { on: 650, off: 220 },
    trunk: { on: 90, off: 45 },
    echo: { on: 40, off: 900 }
  };
  var TRUNK_HZ = 420;
  var TRUNK_LIFT_DB = 3;
  var ECHO_MIX = 38;
  var ECHO_FEEDBACK = 48;
  var REFRESH_MS = 4e3;
  var down = /* @__PURE__ */ new Set();
  var screwCents = -500;
  var echoSeconds = 0.4;
  var refresh = null;
  var listener2 = null;
  function onHoldChange(fn) {
    listener2 = fn;
  }
  function overlay() {
    const o = {};
    if (down.has("screw")) o.pitchOffset = screwCents;
    if (down.has("trunk")) {
      o.lowpassCap = TRUNK_HZ;
      o.gainBoost = TRUNK_LIFT_DB;
    }
    if (down.has("echo")) {
      o.echoMix = ECHO_MIX;
      o.echoFeedback = ECHO_FEEDBACK;
      o.echoTime = echoSeconds;
    }
    return o;
  }
  function keepAlive() {
    if (down.size && refresh === null) {
      refresh = window.setInterval(() => void dspHold(overlay(), 0), REFRESH_MS);
    } else if (!down.size && refresh !== null) {
      window.clearInterval(refresh);
      refresh = null;
    }
    listener2?.(down);
  }
  function press(name, options = {}) {
    if (!canHold()) return false;
    if (down.has(name)) return true;
    if (name === "screw" && typeof options.cents === "number") screwCents = Math.min(-100, options.cents);
    if (name === "echo" && typeof options.beatMs === "number" && options.beatMs > 0) {
      const beat = options.beatMs / 1e3;
      echoSeconds = beat > 0.75 ? beat / 2 : beat;
    }
    down.add(name);
    void dspHold(overlay(), RAMP[name].on);
    keepAlive();
    return true;
  }
  var THROW_MS = 60;
  function release(name) {
    if (!down.delete(name)) return;
    void dspHold(overlay(), name === "echo" && dspStatus().throw ? THROW_MS : RAMP[name].off);
    keepAlive();
  }
  function releaseAll() {
    if (!down.size) return;
    down.clear();
    void dspHold({}, 150);
    keepAlive();
  }
  function isHeld(name) {
    return down.has(name);
  }

  // src/core/keep.ts
  var KEY2 = "slab:keep:v1";
  var LIMIT = 200;
  var memory = null;
  function load() {
    if (memory) return memory;
    memory = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY2) ?? "{}");
      for (const [uri2, kept] of Object.entries(parsed)) {
        if (typeof kept?.moodId === "string" && typeof kept.pitch === "number") {
          memory[uri2] = {
            name: typeof kept.name === "string" ? kept.name : "",
            moodId: kept.moodId,
            pitch: kept.pitch,
            at: typeof kept.at === "number" ? kept.at : 0
          };
        }
      }
    } catch {
    }
    return memory;
  }
  function save() {
    if (!memory) return;
    const entries = Object.entries(memory).sort((a, b) => b[1].at - a[1].at).slice(0, LIMIT);
    memory = Object.fromEntries(entries);
    try {
      localStorage.setItem(KEY2, JSON.stringify(memory));
    } catch {
    }
  }
  function currentArtist() {
    try {
      const metadata = Spicetify.Player.data?.item?.metadata;
      const uri2 = metadata?.artist_uri;
      if (!uri2 || !uri2.startsWith("spotify:artist:")) return null;
      return { uri: uri2, name: metadata?.artist_name ?? "" };
    } catch {
      return null;
    }
  }
  function keptFor(artist) {
    if (!artist) return null;
    return load()[artist.uri] ?? null;
  }
  function keep(artist, moodId, pitch) {
    load()[artist.uri] = { name: artist.name, moodId, pitch, at: Date.now() };
    save();
  }
  function forget(artist) {
    const kept = load();
    if (!(artist.uri in kept)) return;
    delete kept[artist.uri];
    save();
  }

  // src/core/style.ts
  var MOVES = ["chop1", "chop2", "chop4", "loop", "line", "spin", "screw", "trunk", "echo"];
  function isMove(id) {
    return MOVES.includes(id);
  }
  var KEY3 = "slab:style:v1";
  var PHRASE = 8;
  var ENOUGH = 6;
  var counts = null;
  function load2() {
    if (counts) return counts;
    counts = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY3) ?? "{}");
      if (parsed && typeof parsed === "object") counts = parsed;
    } catch {
    }
    return counts;
  }
  function save2() {
    try {
      localStorage.setItem(KEY3, JSON.stringify(counts ?? {}));
    } catch {
    }
  }
  function noteMove(style2, move, barInPhrase) {
    const all = load2();
    const byMove = all[style2] ?? (all[style2] = {});
    const bars = byMove[move] ?? (byMove[move] = new Array(PHRASE).fill(0));
    const at2 = (Math.round(barInPhrase) % PHRASE + PHRASE) % PHRASE;
    bars[at2] = (bars[at2] ?? 0) + 1;
    save2();
  }
  function lean(style2, move, barInPhrase) {
    const byMove = load2()[style2];
    if (!byMove) return 1;
    let total = 0;
    for (const bars2 of Object.values(byMove)) for (const n of bars2 ?? []) total += n;
    if (total < ENOUGH) return 1;
    const bars = byMove[move] ?? [];
    const here = bars[(Math.round(barInPhrase) % PHRASE + PHRASE) % PHRASE] ?? 0;
    const overall = bars.reduce((sum, n) => sum + n, 0);
    return 1 + Math.min(1.5, here / total * 6 + overall / total);
  }

  // src/core/dj.ts
  var PLANS = {
    houston: { phrase: 4, chop: 0.75, chopBars: [[1, 0.55], [2, 0.35], [4, 0.1]], line: 0.7, loop: 0.3, spin: 0.15, echo: 0.3, screw: 0.55, trunk: 0.35 },
    trap: { phrase: 4, chop: 0.6, chopBars: [[1, 0.5], [2, 0.4], [4, 0.1]], line: 0.4, loop: 0.4, spin: 0.35, echo: 0.4, screw: 0.4, trunk: 0.4 },
    rap: { phrase: 4, chop: 0.65, chopBars: [[1, 0.5], [2, 0.4], [4, 0.1]], line: 0.55, loop: 0.3, spin: 0.2, echo: 0.3, screw: 0.45, trunk: 0.3 },
    slowjam: { phrase: 8, chop: 0.45, chopBars: [[1, 0.4], [2, 0.5], [4, 0.1]], line: 0.8, loop: 0.25, spin: 0.1, echo: 0.5, screw: 0.65, trunk: 0.25 },
    band: { phrase: 8, chop: 0.45, chopBars: [[1, 0.3], [2, 0.5], [4, 0.2]], line: 0.35, loop: 0.3, spin: 0.25, echo: 0.45, screw: 0.35, trunk: 0.3 },
    dance: { phrase: 8, chop: 0.4, chopBars: [[1, 0.3], [2, 0.4], [4, 0.3]], line: 0.25, loop: 0.5, spin: 0.4, echo: 0.4, screw: 0.3, trunk: 0.5 },
    pop: { phrase: 8, chop: 0.5, chopBars: [[1, 0.45], [2, 0.45], [4, 0.1]], line: 0.5, loop: 0.3, spin: 0.2, echo: 0.4, screw: 0.4, trunk: 0.3 }
  };
  var REST_BARS = [3, 2, 1, 1];
  var YIELD_BARS = 8;
  var MOVED_BARS = 5;
  var OWN_JUMP_MS = 1500;
  var HANDS = ["light", "steady", "heavy", "hard"];
  var HAND_WEIGHT = [0.55, 1, 1.45, 1.9];
  var HAND_PHRASE = [2, 1, 1, 0.5];
  var running = false;
  var unsub = null;
  var listener3 = null;
  var uri = null;
  var style = "rap";
  var detected = "rap";
  var styleReady = false;
  var hand = 1;
  var lines = null;
  var seed = 1;
  var lastBar = null;
  var maxBar = -1;
  var restUntil = -1;
  var lastJumpBar = -10;
  var yieldUntil = -1;
  var jumpedAt = 0;
  var timers = [];
  var mine2 = /* @__PURE__ */ new Set();
  function onDj(fn) {
    listener3 = fn;
  }
  function djRunning() {
    return running;
  }
  function djStyleName() {
    return running && styleReady ? STYLE_NAMES[style] : null;
  }
  function setDjHand(level) {
    hand = Math.max(0, Math.min(HANDS.length - 1, Math.round(level) - 1));
  }
  function nextDjStyle() {
    if (!running || !styleReady) return null;
    const next = STYLES[(STYLES.indexOf(style) + 1) % STYLES.length];
    const artist = currentArtist();
    if (artist) pickStyle(artist.uri, next === detected ? null : next);
    style = next;
    return next;
  }
  function say(label) {
    listener3?.(label);
  }
  function clearTimers() {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  }
  function letUpMine() {
    for (const name of mine2) release(name);
    mine2.clear();
  }
  function playing() {
    try {
      return Spicetify.Player.isPlaying();
    } catch {
      return false;
    }
  }
  function at(when, fn) {
    const wait = Math.max(0, when - needlePosition());
    timers.push(window.setTimeout(() => {
      if (running && playing()) fn();
    }, wait));
  }
  function dice(bar) {
    let a = (seed ^ Math.imul(bar + 1, 2654435761)) >>> 0;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hash(text) {
    let h2 = 2166136261;
    for (let i = 0; i < text.length; i++) h2 = Math.imul(h2 ^ text.charCodeAt(i), 16777619);
    return h2 >>> 0;
  }
  async function readTrack(track) {
    const artist = currentArtist();
    const [grid, genres2, sound] = await Promise.all([
      gridFor() ?? loadGrid(),
      artist ? artistGenres(artist.uri) : Promise.resolve([]),
      track ? trackSound(track) : Promise.resolve(null)
    ]);
    return styleFor(genres2, grid?.tempo ?? 0, sound);
  }
  async function trackStyle() {
    const artist = currentArtist();
    const picked = artist ? pickedStyle(artist.uri) : null;
    if (picked) return picked;
    let track = null;
    try {
      track = Spicetify.Player.data?.item?.uri ?? null;
    } catch {
    }
    return (await readTrack(track)).style;
  }
  async function prepare(track) {
    uri = track;
    lastBar = null;
    maxBar = -1;
    restUntil = -1;
    lastJumpBar = -10;
    yieldUntil = -1;
    clearTimers();
    letUpMine();
    styleReady = false;
    lines = null;
    seed = hash(track ?? "");
    if (!track) return;
    const [reading, words] = await Promise.all([readTrack(track), loadLines(track)]);
    if (uri !== track) return;
    detected = reading.style;
    const artist = currentArtist();
    style = (artist ? pickedStyle(artist.uri) : null) ?? reading.style;
    styleReady = true;
    lines = words;
  }
  function startDj() {
    if (running) return;
    running = true;
    let track = null;
    try {
      track = Spicetify.Player.data?.item?.uri ?? null;
    } catch {
    }
    void prepare(track);
    unsub = subscribe(tick);
  }
  function stopDj() {
    running = false;
    unsub?.();
    unsub = null;
    clearTimers();
    letUpMine();
  }
  function djYield(move) {
    const grid = gridFor();
    const bar = grid ? barIndexAt(grid, needlePosition()) : -1;
    if (move && bar >= 0) {
      void trackStyle().then((kind) => noteMove(kind, move, bar % PHRASE));
    }
    if (!running) return;
    clearTimers();
    letUpMine();
    if (bar >= 0) yieldUntil = bar + YIELD_BARS;
  }
  function tick() {
    if (!running) return;
    let track = null;
    try {
      track = Spicetify.Player.data?.item?.uri ?? null;
    } catch {
      return;
    }
    if (track !== uri) {
      void prepare(track);
      return;
    }
    if (!playing()) {
      clearTimers();
      letUpMine();
      return;
    }
    if (!styleReady) return;
    const grid = gridFor();
    if (!grid) return;
    const heard = needlePosition();
    const bar = barIndexAt(grid, heard);
    if (bar < 0) return;
    const last = lastBar;
    lastBar = bar;
    if (last === null || bar === last) return;
    if (bar !== last + 1) {
      const own = Date.now() - jumpedAt < OWN_JUMP_MS;
      if (bar > maxBar) maxBar = bar;
      else if (!own && bar < maxBar - MOVED_BARS) maxBar = bar;
      return;
    }
    if (bar <= maxBar) return;
    maxBar = bar;
    if (bar < yieldUntil || isLooping()) return;
    play(grid, bar, heard);
  }
  function sectionIndex(sections, ms) {
    let found = -1;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].start > ms) break;
      found = i;
    }
    return found;
  }
  function pick(weights, roll) {
    const total = weights.reduce((sum, [, w]) => sum + w, 0);
    let at2 = roll * total;
    for (const [bars, w] of weights) {
      at2 -= w;
      if (at2 <= 0) return bars;
    }
    return weights[0][0];
  }
  function hold(name, from, to, label, beatMs) {
    if (!canHold() || isHeld(name)) return;
    at(from, () => {
      if (isHeld(name)) return;
      if (!press(name, name === "screw" ? { cents: -500 } : { beatMs })) return;
      mine2.add(name);
      say(label);
      at(to, () => {
        if (!mine2.delete(name)) return;
        release(name);
      });
    });
  }
  function play(grid, bar, heard) {
    const plan = PLANS[style];
    const roll = dice(bar);
    const start = barStartMs(grid, bar);
    const length = barLengthMs(grid, bar);
    const end = start + length;
    const beat = beatLengthMs(grid, Math.max(0, beatIndexAt(grid, heard)));
    const learnt = bar % PHRASE;
    const weigh = (move, chance) => Math.min(0.95, chance * HAND_WEIGHT[hand] * lean(style, move, learnt));
    const sections = grid.sections;
    const here = sectionIndex(sections, start + length / 2);
    const next = here + 1 < sections.length ? sections[here + 1] : null;
    const lastOfSection = next !== null && Math.abs(next.start - end) < length / 2;
    const firstOfSection = here >= 0 && Math.abs(sections[here].start - start) < length / 2;
    const loudest = sections.reduce((max, s) => Math.max(max, s.loudness), -Infinity);
    const sorted = sections.map((s) => s.loudness).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : -60;
    const hook = here >= 0 && sections.length >= 3 && sections[here].loudness >= loudest - 1.5;
    const breakdown = here >= 0 && sections.length >= 3 && sections[here].loudness <= median - 4;
    let jumped = false;
    const resting = bar < restUntil;
    const phrase = Math.max(2, Math.round(plan.phrase * HAND_PHRASE[hand]));
    if (bar - lastJumpBar >= 2 && bar >= phrase && bar % phrase === 0) {
      const bars = pick(plan.chopBars, roll());
      const move = bars === 1 ? "chop1" : bars === 2 ? "chop2" : "chop4";
      if (roll() < weigh(move, plan.chop) && bar >= bars) {
        jumped = true;
        jumpedAt = Date.now();
        void chopBars(bars, true).then((did) => {
          if (did) say(`DJ: ${bars === 1 ? "a bar" : `${bars} bars`} back`);
        });
      }
    }
    if (!jumped && !resting && lastOfSection) {
      const r = roll();
      const loop = weigh("loop", plan.loop);
      if (r < loop) {
        jumped = true;
        jumpedAt = Date.now();
        void loopBars(1).then((did) => {
          if (did) say("DJ: looped the bar");
        });
      } else if (r < loop + weigh("spin", plan.spin)) {
        jumped = true;
        const turn = Math.max(350, Math.min(650, beat));
        at(end - turn - 30, () => {
          jumpedAt = Date.now();
          void spinBack();
        });
      }
    }
    if (!jumped && !resting && lines) {
      const fresh = lines.find((line) => line.startMs >= start && line.startMs < end);
      if (fresh && roll() < weigh("line", plan.line)) {
        jumped = true;
        at(fresh.startMs + 150, () => {
          jumpedAt = Date.now();
          void runLineBack();
        });
      }
    }
    if (lastOfSection && roll() < weigh("echo", plan.echo)) hold("echo", end - beat, end, "DJ: echo thrown", beat);
    const screwChance = hook ? plan.screw : sections.length < 3 && bar % phrase === 1 ? plan.screw * 0.4 : 0;
    if (screwChance > 0 && roll() < weigh("screw", screwChance)) hold("screw", start, end - beat / 4, "DJ: Screw on the hook", beat);
    if (firstOfSection && breakdown && roll() < weigh("trunk", plan.trunk)) {
      hold("trunk", start, start + length * 2 - beat / 4, "DJ: trunk shut", beat);
    }
    if (jumped) {
      restUntil = bar + REST_BARS[hand] + 1;
      lastJumpBar = bar;
    }
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
  var TYRE_RADIUS = 21;
  var WHEEL_SIZE = 47;
  var POKE_X = 1.6;
  var POKE_Y = 2.3;
  var HALF = WHEEL_SIZE / 2;
  var BOX = `viewBox="${-HALF} ${-HALF} ${WHEEL_SIZE} ${WHEEL_SIZE}" width="${WHEEL_SIZE}" height="${WHEEL_SIZE}" aria-hidden="true" focusable="false"`;
  var CHROME = (id) => `
  <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#F7F9F9"/><stop offset=".42" stop-color="#D7DCDF"/>
    <stop offset=".56" stop-color="#8F979C"/><stop offset=".78" stop-color="#C9CFD3"/>
    <stop offset="1" stop-color="#EEF1F2"/>
  </linearGradient>`;
  var WHEEL_STATIC = `
<svg class="slab-wheel-base" ${BOX}>
  <defs>${CHROME("slab-chrome-rim")}</defs>
  <circle cy="2" r="${TYRE_RADIUS + 1}" fill="#000" opacity=".5"/>
  <circle r="${TYRE_RADIUS}" fill="#0E0D0D"/>
  <circle r="${TYRE_RADIUS - 0.6}" fill="none" stroke="#343332" stroke-width=".7"/>
  <circle r="17.6" fill="none" stroke="#F4F0E6" stroke-width="1.45"/>
  <circle r="16.15" fill="none" stroke="#E2B53A" stroke-width=".85"/>
  <circle r="13.3" fill="none" stroke="url(#slab-chrome-rim)" stroke-width="1.8"/>
  <circle class="slab-well" r="12.4" fill="#121416"/>
</svg>`;
  function wheelSpokes() {
    let spokes = "";
    for (let i = 0; i < 30; i++) {
      const a = i * 12;
      spokes += `<path d="M${polar(12.3, a - 2.9)}L${polar(6.8, a - 3.8)}L${polar(6.8, a + 3.8)}L${polar(12.3, a + 2.9)}Z" fill="#B9C0C5"/>`;
      spokes += `<path d="M${polar(12.05, a - 1.1)}L${polar(7.05, a - 1.5)}" stroke="#FFFFFF" stroke-width=".5"/>`;
    }
    return `<svg class="slab-wheel-spokes" ${BOX}>${spokes}</svg>`;
  }
  var WHEEL_SPOKES = wheelSpokes();
  var WHEEL_CONE = `
<svg class="slab-wheel-cone" ${BOX}>
  <defs>
   <radialGradient id="slab-poke-cone" cx=".34" cy=".30" r=".75">
     <stop offset="0" stop-color="#FFFFFF"/><stop offset=".28" stop-color="#EEF1F2"/>
     <stop offset=".68" stop-color="#9EA6AB"/><stop offset="1" stop-color="#4E565B"/>
   </radialGradient>
   <radialGradient id="slab-poke-cast" cx=".5" cy=".5" r=".5">
     <stop offset="0" stop-color="#000" stop-opacity=".75"/><stop offset=".55" stop-color="#000" stop-opacity=".38"/>
     <stop offset="1" stop-color="#000" stop-opacity="0"/>
   </radialGradient>
  </defs>
  <ellipse cx="${fmt(POKE_X + 2.5)}" cy="${fmt(POKE_Y + 3.2)}" rx="9.3" ry="8.4" fill="url(#slab-poke-cast)"/>
  <circle r="7.15" fill="none" stroke="#F5F7F8" stroke-width="1.1"/>
  <path d="M${polar(6.8, -120)}A6.8 6.8 0 1 0 ${polar(6.8, 60)}L${POKE_X} ${POKE_Y}Z" fill="#6F777C"/>
  <circle cx="${fmt(POKE_X * 0.55)}" cy="${fmt(POKE_Y * 0.55)}" r="6.1" fill="url(#slab-poke-cone)"/>
</svg>`;
  var WHEEL_KNOCKOFF = `
<svg class="slab-wheel-knock" ${BOX}>
  <g transform="translate(${POKE_X} ${POKE_Y})">
    <path d="M-7.7 -2L-2.6 -1.45L2.6 -1.45L7.7 -2L7.7 2L2.6 1.45L-2.6 1.45L-7.7 2Z" fill="#F1F4F5" stroke="#16181A" stroke-width=".65" stroke-linejoin="round"/>
    <circle r="1.8" fill="#FFFFFF" stroke="#16181A" stroke-width=".55"/>
  </g>
</svg>`;
  var BIG_WHEEL_SCALE = 3.1;
  var BIG_WHEEL_RING = Math.round((TYRE_RADIUS + 1.6) * BIG_WHEEL_SCALE);
  var BIG_WHEEL_BOX = (BIG_WHEEL_RING + 14) * 2;
  function bigWheel() {
    const k = BIG_WHEEL_SCALE;
    const half = BIG_WHEEL_BOX / 2;
    const box = `viewBox="${-half} ${-half} ${BIG_WHEEL_BOX} ${BIG_WHEEL_BOX}" width="${BIG_WHEEL_BOX}" height="${BIG_WHEEL_BOX}" aria-hidden="true" focusable="false"`;
    const base = `
<svg class="slab-bigwheel-base" ${box}>
  <circle r="${fmt(TYRE_RADIUS * k)}" fill="#0B0304" opacity=".55"/>
  <circle r="${fmt(17.6 * k)}" fill="none" stroke="#F4F0E6" stroke-width="${fmt(1.45 * k)}" opacity=".24"/>
  <circle r="${fmt(16.15 * k)}" fill="none" stroke="#E2B53A" stroke-width="${fmt(0.85 * k)}" opacity=".34"/>
  <circle r="${fmt(13.3 * k)}" fill="none" stroke="#C9CFD3" stroke-width="${fmt(1.8 * k)}" opacity=".26"/>
  <circle r="${fmt(12.4 * k)}" fill="#0B0304" opacity=".5"/>
</svg>`;
    let spokes = "";
    for (let i = 0; i < 30; i++) {
      const a = i * 12;
      spokes += `<path d="M${polar(12.3 * k, a - 2.9)}L${polar(6.8 * k, a - 3.8)}L${polar(6.8 * k, a + 3.8)}L${polar(12.3 * k, a + 2.9)}Z"/>`;
    }
    const turn = `
<svg class="slab-bigwheel-turn" ${box}>
  <g fill="#C9CFD3" opacity=".27">${spokes}</g>
  <circle r="${fmt(7.15 * k)}" fill="none" stroke="#F5F7F8" stroke-width="${fmt(1.1 * k)}" opacity=".3"/>
  <path d="M${fmt(-7.7 * k)} ${fmt(-2 * k)}L${fmt(-2.6 * k)} ${fmt(-1.45 * k)}L${fmt(2.6 * k)} ${fmt(-1.45 * k)}L${fmt(7.7 * k)} ${fmt(-2 * k)}L${fmt(7.7 * k)} ${fmt(2 * k)}L${fmt(2.6 * k)} ${fmt(1.45 * k)}L${fmt(-2.6 * k)} ${fmt(1.45 * k)}L${fmt(-7.7 * k)} ${fmt(2 * k)}Z" fill="#F1F4F5" opacity=".34"/>
</svg>`;
    return { base, turn };
  }
  var BIG_WHEEL = bigWheel();
  function bigWheelRingPath() {
    const c = BIG_WHEEL_BOX / 2;
    const r = BIG_WHEEL_RING;
    return `M${fmt(c - r)} ${fmt(c)}A${r} ${r} 0 1 1 ${fmt(c + r)} ${fmt(c)}A${r} ${r} 0 1 1 ${fmt(c - r)} ${fmt(c)}Z`;
  }
  function chipIcon() {
    let spokes = "";
    for (let i = 0; i < 10; i++) spokes += `<path d="M${polar(5, i * 36 + 18, 10, 10)}L${polar(2.2, i * 36 + 18, 10, 10)}"/>`;
    return `
<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
  <circle class="slab-chip-tyre" cx="10" cy="10" r="8.7" stroke="currentColor" stroke-width="1.8"/>
  <circle class="slab-chip-plain" cx="10" cy="10" r="6.4" stroke="currentColor" stroke-width="1"/>
  <g class="slab-chip-vogue"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.3"/><circle cx="10" cy="10" r="5.9" stroke="#E2B53A" stroke-width=".8"/></g>
  <g stroke="currentColor" stroke-width="1" stroke-linecap="round">${spokes}</g>
  <path d="M6.4 9.2H13.6V10.8H6.4Z" fill="currentColor"/>
  <circle cx="10" cy="10" r="1.3" fill="currentColor"/>
</svg>`;
  }
  var CHIP_ICON = chipIcon();
  var CLOSE_ICON = `
<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
  <path d="M1.5 1.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;
  function phillips(slot) {
    return `<svg class="slab-screw" viewBox="-4 -4 8 8" width="8" height="8" aria-hidden="true" focusable="false">
  <circle r="3.7" fill="#4A4E52"/><circle r="3.1" fill="#C3C8CC"/><circle r="3.1" fill="none" stroke="#F2F4F5" stroke-width=".5" stroke-dasharray="4.9 14.6" transform="rotate(200)"/>
  <path d="M${polar(2.2, slot)}L${polar(2.2, slot + 180)}M${polar(2.2, slot + 90)}L${polar(2.2, slot + 270)}" stroke="#2B2D30" stroke-width=".9" stroke-linecap="round"/>
</svg>`;
  }
  var SILL_SCREW_LEFT = phillips(28);
  var SILL_SCREW_RIGHT = phillips(71);

  // src/ui/neon-glyphs.ts
  var NEON_GLYPHS = {
    "0": { a: 48, l: "M0 -36L0 -19C0 -8.5 8.5 0 19 0L19 0C29.5 0 38 -8.5 38 -19L38 -71C38 -81.5 29.5 -90 19 -90L19 -90C8.5 -90 0 -81.5 0 -71L0 -44", d: "", i: [0, -36], o: [0, -44] },
    "1": { a: 32, l: "M4 -80L9.2 -86.9C12.7 -91.4 20 -89 20 -83.2L20 0", d: "", i: [4, -80], o: [20, 0] },
    "2": { a: 48, l: "M0 -70L0 -74C0 -82.8 7.2 -90 16 -90L22 -90C30.8 -90 38 -82.8 38 -74L38 -61.8C38 -58.1 36.3 -54.7 33.4 -52.4L3.8 -29C1.4 -27.1 0 -24.2 0 -21.2L0 -8C0 -3.6 3.6 0 8 0L38 0", d: "", i: [0, -70], o: [38, 0] },
    "3": { a: 48, l: "M0 -72L0 -74C0 -82.8 7.2 -90 16 -90L22 -90C30.8 -90 38 -82.8 38 -74L38 -16C38 -7.2 30.8 0 22 0L16 0C7.2 0 0 -7.2 0 -16L0 -18M32 -47L14 -47", d: "M0 -18L0 -16C0 -7.2 7.2 0 16 0L22 0C30.8 0 38 -7.2 38 -16L38 -47L32 -47", i: [0, -72], o: [14, -47] },
    "4": { a: 50, l: "M25 -90L4.6 -41.1C2.4 -35.8 6.3 -30 12 -30L29 -30M40 -30L44 -30M32 0L32 -90", d: "M29 -30L40 -30M44 -30L32 -30L32 0", i: [25, -90], o: [32, -90] },
    "5": { a: 48, l: "M36 -90L8 -90C3.6 -90 0 -86.4 0 -82L0 -58C0 -54.7 2.7 -52 6 -52L22 -52C30.8 -52 38 -44.8 38 -36L38 -16C38 -7.2 30.8 0 22 0L14 0C6.3 0 0 -6.3 0 -14L0 -18", d: "", i: [36, -90], o: [0, -18] },
    "6": { a: 48, l: "M38 -72L38 -74C38 -82.8 30.8 -90 22 -90L19 -90C8.5 -90 0 -81.5 0 -71L0 -19C0 -8.5 8.5 0 19 0L19 0C29.5 0 38 -8.5 38 -19L38 -34C38 -42.8 30.8 -50 22 -50L8 -50", d: "", i: [38, -72], o: [8, -50] },
    "7": { a: 46, l: "M0 -90L30.2 -90C34.1 -90 37 -86.3 36 -82.5L14 0", d: "", i: [0, -90], o: [14, 0] },
    "8": { a: 48, l: "M38 -27L38 -29C38 -39.5 29.5 -48 19 -48L19 -48C8.5 -48 0 -39.5 0 -29L0 -19C0 -8.5 8.5 0 19 0L19 0C29.5 0 38 -8.5 38 -19L38 -21M3 -72L3 -74C3 -82.8 10.2 -90 19 -90L19 -90C27.8 -90 35 -82.8 35 -74L35 -66C35 -57.2 27.8 -50 19 -50L19 -50C10.2 -50 3 -57.2 3 -66L3 -66", d: "", i: [38, -27], o: [3, -66] },
    "9": { a: 48, l: "M0 -18L0 -16C0 -7.2 7.2 0 16 0L19 0C29.5 0 38 -8.5 38 -19L38 -71C38 -81.5 29.5 -90 19 -90L19 -90C8.5 -90 0 -81.5 0 -71L0 -56C0 -47.2 7.2 -40 16 -40L30 -40", d: "", i: [0, -18], o: [30, -40] },
    "a": { a: 46, l: "M34 0L34 -57C34 -64.2 28.2 -70 21 -70L17 -70C7.6 -70 0 -62.4 0 -53L0 -17C0 -7.6 7.6 0 17 0L28 0", d: "", i: [34, 0], o: [28, 0], s: [[34, -20]] },
    "b": { a: 46, l: "M0 -100L0 -17C0 -7.6 7.6 0 17 0L17 0C26.4 0 34 -7.6 34 -17L34 -53C34 -62.4 26.4 -70 17 -70L6 -70", d: "M17 0L17 0C7.6 0 0 -7.6 0 -17L0 -100M6 -70L17 -70C26.4 -70 34 -62.4 34 -53L34 -17C34 -7.6 26.4 0 17 0L17 0", i: [17, 0], o: [17, 0], s: [[0, -22]] },
    "c": { a: 42, l: "M30 0L17 0C7.6 0 0 -7.6 0 -17L0 -53C0 -62.4 7.6 -70 17 -70L30 -70", d: "M17 0L30 0M30 -70L17 -70C7.6 -70 0 -62.4 0 -53L0 -17C0 -7.6 7.6 0 17 0L17 0", i: [17, 0], o: [17, 0] },
    "d": { a: 46, l: "M34 -100L34 -17C34 -7.6 26.4 0 17 0L17 0C7.6 0 0 -7.6 0 -17L0 -53C0 -62.4 7.6 -70 17 -70L28 -70", d: "M17 0L17 0C26.4 0 34 -7.6 34 -17L34 -100M28 -70L17 -70C7.6 -70 0 -62.4 0 -53L0 -17C0 -7.6 7.6 0 17 0L17 0", i: [17, 0], o: [17, 0], s: [[34, -22]] },
    "e": { a: 44, l: "M6 -36L24 -36C29.5 -36 34 -40.5 34 -46L34 -53C34 -62.4 26.4 -70 17 -70L17 -70C7.6 -70 0 -62.4 0 -53L0 -17C0 -7.6 7.6 0 17 0L30 0", d: "M17 0L17 0C7.6 0 0 -7.6 0 -17L0 -36L6 -36", i: [17, 0], o: [30, 0] },
    "h": { a: 46, l: "M0 -100L0 0M6 -70L17 -70C26.4 -70 34 -62.4 34 -53L34 0", d: "M0 0L0 -100M0 0L0 -70L6 -70", i: [0, 0], o: [34, 0], s: [[0, -20]] },
    "i": { a: 22, l: "M0 -84L0 -96M0 -70L0 0", d: "M0 0L0 -84M0 -96L0 -70", i: [0, 0], o: [0, 0], s: [[0, -20]] },
    "l": { a: 22, l: "M0 -100L0 0", d: "M0 0L0 -100", i: [0, 0], o: [0, 0], s: [[0, -20]] },
    "m": { a: 70, l: "M0 0L0 -56C0 -63.7 6.3 -70 14 -70L15 -70C22.7 -70 29 -63.7 29 -56L29 0M35 -70L44 -70C51.7 -70 58 -63.7 58 -56L58 0", d: "M29 0L29 -70L35 -70", i: [0, 0], o: [58, 0], s: [[0, -20], [58, -20]] },
    "n": { a: 46, l: "M0 0L0 -53C0 -62.4 7.6 -70 17 -70L17 -70C26.4 -70 34 -62.4 34 -53L34 0", d: "", i: [0, 0], o: [34, 0], s: [[0, -20]] },
    "o": { a: 46, l: "M0 -36L0 -17C0 -7.6 7.6 0 17 0L17 0C26.4 0 34 -7.6 34 -17L34 -53C34 -62.4 26.4 -70 17 -70L17 -70C7.6 -70 0 -62.4 0 -53L0 -44", d: "M17 0L17 0C7.6 0 0 -7.6 0 -17L0 -36M0 -44L0 -17C0 -7.6 7.6 0 17 0L17 0", i: [17, 0], o: [17, 0] },
    "p": { a: 46, l: "M0 26L0 -53C0 -62.4 7.6 -70 17 -70L17 -70C26.4 -70 34 -62.4 34 -53L34 -17C34 -7.6 26.4 0 17 0L6 0", d: "", i: [0, 26], o: [6, 0], s: [[0, 12]] },
    "r": { a: 38, l: "M0 0L0 -57C0 -64.2 5.8 -70 13 -70L18 -70C23.5 -70 28 -65.5 28 -60L28 -58", d: "M28 -58L28 -60C28 -65.5 23.5 -70 18 -70L13 -70C5.8 -70 0 -64.2 0 -57L0 0", i: [0, 0], o: [0, 0], s: [[0, -20]] },
    "s": { a: 42, l: "M0 -12L0 -12C0 -5.4 5.4 0 12 0L16 0C23.7 0 30 -6.3 30 -14L30 -21C30 -28.7 23.7 -35 16 -35L14 -35C6.3 -35 0 -41.3 0 -49L0 -56C0 -63.7 6.3 -70 14 -70L18 -70C24.6 -70 30 -64.6 30 -58L30 -58", d: "M14 0L12 0C5.4 0 0 -5.4 0 -12L0 -12M30 -58L30 -58C30 -64.6 24.6 -70 18 -70L14 -70C6.3 -70 0 -63.7 0 -56L0 -49C0 -41.3 6.3 -35 14 -35L16 -35C23.7 -35 30 -28.7 30 -21L30 -14C30 -6.3 23.7 0 16 0L14 0", i: [14, 0], o: [14, 0] },
    "t": { a: 38, l: "M0 -70L11 -70M23 -70L30 -70M14 -92L14 -10C14 -4.5 18.5 0 24 0L26 0", d: "M26 0L24 0C18.5 0 14 -4.5 14 -10L14 -70L0 -70M11 -70L23 -70M30 -70L14 -70L14 -92", i: [26, 0], o: [26, 0], s: [[14, -20]] },
    "v": { a: 44, l: "M0 -70L10.2 -5.1C10.7 -2.2 13.2 0 16.1 0L17.9 0C20.8 0 23.3 -2.2 23.8 -5.1L34 -70", d: "M17 0L16.1 0C13.2 0 10.7 -2.2 10.2 -5.1L0 -70M34 -70L23.8 -5.1C23.3 -2.2 20.8 0 17.9 0L17 0", i: [17, 0], o: [17, 0] },
    "w": { a: 70, l: "M0 -70L5.5 -5.5C5.8 -2.4 8.4 0 11.5 0L12.7 0C15.7 0 18.3 -2.2 18.7 -5.2L24 -46.8C25 -53.7 35 -53.7 36 -46.8L41.3 -5.2C41.7 -2.2 44.3 0 47.3 0L48.5 0C51.6 0 54.2 -2.4 54.5 -5.5L60 -70", d: "M12 0L11.5 0C8.4 0 5.8 -2.4 5.5 -5.5L0 -70M60 -70L54.5 -5.5C54.2 -2.4 51.6 0 48.5 0L48 0", i: [12, 0], o: [48, 0] },
    "C": { a: 52, l: "M40 0L21 0C9.4 0 0 -9.4 0 -21L0 -79C0 -90.6 9.4 -100 21 -100L40 -100", d: "M24 0L40 0M40 -100L21 -100C9.4 -100 0 -90.6 0 -79L0 -21C0 -9.4 9.4 0 21 0L24 0", i: [24, 0], o: [24, 0] },
    "F": { a: 46, l: "M0 0L0 -88C0 -94.6 5.4 -100 12 -100L38 -100M6 -54L30 -54", d: "M38 -100L12 -100C5.4 -100 0 -94.6 0 -88L0 -54L6 -54M30 -54L0 -54L0 0", i: [0, 0], o: [0, 0], s: [[0, -20]] },
    "M": { a: 70, l: "M0 0L0 -94C0 -97.3 2.7 -100 6 -100L7.1 -100C9.9 -100 12.4 -98 13 -95.2L23.1 -44.8C24.4 -38.4 33.6 -38.4 34.9 -44.8L45 -95.2C45.6 -98 48.1 -100 50.9 -100L52 -100C55.3 -100 58 -97.3 58 -94L58 0", d: "", i: [0, 0], o: [58, 0], s: [[0, -20], [58, -20]] },
    "R": { a: 54, l: "M0 0L0 -87C0 -94.2 5.8 -100 13 -100L20 -100C31 -100 40 -91 40 -80L40 -72C40 -61 31 -52 20 -52L6 -52M25.2 -46.4L44 0", d: "M6 -52L23 -52L25.2 -46.4", i: [0, 0], o: [44, 0], s: [[0, -20]] },
    "S": { a: 52, l: "M0 -16L0 -14C0 -6.3 6.3 0 14 0L22 0C31.9 0 40 -8.1 40 -18L40 -32C40 -41.9 31.9 -50 22 -50L18 -50C8.1 -50 0 -58.1 0 -68L0 -82C0 -91.9 8.1 -100 18 -100L26 -100C33.7 -100 40 -93.7 40 -86L40 -84", d: "M18 0L14 0C6.3 0 0 -6.3 0 -14L0 -16M40 -84L40 -86C40 -93.7 33.7 -100 26 -100L18 -100C8.1 -100 0 -91.9 0 -82L0 -68C0 -58.1 8.1 -50 18 -50L22 -50C31.9 -50 40 -41.9 40 -32L40 -18C40 -8.1 31.9 0 22 0L18 0", i: [18, 0], o: [18, 0] },
    "T": { a: 50, l: "M22 0L22 -94M0 -100L44 -100", d: "M22 -94L22 -100L0 -100M44 -100L22 -100L22 0", i: [22, 0], o: [22, 0], s: [[22, -20]] },
    "U": { a: 56, l: "M0 -100L0 -22C0 -9.8 9.8 0 22 0L22 0C34.2 0 44 -9.8 44 -22L44 -100", d: "M22 0L22 0C9.8 0 0 -9.8 0 -22L0 -100M44 -100L44 -22C44 -9.8 34.2 0 22 0L22 0", i: [22, 0], o: [22, 0], s: [[0, -30], [44, -30]] },
    "+": { a: 48, l: "M19 -20L19 -70M0 -45L16 -45M27 -45L38 -45", d: "M19 -70L19 -45L0 -45M16 -45L27 -45", i: [19, -20], o: [38, -45], f: true },
    "\u2212": { a: 42, l: "M0 -45L30 -45", d: "", i: [0, -45], o: [30, -45] }
  };

  // src/ui/neon.ts
  var NUMBER = /-?\d*\.?\d+/g;
  var SPACE_ADVANCE = 34;
  var SHARED_BOOT = 8;
  var BOOT_LENGTH = 3.5;
  var CLIP = 2.3;
  function fmt2(value) {
    return String(Math.round(value * 10) / 10);
  }
  function place(d, scale, dx, dy) {
    let isX = true;
    return d.replace(NUMBER, (token) => {
      const value = Number(token) * scale + (isX ? dx : dy);
      isX = !isX;
      return fmt2(value);
    });
  }
  function placeText(text, scale, tracking, x, y, eachGlyphFloats = false) {
    const units = [{ glyphs: [], floating: false }];
    const fresh = (floating) => {
      if (units[units.length - 1].glyphs.length) units.push({ glyphs: [], floating });
      else units[units.length - 1].floating = floating;
    };
    let pen = x;
    for (const char of [...text]) {
      if (char === " ") {
        fresh(false);
        pen += SPACE_ADVANCE * scale + tracking;
        continue;
      }
      const glyph = NEON_GLYPHS[char];
      if (!glyph) continue;
      const floats = eachGlyphFloats || glyph.f === true;
      if (floats || units[units.length - 1].floating) fresh(floats);
      units[units.length - 1].glyphs.push({
        lit: place(glyph.l, scale, pen, y),
        dark: place(glyph.d, scale, pen, y),
        entry: [glyph.i[0] * scale + pen, glyph.i[1] * scale + y],
        exit: [glyph.o[0] * scale + pen, glyph.o[1] * scale + y],
        supports: (glyph.s ?? []).map(([sx, sy]) => [sx * scale + pen, sy * scale + y])
      });
      pen += glyph.a * scale + tracking;
    }
    return units.filter((unit2) => unit2.glyphs.length > 0);
  }
  function inkBounds(units) {
    let left = Infinity;
    let right = -Infinity;
    for (const unit2 of units) {
      for (const glyph of unit2.glyphs) {
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
  function chooseSupports(unit2) {
    const holders = unit2.glyphs.filter((glyph) => glyph.supports.length > 0);
    if (holders.length === 0) return [];
    const picked = /* @__PURE__ */ new Set([holders[0], holders[holders.length - 1]]);
    if (unit2.glyphs.length >= 6 && holders.length >= 3) picked.add(holders[Math.floor(holders.length / 2)]);
    return [...picked].map((glyph) => glyph.supports[0]);
  }
  function thread(units, baseline2, drop) {
    let lit = "";
    let dark = "";
    let boots = "";
    let supports = "";
    const rail = baseline2 + drop;
    for (const unit2 of units) {
      if (unit2.floating) {
        for (const glyph of unit2.glyphs) {
          lit += glyph.lit;
          dark += glyph.dark;
        }
        continue;
      }
      let previous = null;
      for (const glyph of unit2.glyphs) {
        if (previous) {
          dark += `M${fmt2(previous[0])} ${fmt2(previous[1])}V${fmt2(rail)}H${fmt2(glyph.entry[0])}V${fmt2(glyph.entry[1])}`;
        }
        lit += glyph.lit;
        dark += glyph.dark;
        previous = glyph.exit;
      }
      const start = unit2.glyphs[0].entry;
      const end = previous;
      const shared = Math.abs(end[0] - start[0]) < SHARED_BOOT;
      const bootAt = shared ? [(start[0] + end[0]) / 2] : [start[0], end[0]];
      dark += `M${fmt2(start[0])} ${fmt2(start[1])}V${fmt2(rail)}M${fmt2(end[0])} ${fmt2(end[1])}V${fmt2(rail)}`;
      if (shared) dark += `M${fmt2(start[0])} ${fmt2(rail)}H${fmt2(end[0])}`;
      for (const x of bootAt) boots += `M${fmt2(x)} ${fmt2(rail)}v${BOOT_LENGTH}`;
      for (const [x, y] of chooseSupports(unit2)) supports += `M${fmt2(x - CLIP)} ${fmt2(y)}H${fmt2(x + CLIP)}`;
    }
    return { lit, dark, boots, supports };
  }
  var SIGN_WIDTH = 360;
  var SIGN_HEIGHT = 70;
  var SIGN_FIT = {
    sped: { tracking: 5, margin: 40 },
    flat: { tracking: 6, margin: 20 },
    chopped: { tracking: 4, margin: 22 },
    slowed: { tracking: 3, margin: 20 },
    memphis: { tracking: 3, margin: 20 },
    screwed: { tracking: 4, margin: 22 }
  };
  var CAP_HEIGHT = 100;
  var DESCENDER = 26;
  var UNDER = 9;
  var MIN_MARGIN = 19;
  function signLayout(id, name, height = SIGN_HEIGHT) {
    const fit = SIGN_FIT[id] ?? { tracking: 4, margin: 22 };
    const margin = Math.max(MIN_MARGIN, fit.margin);
    const gaps = [...name].length - 1;
    const descends = /[pq]/.test(name);
    const room = height - 3 - UNDER;
    const byHeight = (descends ? room * CAP_HEIGHT / (CAP_HEIGHT + DESCENDER) : room) / CAP_HEIGHT;
    const [unitLeft, unitRight] = inkBounds(placeText(name, 1, 0, 0, 0));
    const byWidth = (SIGN_WIDTH - margin * 2 - fit.tracking * gaps) / (unitRight - unitLeft);
    const scale = Math.min(byHeight, byWidth);
    const block = CAP_HEIGHT * scale + (descends ? DESCENDER * scale : 0) + UNDER;
    const top = 3 + Math.max(0, (height - 3 - block) / 2);
    const baseline2 = top + CAP_HEIGHT * scale;
    const [left, right] = inkBounds(placeText(name, scale, fit.tracking, 0, baseline2));
    const dx = (SIGN_WIDTH - (right - left)) / 2 - left;
    const units = placeText(name, scale, fit.tracking, dx, baseline2);
    return thread(units, baseline2, 3);
  }
  var NUMBER_WIDTH = 118;
  var NUMBER_HEIGHT = 42;
  var NUMBER_SCALE = 0.36;
  var NUMBER_TRACKING = 2;
  var NUMBER_BASELINE = 36;
  function numberLayout(cents) {
    const text = cents === 0 ? "0" : `${cents < 0 ? "\u2212" : "+"}${Math.abs(cents)}`;
    const [, right] = inkBounds(placeText(text, NUMBER_SCALE, NUMBER_TRACKING, 0, NUMBER_BASELINE, true));
    const units = placeText(text, NUMBER_SCALE, NUMBER_TRACKING, NUMBER_WIDTH - right - 4, NUMBER_BASELINE, true);
    return thread(units, NUMBER_BASELINE, 2.5);
  }

  // src/ui/fonts.generated.ts
  var FONT_CSS = '@font-face{font-family:"SLAB Barlow";font-weight:500;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,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) format("woff2")}\n@font-face{font-family:"SLAB Barlow";font-weight:600;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,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) format("woff2")}\n@font-face{font-family:"SLAB Barlow";font-weight:700;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,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) format("woff2")}\n@font-face{font-family:"SLAB Barlow Tall";font-weight:700;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,d09GMgABAAAAABcgABAAAAAANGAAABbCAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG4FsHIIEBmAARAiBIAmcFREICrtAs0MLWgABNgIkA4EwBCAFgz4HIAyBVhvxLrMREWwcAAitXaIomZxVZP/lgU2Gug57TTAb7Y2x/2BoZLgUm1f7Vpv7yN/ONk1DCeHb2zaXwECgAW3xDWbxGz2V46WxbHs9HSHJrP98zfWde59UUoSoESECCcE8VKSdpsWgxTVffcy24zAivhrfiVoI4o99s/srQOIigc5T257INUuU4YnXDuBptU1SJCnDcqgGNsXgYuvg4ib0APbO3Z4HUA+aZks7QGjJ8j7sNNWPtgrTofqkKQPPpy3dCxQVkAJf+eEbbYAMqKOEzw5JQcm3vqJ2UW9XPa3ZTQcVKk79H2r//K+rRQOUxMaQrb4hz9adupAydJehP/9dpv+9Td/2nhVYDu+4ChDWtoLYE0///OS1972VbEv6FpokE0oh2Z+0loIEBpI/BZgqoqZIlaZMUf4yZR+oYjr7e3dJKEK6RFGayniKLUYjPE40y2DP3m0HLazjEfNTp6WqwWA8dImasT0BWawtK+mrl29fJwiAiW5DuLl6fjucZw9dPQ8nJADcFGY4c+zyediAvaUhwYkC+1U4lOHnVBdEBX+Ba2GCDegBGUGqWhaHiD6qm2T1Hgw2bNwqA0Z8NZkdC9aqmzCkLL8zbTDdMEmU2/97tvxN/Sfu+Jph+yv7xh9B9M/4fI2AdHOvlJ1VlB/Md+fq6PkL5zD1fyX0xdDNtXOXUb6bIsg/IZni0ngNCQGDr+N7UxMMtFzW0lSW5KaWhOPCq+sPuNuTTKFp7pzaAb9Hn4sKUNDI6wcBcEeXIryrAck0ARfx84tbFEmVYLZJeld+Qs0IfjoXAWx4XQvtx1CMdAM2jX67hKe8/bq+hLepbPjELysF5DB5U6BXuArmKJByPMrAclU/AVIlBoQN/PyRKyY3fO16VwYe7/VTV79bCL07jH9BfgHm9v8rBXo9B7rlzdrtQmvbf684KNayRtIIN5/1Mos31cVfqL/yXppjoBjx8U6T3rb83zXlVGUBO8Ioinw4gfPuA/rhV2DkmOJbmku74xWOfGqTBWlnumOsBUugocMOJEzeQSBVzR0MtWodAtLsi51LlR/go6TkC+8MfMlNE+a3PcHhMAe5Qd7udTw1xeRJ9zcszEHn3O1NbghM9Z1PtwfJK9gcdmMX1ClpJBNEJsAgWD4FtYsv1UgjfGaKTL+6oq5yNBuhS7CIiNu/Q2KiaReNzbdXYTkfE++dE29RCojlhiLX9lhMGZADXPSZXjKX9um8kSnSTabOS/NdGaOxUIoxLQccODgDWwPYQIQ964YryeTkRT5xy4w6lxMlTYxNjlCO0XiKbwVBqo8OBRkJMnIjGJwGDPfY3Btr0xsqh/Y1E5Tbi9F4ucBtdRvd+XMIVdkYamwDL53Spv6Xe7kMzAYybYU0NXk7Bo02CtZDENKERNNjJIcB7Ox34BiTbXK7exWQ9Rlu5lDr+2GMHXaIoYM4OTuR0gjQEauKl/1pCMcz0dnXhCP/2GYNdZizyO0QMHfKChrISDJqs7U0nvYhFo0eUsdY3gohIuoejn9qOod66f4CyIjIya1Z8P3OFZku02CN2vjYOlwoPFU4mhNzuGGTRHDx/eDipd19xL2HrXDHHB44l0cmlBMpbZut8TBJe9A8C5JO6MWHb6HIbhjv0tnr3o18jVvhw9eN11hr8a3VjwLv4LvuHXNDtceTI2jA4YsLwZ0K7akgYprCfZeMDN8+LTJj7rHVN6WfbkMjLu5dXWvExYlhrJgYIFLZxG/KAlzQIURQ7Uh199ICqAq4fAt43csIp3s6HVV5wX/LmaD6OHzQk83qQuW9D0LEz3R+AYp/IfNM//hOdARREOjPFFKIwgpTRBEUVSTFFEVxRVNCMSip2KhLsdeWoFEYEl19+BZUauirZi7sKF/IC1p/C/fl5a1/91IKFa5sLXfTesjXJteQRgoZGLIwdMOQgyEPQwGGIgw9MPTCGiqQlaKl/sREuJKBHnlmyNyIspK5lQOI6Nk+OmPHIEQmEtO45gW9uWdPlcZxGipZx4tzruTdcAyOi9LdUXgaHXQP+yZ7esMI5JXRNaOowCkUdREom5H5XBzBA/T9hmu6UEZ01817ZQyyIhPTQ6Ch/0SOcdRXVhwTbDGIs9TUSRSWvXtSqwjI1kzru/bpibftWcKOmXqfgvtuQnX34mPHFECQkPHK6FwsExeHTOhgf7etuMhKO1E4mfZLTboF7Z4zIhycWFKtu7Av7byZcYp0/ih6r4JJabPcIR0nfbJsWZmmvJK5aRDJ1CiKufnocmo3KKa7AfnDWSVzkqTjvGAUk2M4uEvBOSZBUoFQUqQ5horcD8gQQSYNlBBi1KbTNDXN0TETBiFElUogpCsLz3mzfkyaPgaXKLKzV12WlASZ3TayPdSyotaUbeoEFYcwOk4nefcDpiSCGQtdS5T0fC+fu+eBL+2Yv9hUNcel8W23oFIHkPUThximZjsGWYl1GdCdfqRobffbZnrK9euy5r7VDTCVpfVuguncphwvr3PZTrAloFkzkE2r/AiWpjsFvTPjcG83z05d05uk1gXRiatRzJnwON7zeaGYFDB3h9/CbryiC8aWSpWNJtKaWkz1AyLWnpirsoq5Iyb7sc4dqHlfh+bWL1COsfFWWd+6AQV08DIuYvNgcqKNYyE4Uqll3GbrQPkWkM1eNm4Jm9ABY9Vls6i2zEjYKl1uozPR9h7UjhkJO6X3u7APVAPJoqmW5iTsti738KinvVLtk2q/dHlAHSMdpOgQRYcpyyN0wKzVUdbqGGt1nLWrEybR9EmaPkXTp2n6DE2fpelzNH2e5vVCeQUz0Vtd3DssWyaXqC0ve3yA1M9XyitEr6sN+VpDdX3ErEBuZJabmV3f+qBetyGs3KGWu9Tr3oiqKO6nyoNUaaXKQ6nycKo8kiqPdnM8ljkezxxPZI4nM8dTmePpzB2fKb+v4+ftzbKOvU/y+nsxm46ll5bqpWXbsWXRvfnmTP2iDwRqt7nQz8q+LwL6Qa8FjK79Ojgx/3UBg3bD51ME+Phxu++p/7wbgya0OS3ZsXh4FI7H4jKRxHqcOuL2JD4uRBFyS2K7pyxiGGQSFNwiMQgRFNwEI583BDefY1uF1rx+48cIOUEFEikLDlUJBUnVxbrx3mIofLsCANXZ1yM9Km/bb+OHVS2O2ce+LVRnqdacDdut/zlEf95gbZh3HgUZO25E3ljrjtXthUTNdU7nvAiFeD7ZGeSHZ7/m2oZgzUIZM+KBGS3vBBGv1THPXzS6BiL8+GxzwonMgGuYBWGoeK5UKlCcixADZGu5JaN4AElloutn9mp/jhd43partDZqwpQumW9dfC6k37hI2XhHmU+b1VLbdhN0VqdnG3sin0Micev/mtir3rBaqv34g5oWsYOmXnqNPGi2q9wpEvGRlrh2CuYtW6tuPl/LijqU3yLSXdc3TmJ3rKlmHnZDnpCbeOZi6d5Qq9oPbhWDCeMwXXByfm6oJjDDocz3RhjhsiWwHjl/yiySAV4QHR2w7jUxF9bMIzbhco/7Tjmf93orLuJ8fGeO0/EDnMQrOycJhdeXvjb/k3OXH4dP9gwW3/4LplKGnPEA8VbGbsBwvqAm6tG5vj9egBGPVXI4M/e/X9WRhJ4dDhM3s2oB+mXLIYK+sVpLZh6nn1E4Eq7X/PaViGYWGxOOOovWWisHZ0YrcsR6ZgQmW/fbGnYe8NxW2PQeGSTvQrjKTMmBwZNpkmQuBSYCd/XQhGfNPLZ3iLw3zeUyNl4Ijuosr0CimODIHh/QGhGBfrtmOXxsywXGlxK3jL6p4r2ydxm+JzUlVNdh2zRxTdN4PTiASqCsKLgxvKHS+7jF9/LWtBB50CwSo1z3jiMiAvthTUNvnXVliZ7bbVda3wvy6BCDV3ec0TqgaaSehbi7dthoxN4lOak2IyuDLYOl0cNeK0sjXsvlt9Vgt+VxPfcbpn44FIBWGAx+SpEgVMznIAjHA0+oCDceG4UBV59EMzDgKbQLnIO++fq5LZ70yBUUtQON9mIovlqJQEXvFk91oLvPHF7v3GP3vq+ZztbFZfHyGyrLq7r6gIKYMBQdjKKUNnoBgc+3ReoTC61TMfGHKg7oOMBAoHbYDCkG7IACUFMB/0RtfFffTjbI2Z6R397vUiLQtSkMgpaYqS/Z8M9zqRQQE6dHw2O5XnLoUAiqh6BuF6nb0whLXfyVjogHits8nvLmMkFprAFPCeHKgwY8ZItWE5nWKZhhWQw8JFfM7G3N7+l9CFoDJMtYV09OcRVQOGvJf1qS4JS2ez3lLWX8UnMkO6+yW5OvItBcoZH1UZDK6VJym6odSJIiMa7qWqA4lI4oTYbhGB4yGghaH92B4z/EDPD5iGUJBLcPBGkVaqpZZeXYv0gAlK9IjoZHVZT1ygN/t6cl/O+qzcrMrM3M/4tJkd90VVYan8cmWw2lNeb0tC6mxlRzcsxz67olFBVgukqlw5gqWtGcF5BIA47GFpnG4+wmlQ23uuQqxjYSwzqjzNP93Zp8le1NlRqvbYKMXKZqU/65ClgcE27ljNkUK+8HOFJPa56T0lIG63AMC9n674drk00lxQa21GZk1H2hukGUw4wRpRFGlYry9ZQq7mmeKcNalRyTpLPrBYBOiJWvl/7Jobhne2KdsNbsUn/PQJp3FVCh+E1tGfKOlPdv9ft79PAykY2VgbySNzX7waiYVDbIdXarLvf08kLueDXJTWvdD2jqvsupje3jOEdK/luMstECgMz4X53804osPUdzjJnuRBJznZ5Bt2HRcOv/mIIxGF606X0OTz1Ksi36xHCwuFu1v6q9FC6JATgwMhhFOAkpp0nqnNUWrihw7SYTlrsFmWbrR+9o7UuRsrTPXlbBdU86xTKOFijt7vVXBUoFpSai2FfvphpPz7U9JxTfVMPeAplO6Sj3QEWhIqU2zbWXpPblx2vC41POU/SF6P7jvOR26WyqEizgEzu/0X17VeqBwnTT397GrNzspkzf3yZLPNeRZ9cTqSazrU+9JTOjwdS3wGJKxQ17FmLKAfbVGL7LAdhRPj3AvgvDVlf37SbH+7p249geX71MUpa/niQvFJj3rdO6SC/rd0ey7Mgqe0U1VMw4WtDNW/NiM5RbJp6z2XRyXeo5in6QqhZp06x3yeEV3Fy7bb9tCFitbzOiJb/LTsp+FwpXfWNMy6F8KAB1Gov9NeZ85SBoLDxBbiQDUJrAuVWalt/6WYs9R9HvDJzlKdBYTqrV8j5bc+Vd5e0pDwa0PQgre/vuebm/CBURMceTmNwUFV+KonkoygN1CvSSJh0VUmU0v80OgdqvGeWwl6AdFpx50lTYkWXOHfZC84Lcp5BGKPywkx8/UoKj+PVaCrg+IvcGxYCBnZi3Ck39a1ZJiPjnDHMkCYZQNE9gBNk89ANMuKUiNMxNyBrcAkeieM9xFda3ZDQEeYFkabnSeC1+8v+zitCqrjJJh3qHY6wjzEm1MH+bxB6OtxYWXRMgz0TZQJI0V2V8pvbHS0RGxQUBXoBzw9w4Yexn8RH1uQTXBkF0rkhmaMT173Q6KG9yRMOukvN3hnrPn6IkO7fONRimHpsc10waNjYvr29oMq0af2Ri3jB96yQ5PXlenxY1TZSBQhQsJZAraq1lgxAQYyeEyBNRvOgJQiVm/m3OSbOY/kmW2J8Mi68K0Kdi3ZD3z4gPB8nIuKtM0oZeIDsOP9o42BiN8MKUF2G8IKzXYfNI3ua9ae+nJX9QV1Wj6rVP183pb2z5x7OdnnF9ExkIAEUZgggjhJgnvO+JAFsUMcQ8ceBJACQRSyj58t/NQba7VHf4CPwF8/ja8Ex+Qqegc+oyvGTwxxlUPiV1B/LxL5a79gD+n8f18ScG1Yt/iynnr9+Tzfr1aW847AEzDgHqZ4qEoEOSiBq04HYD7pU7HgrABWdOm6GS1e12MkMTMc+DQWBqAWbOQDRLC4V8SpiRkmUmSbBBBJ7/F9+ztuIQDBaXwSwPQcr6RgB04IrqmJW4dM5o4de09OF8rpL3KjNWstzTwyxVtchC2olJiKZsiiQpqIV0Pl1MVgeg1MxGt3D4ThsWFlY3xzVL4vv4LW6WPZ8s5kZz2oyXrLHBnqKQShCk17QLgpjXJJlAEqcJwQNKaVkfzAWLfX3OMBP4jMKVPGs1QoYeJWFUSQpTMJOa37Ds2bxoDcLQQhuiRUgt5H1I0pLu676jWp+6IX6pLdlRrZ+0o5jPZ4rdIzmbmdQ5XD5ikSElq72sVeDgyN0NFlLwZUgoLdUpFABBr7sVtMYhd47l3MsWnrFZZrFYyOcKIZjREfEw2G7jTEB4rSEQBGgjAB8A88wMQsyKhZgVPnu2ooWHXvpQMZ8LSDNasgYLoeeFdxWpWKpfQqnhzjY0apPj/X1diZ6c/WXOBGkVIKE1MTm8EglmWouGIC2qlCo7c8BljuXaC+IW5g7LEpZpkF07Obze4bzr3mQkBA/3/uJBQ07NBJpvoba8h82wWKgSC2tf6IMjpDw04mC90FJILVqE3+l0/2RLjNk3Ucws5sty7yoYZkL1DZcwiakuRUyygY5dghQkZM3fOwaENMSp1jlxmVMKjbVd9k1TkBsr2J3/WUFoYS0utqbvEC42rmpMT9a7JrIMBAsbttx5MAjb8+dhQLjSVW7ic+Vqn+2+jO2WKwr8pizApzbzcDoBZ8wZDfjQCcd8dJiI4dS8Q3RoE14iVEIKeMujnkxigBihSJQHIOWsrO2xDBTeQiKmOXg6G5ajmxct9wApbREJt12IAFXEDu3SvdRms6YlCUVKXJ7k7wJKaHVixZLgt2XONbUwokWyUuV0pl3I6kECSZK6dHtR0n29NY+WZeaL2VD3aK5lmb2QEo8RDrfkkBruL2DUMzb/2e2InlwPPKaCNpQ+0ZDmzllvloy8Q4FZ/2gO2D2dY8O9QgIE7Zm1EAST0NrS3NmzWXLw7lTmZjskTyaQZ+UnOnvQdNLcvYCp0ZGSYFHwseRVpKSY10Kr4fTK3cJpfXZ6aKC3eHe8U+ND6YT61kPQli21pKw2B/pLSWvcbFl4p/c1zPtn+2c+vuyzAv5IRJdHFyJ72B7bKuGTZ/opidP5f7cmK94hvi+biLBrhguBNhk+ax5pRR9tWrHzytLkh5gItAVAB8xuYYairxBNBIBOXt7SOpg/4Jr5m40nfgnw/cF//yu7PNu3/01L0vlNtwKCAQYAEPCrSK/4T4SK+JG5f6nleBXQF61FHHb6kHB8QCh+ak4f1hUfseHX6pz7JuP9vPFn9AENVFCGD6MYQR+GXkoh3HB7MyeZ6KQo4pGHQQoO6qDUf9DCvZ8uDp5h8QObcRdhaNcY7yurP+PVLk6escFzgJfmAUhIgFj7bgIk7TUv++bn6oSU963OsOEdqwtUnV1dold9dYWootBqMqDukMvOuuCGxrjyeUcdwxWGcJ/6HWfFTo3Lxin6r00ZVDFiwMTVp5Qi9lQ6/1/NtO22qlsyrVx7PW6qOAxfdCv+dzrlhJOuShkyYNC4lO1OOiYlQGxmTInTzDjCG665NkdPuuBuNKUogmlx8RSe0t9GTzhFZTlth1Uc0eIcoZ52UfSrNMENPQT6/W3vrIaMvOELX7kOK0TPt2X6FUiOuxUY9Q9h1QHSPfR+mYvlWC+nbBWdl2FDmYfDLHBdj8he7lKLyR31T3k/M//M5DOjz/QtKHRI8gRg/XGBnB+FAJrP3fTk1eKy9eTiPh1VitUfsQEnodliKwXS62O2FpI5gSPbT/J+gS3HPM/oAVnkqFLO3o9Q+zHkc88cSn5VRzWapwAAAA==) format("woff2")}\n';

  // src/ui/neon-styles.ts
  var NEON_CSS = `
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

  // src/ui/styles.ts
  var STYLE_ID = "slab-styles";
  var CSS = `
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
  /* A narrow window scales the whole car from its top-left corner (see position()). */
  transform-origin: 0 0;
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
/*
 * Spotify's own button rules, and some themes', put their font on every button
 * and win over a zero-specificity reset, so a door name wraps and the panel
 * outgrows its height. The lettering is part of the car: its buttons keep the
 * panel's face and spacing (inherited, so a reader's own text spacing still applies).
 */
.slab-panel button {
  font-family: inherit !important;
  letter-spacing: inherit !important;
}
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
/* DJ mode: a latching press in the header, lit while SLAB works the record itself. */
.slab-dj { --roll: 28px; flex: none; height: 28px; min-width: 44px; padding: 0 10px; flex-direction: row; font-weight: 700; font-size: 13px; letter-spacing: 0.06em; }
.slab-dj[aria-checked="true"] {
  transform: translateY(2px);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.7), 0 0 0 #0B0203;
}
.slab-dj[aria-checked="true"]::after { opacity: 1; transition-duration: 0ms; }
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
.slab-panel[data-short="true"] .slab-mood { min-height: 32px; grid-template-rows: minmax(24px, auto); }
.slab-panel[data-short="true"] .slab-mood-cents {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.slab-panel[data-short="true"] .slab-mood-curve { height: 24px; }
.slab-panel[data-short="true"] .slab-lock svg { height: 24px; }
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
.slab-auto-press[aria-checked="true"],
.slab-bank[aria-checked="true"] {
  transform: translateY(2px);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.7), 0 0 0 #0B0203;
}
.slab-press:active:not([aria-disabled="true"])::after,
.slab-press[data-hit="true"]:not([aria-disabled="true"])::after,
.slab-press[data-latched="true"]::after,
.slab-auto-press[aria-checked="true"]::after,
.slab-bank[aria-checked="true"]::after { opacity: 1; transition-duration: 0ms; }
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
/* Thirty spokes on a 12\xB0 pitch strobe at speed; they fade and the knock-off carries the turn. */
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
.slab-doors {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(4, auto);
  gap: 4px;
  margin-top: 8px;
}
/* The seven moods are one radio group; Keep is a switch, so it takes the eighth door's place beside it. */
.slab-moods {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  grid-template-rows: subgrid;
}
.slab-keep { grid-column: 2; grid-row: 4; }
@supports not (grid-template-rows: subgrid) {
  .slab-doors { display: block; position: relative; }
  .slab-moods { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
  .slab-keep { position: absolute; right: 0; bottom: 0; width: calc(50% - 2px); }
}
.slab-mood {
  --stripe: var(--gold);
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 58px;
  grid-template-rows: minmax(17px, auto) minmax(13px, auto);
  column-gap: 6px;
  align-items: center;
  min-height: 36px;
  padding: 3px 8px 3px 14px;
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
.slab-mood-cents { grid-column: 1; grid-row: 2; font-size: 13px; line-height: 13px; color: var(--wall-soft); }
/* An empty Mine says what a tap does, across the whole door. */
.slab-mine[data-empty="true"] .slab-mood-cents { grid-column: 1 / 3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Keep: a name that can be long, cut short on one line, and the lock knob where a curve would be. */
.slab-keep { grid-template-columns: minmax(0, 1fr) 22px; }
.slab-keep .slab-mood-name, .slab-keep .slab-mood-cents { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slab-lock { grid-column: 2; grid-row: 1 / 3; display: flex; align-items: center; justify-content: center; }
.slab-lock svg { display: block; height: 28px; width: auto; overflow: visible; }
.slab-lock-pin { transition: transform 120ms cubic-bezier(.3, 1.6, .5, 1); }
.slab-keep[aria-pressed="true"] .slab-lock-pin { transform: translateY(9px); }
.slab-keep[aria-pressed="true"] {
  --stripe: var(--wall);
  background: linear-gradient(180deg, #1E070A, #2A0C10);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.85), inset 0 0 0 1px rgba(0, 0, 0, 0.8), 0 1px 0 rgba(255, 214, 214, 0.25);
  transform: none;
}
.slab-keep[aria-disabled="true"] { filter: saturate(0.45) brightness(0.7); }
.slab-keep[aria-disabled="true"]:hover { transform: none; background: rgba(255, 210, 210, 0.04); }
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
.slab-pad:is([data-pad="stop"], [data-pad="spin"], [data-pad="crush"]) { grid-column: 6; }
/* One bank's pads and its control show at a time; Chop until another is picked. */
.slab-panel:not([data-bank="screw"]):not([data-bank="tape"]) :is(.slab-pads[data-bank="screw"], .slab-pads[data-bank="tape"], .slab-auto[data-for="screw"], .slab-auto[data-for="tape"]),
.slab-panel[data-bank="screw"] :is(.slab-pads[data-bank="chop"], .slab-pads[data-bank="tape"], .slab-auto[data-for="chop"], .slab-auto[data-for="tape"]),
.slab-panel[data-bank="tape"] :is(.slab-pads[data-bank="chop"], .slab-pads[data-bank="screw"], .slab-auto[data-for="chop"], .slab-auto[data-for="screw"]) { display: none; }
/* In the Chop bank, DJ mode's row stands in for Auto chop's while it plays. */
.slab-panel[data-dj="on"] .slab-auto[data-for="chop"]:not(.slab-dj-row),
.slab-panel:not([data-dj="on"]) .slab-dj-row { display: none; }
/* The tape is set and left, not played from the keys: no number in the corner. */
.slab-key:empty { display: none; }
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

/* Under the pads: which bank shows, then that bank's own control. */
.slab-bankrow {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding-top: 4px;
}
.slab-banks { display: flex; gap: 3px; flex: none; }
.slab-bank { --roll: 30px; height: 30px; min-width: 46px; padding: 0 8px; flex-direction: row; font-weight: 600; font-size: 13px; }
.slab-auto {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.slab-auto-press { --roll: 30px; height: 30px; padding: 0 8px; flex: 1; min-width: 0; flex-direction: row; font-weight: 600; font-size: 13px; }
/* Its name, then how often, and how soon while it runs. */
.slab-auto-words { display: flex; flex-direction: column; align-items: center; min-width: 0; line-height: 14px; }
.slab-auto-name { white-space: nowrap; }
.slab-auto-press .slab-every { flex: none; display: block; font-size: 12px; font-weight: 500; line-height: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.slab-clean { --roll: 30px; height: 30px; padding: 0 12px; flex: none; flex-direction: row; font-weight: 600; font-size: 13px; }
.slab-tape-note { text-align: left; }
.slab-stepper { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; }
.slab-every { flex: 1; min-width: 0; text-align: center; font-size: 13px; line-height: 15px; color: var(--wall-soft); }
.slab-panel[data-auto="on"] .slab-every { color: var(--wall); }
.slab-step { --roll: 30px; flex: none; width: 30px; height: 30px; font-weight: 600; font-size: 16px; line-height: 1; }

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

/*
 * The trunk's neon. While the mood can be heard (data-gas="on"), every word on
 * the paint is lit gas: a white-hot core with the argon breathing round it, the
 * way lettering looks on a sign at night. Secondary words burn in the glass
 * colour at a lower current. With nothing heard it is all whitewall again, and
 * the sill stays stamped steel: it is a scuff plate, not a sign.
 */
.slab-panel {
  --neon-text: 0 0 1px rgba(243, 245, 255, 0.9), 0 0 4px color-mix(in srgb, var(--gas-glass) 75%, transparent), 0 0 11px color-mix(in srgb, var(--gas) 55%, transparent);
  --neon-text-soft: 0 0 1px color-mix(in srgb, var(--gas-glass) 80%, transparent), 0 0 6px color-mix(in srgb, var(--gas) 45%, transparent);
  /* The glass colour run a little hotter, so a secondary word still clears 4.5:1 on the paint. */
  --neon-soft: color-mix(in srgb, var(--gas-glass) 62%, #FFFFFF);
}
.slab-panel[data-gas="on"] :is(.slab-tag, .slab-pitch-label, .slab-scale-end, .slab-mood-name, .slab-bpm b, .slab-bar, .slab-every, .slab-flash, .slab-pad b, .slab-auto-press, .slab-bank, .slab-clean, .slab-dj, .slab-step, .slab-nudge, .slab-normal):not(.slab-press[aria-disabled="true"], .slab-press[aria-disabled="true"] *, .slab-keep[aria-disabled="true"] *) {
  color: var(--gas-core);
  text-shadow: var(--neon-text);
}
.slab-panel[data-gas="on"] :is(.slab-sub, .slab-semi, .slab-mood-cents, .slab-bpm small, .slab-pad small, .slab-key, .slab-nogrid, .slab-play):not(.slab-press[aria-disabled="true"] *) {
  color: var(--neon-soft);
  text-shadow: var(--neon-text-soft);
}
/* A lit press is already full of gas; its small words burn white so they still read on it. */
.slab-panel[data-gas="on"] .slab-pad:is([data-hit="true"], [data-latched="true"]) :is(small, .slab-key):not(.slab-press[aria-disabled="true"] *) {
  color: var(--gas-core);
}
.slab-panel[data-gas="on"] .slab-close { color: var(--gas-core); filter: drop-shadow(0 0 3px color-mix(in srgb, var(--gas) 70%, transparent)); }
.slab-panel[data-gas="on"] .slab-lamps i[data-on="true"] { background: var(--gas-core); box-shadow: 0 0 3px var(--gas-glass), 0 0 9px color-mix(in srgb, var(--gas) 60%, transparent); }
/* When the gas comes on, the glass strikes: a flutter, then steady, like a sign at dusk. */
@keyframes slab-neon-strike {
  0% { text-shadow: none; }
  14% { text-shadow: var(--neon-text); }
  26% { text-shadow: none; }
  44%, 100% { text-shadow: var(--neon-text); }
}
.slab-panel[data-gas="on"] :is(.slab-tag, .slab-pitch-label, .slab-mood-name, .slab-bpm b, .slab-pad b, .slab-auto-press, .slab-bank, .slab-clean) {
  animation: slab-neon-strike 420ms linear 1;
}

/*
 * The big wheel on the board behind the slider. Board-dark chrome so the glass
 * in front stays the brightest thing; only its ring is lit, and only with the
 * gas. It turns from the beat clock (see turnBigWheel in deck.ts), never from
 * a CSS timer, so it can't drift off the music.
 */
.slab-bay > .slab-bigwheel {
  position: absolute;
  width: ${BIG_WHEEL_BOX}px;
  height: ${BIG_WHEEL_BOX}px;
  pointer-events: none;
}
.slab-bigwheel > svg, .slab-bigwheel-turnwrap, .slab-bigwheel > .slab-tube { position: absolute; left: 0; top: 0; }
.slab-bigwheel-turnwrap { width: 100%; height: 100%; transform-origin: 50% 50%; will-change: transform; }
.slab-bigwheel-turnwrap > svg { display: block; }
.slab-panel[data-primer="true"] .slab-bigwheel { opacity: 0.6; }

@media (prefers-reduced-motion: reduce) {
  .slab-panel { animation: none; }
  .slab-panel[data-gas="on"] * { animation: none !important; }
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
  .slab-panel {
    --gas-spill: rgba(62, 88, 255, 0.24);
    --neon-soft: #C4CFFF;
    --neon-text: 0 0 1px rgba(243, 245, 255, 0.9), 0 0 4px rgba(157, 176, 255, 0.75), 0 0 11px rgba(77, 107, 255, 0.55);
    --neon-text-soft: 0 0 1px rgba(157, 176, 255, 0.8), 0 0 6px rgba(77, 107, 255, 0.45);
  }
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
  .slab-panel * { text-shadow: none !important; }
  .slab-panel .slab-close { filter: none; }
  .slab-bigwheel { display: none; }
}
`;

  // src/ui/tube.ts
  var Tube = class {
    constructor(className, width, height) {
      this.current = "";
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
      const find = (name) => this.node.querySelector(`[data-l="${name}"]`);
      const names = ["shadow", "shadowWide", "dark", "boots", "bootsHi", "frost", "frostHi", "bloom", "halo", "glass", "core", "clipShadow", "clip", "clipHi"];
      this.layers = Object.fromEntries(names.map((name) => [name, find(name)]));
      this.gas = this.node.querySelector(".slab-tube-gas");
    }
    set(layout) {
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
  };

  // src/ui/badge.ts
  var SCRIPT = [
    // S
    "M13.4 4.6C12.4 2.3 7.6 1.5 5.2 3.2C2.6 5 3.5 7.7 7.3 9.3C11.1 10.9 12.6 12.9 11.3 15.5C10 18.1 5.6 18.7 2.4 16.6",
    // l, a, b in one run of the pen
    "M13.8 15.6C16.6 13.6 19.4 8.6 19.9 4.8C20.2 2.4 18.4 1.9 17.8 4.1C17 7.6 16.4 12.6 17 16C17.4 18.3 19.8 18.1 22 16.2C23.4 14.9 24.6 11.6 27.4 10.7C25.2 10.1 22.6 11.9 23 14.9C23.4 18.1 27.4 17.6 28.8 14.2L29.6 10.6L28.9 15.6C28.6 17.8 30.6 18.1 32.8 16.4C35 14.3 37 8.6 37.4 4.8C37.7 2.4 35.9 1.9 35.3 4.1C34.5 7.6 33.9 12.6 34.4 16C34.8 18.5 38.6 18.6 40.2 15.7C41.3 13.6 40.4 10.8 38.1 10.8C36.7 10.8 35.7 11.7 35.3 12.6",
    // the swash, off the b and back under "lab"
    "M40.2 15.7C44.6 16.6 47 19.6 42.6 21.2C35.2 23.8 23.2 22.8 15.6 20.6"
  ].join("");
  var NAMEPLATE_WIDTH = 58;
  var NAMEPLATE_HEIGHT = 28;
  function nameplateTubePath() {
    const scale = NAMEPLATE_WIDTH / 50;
    const top = (NAMEPLATE_HEIGHT - 24 * scale) / 2;
    const slant = Math.tan(12 * Math.PI / 180);
    const round = (value) => String(Math.round(value * 100) / 100);
    return SCRIPT.replace(/(-?\d*\.?\d+)[ ,](-?\d*\.?\d+)/g, (_match, xs, ys) => {
      const x = Number(xs), y = Number(ys);
      return `${round((x + 4.4 - slant * y) * scale)} ${round(y * scale + top)}`;
    });
  }

  // src/ui/deck.ts
  var PITCH_LIMIT = 1200;
  var EVERY_MIN = 1;
  var EVERY_MAX = 16;
  var DEVICE_NAME_MAX = 56;
  var PANEL_MAX_PX = 680;
  var PANEL_WIDTH_PX = 400;
  var MIN_ROOM_PX = 160;
  var SHORT_SAVING_PX = 56;
  var DEAD_LINE_PX = 18;
  var GRID_RETRY_MS = [5e3, 3e4, 12e4];
  var COMPACT_SIGN_HEIGHT = 50;
  var SPIN_MS = 1600;
  var ROLL_MS = 640;
  var TAGLINE = "Slow, loud and bangin\u2019";
  var DJ_MOOD = "screwed";
  var DJ_PITCH = -700;
  var ANSWER_HOLD_MS = 1500;
  var PLAYED_AS = {
    houston: "Houston",
    trap: "trap",
    rap: "rap",
    slowjam: "a slow jam",
    band: "a band record",
    dance: "a dance record",
    pop: "pop"
  };
  var CHIP_TITLE = "SLAB, Third Coast playback moods";
  var PX_PER_CENT = 12 / 100;
  var RAIL_WIDTH = WHEEL_SIZE + PX_PER_CENT * PITCH_LIMIT * 2;
  var RULER_WIDTH = 360;
  var THUMB_SIZE = WHEEL_SIZE;
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
  function deviceSentence(raw, max = DEVICE_NAME_MAX) {
    const name = raw.trim().replace(/[.\s]+$/, "") || "another device";
    if (name.length <= max) return `${name}.`;
    const cut2 = name.slice(0, max);
    const word = cut2.lastIndexOf(" ");
    return `${(word > 12 ? cut2.slice(0, word) : cut2).trimEnd()}\u2026`;
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
  var motionQuery = null;
  function reducedMotion() {
    try {
      motionQuery ?? (motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)"));
      return motionQuery.matches;
    } catch {
      return false;
    }
  }
  var TRANSPORT = [
    '[data-testid^="control-button-"]',
    '[data-testid="playback-progressbar"]',
    '[data-testid="volume-bar"]',
    '[data-testid="volume-bar-toggle-mute-button"]',
    ".player-controls"
  ].join(", ");
  var KEYLESS_INPUTS = /* @__PURE__ */ new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"]);
  function isTypingTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target instanceof HTMLInputElement) return !KEYLESS_INPUTS.has(target.type);
    return Boolean(target.closest('textarea, select, [role="textbox"], [role="searchbox"], [role="combobox"]'));
  }
  function isPlaying() {
    try {
      return Spicetify.Player?.isPlaying?.() === true;
    } catch {
      return false;
    }
  }
  function steer(animation, phase, periodMs, settling = false) {
    const rate = 1e3 / periodMs;
    const want = (phase % 1 + 1) % 1;
    const timeline = Number(document.timeline?.currentTime ?? performance.now());
    const since = Math.max(0, performance.now() - timeline);
    const time = Number(animation.currentTime ?? 0) + (animation.playState === "running" ? since * animation.playbackRate : 0);
    let error = want - (time % 1e3 + 1e3) % 1e3 / 1e3;
    error -= Math.round(error);
    const snapAt = settling ? 0.012 : 0.12;
    if (animation.playState !== "running" || Math.abs(error) > snapAt) {
      const started = animation.playState !== "running";
      animation.currentTime = want * 1e3 - (started ? 0 : since * rate);
      animation.playbackRate = rate;
      animation.play();
      return started;
    }
    const ride = rate * (1 + Math.max(-0.06, Math.min(0.06, error * 1.6)));
    if (typeof animation.updatePlaybackRate === "function") animation.updatePlaybackRate(ride);
    else animation.playbackRate = ride;
    return false;
  }
  function progressMs() {
    try {
      return needlePosition();
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
  function pinstripe(id) {
    const fade = `slab-stripe-${id}`;
    return `<svg class="slab-stripe" viewBox="0 0 188 ${DOOR_HEIGHT}" width="188" height="${DOOR_HEIGHT}" aria-hidden="true" focusable="false">
  <defs><linearGradient id="${fade}" gradientUnits="userSpaceOnUse" x1="120" y1="0" x2="78" y2="0">
    <stop offset="0" stop-color="currentColor" stop-opacity="0"/><stop offset="1" stop-color="currentColor"/>
  </linearGradient></defs>
  <path d="M120 4.5H11Q4.5 4.5 4.5 11V24" fill="none" stroke="url(#${fade})" stroke-width="1"/>
  <path d="M108 6.5H11.5Q6.5 6.5 6.5 11.5V21" fill="none" stroke="url(#${fade})" stroke-width=".5"/>
  <path d="M4.5 23.5L6.1 27.2L4.5 32L2.9 27.2Z" fill="currentColor"/>
</svg>`;
  }
  var LOCK_KNOB = `<svg viewBox="0 0 22 30" width="22" height="30" focusable="false">
  <defs>
    <linearGradient id="slab-lock-chrome" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#5E5956"/><stop offset=".34" stop-color="#F6F2EE"/>
      <stop offset=".62" stop-color="#B7B1AC"/><stop offset="1" stop-color="#4B4643"/>
    </linearGradient>
    <clipPath id="slab-lock-hole"><rect x="0" y="0" width="22" height="25"/></clipPath>
  </defs>
  <ellipse cx="11" cy="25" rx="7.2" ry="2.4" fill="#120104"/>
  <g clip-path="url(#slab-lock-hole)"><g class="slab-lock-pin">
    <rect x="7.2" y="5" width="7.6" height="24" rx="3.8" fill="url(#slab-lock-chrome)" stroke="rgba(0,0,0,.5)" stroke-width=".6"/>
    <path d="M9 7.6Q11 6.4 13 7.6" fill="none" stroke="#FFFFFF" stroke-opacity=".7" stroke-width=".8" stroke-linecap="round"/>
  </g></g>
  <path d="M3.4 25a7.6 2.6 0 0 0 15.2 0" fill="none" stroke="url(#slab-lock-chrome)" stroke-width="1.7"/>
</svg>`;
  var DOOR_HEIGHT = 36;
  var CURVE_WIDTH = 58;
  var CURVE_HEIGHT = 28;
  var MINE_HOLD_MS = 650;
  function doorCurve(gains) {
    return `<svg class="slab-mood-curve" viewBox="0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}" width="${CURVE_WIDTH}" height="${CURVE_HEIGHT}" aria-hidden="true" focusable="false">
          <path class="slab-mood-zero" d="M0 ${CURVE_HEIGHT / 2}H${CURVE_WIDTH}"/>
          <path class="slab-mood-line" d="${curvePath(gains, CURVE_WIDTH, CURVE_HEIGHT)}"/>
        </svg>`;
  }
  var MOODS_BY_PITCH = [...MOODS].sort(
    (a, b) => a.dsp.pitch - b.dsp.pitch || Number(a.id === "flat") - Number(b.id === "flat")
  );
  var NEEDS_HELPER = "That pad needs SLAB DSP running on this Mac.";
  var NEEDS_NEWER = "That pad needs a newer SLAB DSP: run bun run dsp:install.";
  function processing() {
    const status2 = dspStatus();
    return status2.linked && status2.tapping === true && status2.audio === true;
  }
  function tapeMissing() {
    return processing() ? NEEDS_NEWER : NEEDS_HELPER;
  }
  var NO_GRID = "No beat grid here, so only Stop works and auto chop waits.";
  var LOOP_TIMES = 4;
  var LOOP_SUB = `${LOOP_TIMES} times`;
  var Deck = class {
    constructor(state) {
      this.moodButtons = /* @__PURE__ */ new Map();
      /** The device Spotify is playing on, when it isn't this computer. */
      this.deadRemote = null;
      this.moodClips = /* @__PURE__ */ new Map();
      this.moodFeet = /* @__PURE__ */ new Map();
      this.lamps = [];
      this.rulerKey = "";
      this.rulerBar = -2;
      this.pads = [];
      this.padTimers = /* @__PURE__ */ new Map();
      this.loopSub = null;
      this.padDefs = /* @__PURE__ */ new Map();
      /** Pads by the number key that plays them, 1 through 0. */
      this.padByKey = /* @__PURE__ */ new Map();
      /** Held pads by the key or pointer holding them down, so the right up lets the right one go. */
      this.heldBy = /* @__PURE__ */ new Map();
      this.bankButtons = /* @__PURE__ */ new Map();
      this.roomSub = null;
      /** When a hand last played a pad: what happens just after is the hand's, not the DJ's. */
      this.lastManualAt = 0;
      /** When the readout last answered something you did. */
      this.answeredAt = 0;
      this.cleanButton = null;
      this.mineButton = null;
      /** The artist the Keep door last showed, so it is drawn again only when that changes. */
      this.keepShown = null;
      /** Stops any held-button repeat; run on destroy. */
      this.releases = [];
      this.sillEl = null;
      this.lastHelperState = null;
      this.disposed = false;
      this.disposeDsp = null;
      this.refreshTimer = null;
      this.chipTimer = null;
      this.activityTimer = null;
      this.rollTimer = null;
      this.lastGridUri = null;
      this.lastGridAttempt = 0;
      /** Failed analysis fetches for the current track; each retry waits longer. */
      this.gridMisses = 0;
      this.announceTimer = null;
      this.settleTimer = null;
      this.resizeFrame = null;
      this.lastPlaying = null;
      this.lampFrame = null;
      /** Re-places the panel when its own height changes (the ModernEQ row, a short window). */
      this.sizeWatch = null;
      this.lastDspSync = 0;
      this.pitchTimer = null;
      this.pendingPitch = null;
      this.renderedCents = null;
      /** Spokes and knock-off spin as one; two animations on one clock. */
      this.spinAnimations = [];
      /** The big wheel's turn and its ring's beat kick, run by the compositor and steered from the beat clock. */
      this.wheelTurn = null;
      this.ringKick = null;
      /** A smooth playhead for the wheel: Spotify's position reaches the page in steps and with jitter. */
      this.wheelClock = null;
      this.lastWheelSteer = 0;
      /** When the wheel last started turning; for a moment after, it may still set itself straight. */
      this.wheelStartedAt = 0;
      this.strikeAnimation = null;
      this.spinning = false;
      this.modernEq = false;
      this.lastEqCheck = 0;
      this.lastRemote = null;
      this.onDocumentClick = (event) => this.handleOutside(event);
      /** Where the last press began: a click is only "outside" if it started outside. */
      this.pressedInside = false;
      this.onPointerStart = (event) => {
        const target = event.target;
        this.pressedInside = Boolean(target && (this.panel.contains(target) || this.chip.contains(target)));
      };
      this.onKey = (event) => this.handleKey(event);
      /** One reposition per frame, however fast the window is dragged. */
      this.onResize = () => {
        if (this.resizeFrame !== null) return;
        this.resizeFrame = window.requestAnimationFrame(() => {
          this.resizeFrame = null;
          this.position();
        });
      };
      this.onScroll = () => this.renderScrollCue();
      this.onKeyUp = (event) => this.holdUp(`key:${event.code}`);
      this.onBlur = () => this.releaseHolds();
      this.onVisibility = () => {
        if (document.visibilityState === "hidden") this.releaseHolds();
      };
      this.state = state;
      this.chip = this.buildChip();
      this.tagEl = h("span", { class: "slab-tag" }, TAGLINE);
      this.signTube = new Tube("slab-sign-tube", SIGN_WIDTH, SIGN_HEIGHT);
      this.logoTube = new Tube("slab-logo-tube", NAMEPLATE_WIDTH, NAMEPLATE_HEIGHT);
      this.logoTube.set({ lit: nameplateTubePath(), dark: "", boots: "", supports: "" });
      this.ringTube = new Tube("slab-ring-tube", BIG_WHEEL_BOX, BIG_WHEEL_BOX);
      this.ringTube.set({ lit: bigWheelRingPath(), dark: "", boots: "", supports: "" });
      this.bigTurnEl = h("div", { class: "slab-bigwheel-turnwrap", html: BIG_WHEEL.turn });
      this.bigWheelEl = h("div", { class: "slab-bigwheel", "aria-hidden": "true", html: BIG_WHEEL.base }, this.bigTurnEl, this.ringTube.node);
      this.signEl = h("div", { class: "slab-sign", role: "img" }, this.signTube.node);
      this.subEl = h("p", { class: "slab-sub" });
      this.deadWhereEl = h("span", { class: "slab-dead-where" });
      this.deadEl = h(
        "p",
        { class: "slab-dead" },
        this.deadWhereEl,
        " ",
        h("span", { class: "slab-dead-why" }, "SLAB only reaches this computer.")
      );
      this.deadEl.hidden = true;
      this.numberTube = new Tube("slab-number-tube", NUMBER_WIDTH, NUMBER_HEIGHT);
      this.semiEl = h("span", { class: "slab-semi", id: "slab-semi" });
      this.nudgeDown = h("button", {
        class: "slab-press slab-nudge",
        type: "button",
        "aria-label": "\u221210 cents",
        title: "Down 10 cents. Hold to keep going, Shift for a semitone."
      }, h("span", {}, "\u221210"));
      this.nudgeUp = h("button", {
        class: "slab-press slab-nudge",
        type: "button",
        "aria-label": "+10 cents",
        title: "Up 10 cents. Hold to keep going, Shift for a semitone."
      }, h("span", {}, "+10"));
      this.normalButton = h("button", {
        class: "slab-press slab-normal",
        type: "button",
        "aria-label": "Normal pitch"
      }, h("span", {}, "Normal"));
      const nudge = (button, sign) => (event) => {
        if (isOff(button)) return;
        this.setPitch(this.state.pitch + sign * (event.shiftKey ? 100 : 10), false);
      };
      this.press(this.nudgeDown, nudge(this.nudgeDown, -1), true);
      this.press(this.nudgeUp, nudge(this.nudgeUp, 1), true);
      this.press(this.normalButton, () => {
        if (!isOff(this.normalButton)) this.setPitch(0, true);
      });
      this.pitchInput = h("input", {
        class: "slab-range",
        id: "slab-pitch",
        type: "range",
        min: String(-PITCH_LIMIT),
        max: String(PITCH_LIMIT),
        step: "10",
        "aria-describedby": "slab-semi",
        oninput: () => this.onPitchInput(false),
        onchange: () => this.onPitchInput(true),
        onkeydown: (event) => this.onPitchKey(event),
        // A drag right after a mood pick must follow the pointer, not finish the roll.
        onpointerdown: () => this.stopRoll()
      });
      this.hotUp = h("span", { class: "slab-rail-hot slab-rail-hot-up" });
      this.hotDown = h("span", { class: "slab-rail-hot slab-rail-hot-down" });
      this.runUp = h("span", { class: "slab-rail-run slab-rail-hot-up" });
      this.runDown = h("span", { class: "slab-rail-run slab-rail-hot-down" });
      this.spinEl = h("span", { class: "slab-spin", html: WHEEL_SPOKES });
      this.rollEl = h("span", { class: "slab-roll" }, this.spinEl);
      this.knockSpinEl = h("span", { class: "slab-spin slab-knock", html: WHEEL_KNOCKOFF });
      this.knockRollEl = h("span", { class: "slab-roll slab-knock" }, this.knockSpinEl);
      this.wheelEl = h(
        "span",
        { class: "slab-wheel", html: WHEEL_STATIC },
        this.rollEl,
        h("span", { class: "slab-cone", html: WHEEL_CONE }),
        this.knockRollEl
      );
      this.railEl = this.buildRail();
      this.bpmEl = h("b", {}, "\u2013");
      this.barEl = h("span", { class: "slab-bar" }, "Bar \u2013");
      this.lampsEl = h("span", { class: "slab-lamps", role: "img", "aria-label": "No beat" });
      this.setLampCount(4);
      this.playEl = h("span", { class: "slab-play" }, "Paused");
      this.flashEl = h("span", { class: "slab-flash" });
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
      this.everyEl = h("span", { class: "slab-every" });
      this.switchEl = h("button", {
        class: "slab-press slab-auto-press",
        type: "button",
        role: "switch",
        "aria-checked": String(state.auto),
        "aria-label": "Auto chop",
        onclick: () => this.toggleAuto()
      }, h("span", { class: "slab-auto-words" }, h("span", { class: "slab-auto-name" }, "Auto chop"), this.everyEl));
      this.everyDown = h("button", {
        class: "slab-press slab-step",
        type: "button",
        "aria-label": "Fewer bars between chops"
      }, h("span", {}, "\u2212"));
      this.everyUp = h("button", {
        class: "slab-press slab-step",
        type: "button",
        "aria-label": "More bars between chops"
      }, h("span", {}, "+"));
      this.press(this.everyDown, () => {
        if (!isOff(this.everyDown)) this.setEvery(this.state.every - 1);
      }, true);
      this.press(this.everyUp, () => {
        if (!isOff(this.everyUp)) this.setEvery(this.state.every + 1);
      }, true);
      this.depthEl = h("span", { class: "slab-every slab-depth-words" });
      this.depthDown = h("button", {
        class: "slab-press slab-step",
        type: "button",
        "aria-label": "Screw rides less far down"
      }, h("span", {}, "\u2212"));
      this.depthUp = h("button", {
        class: "slab-press slab-step",
        type: "button",
        "aria-label": "Screw rides further down"
      }, h("span", {}, "+"));
      this.press(this.depthDown, () => {
        if (!isOff(this.depthDown)) this.setScrewDepth(this.state.screwDepth - 1);
      }, true);
      this.press(this.depthUp, () => {
        if (!isOff(this.depthUp)) this.setScrewDepth(this.state.screwDepth + 1);
      }, true);
      this.keepNameEl = h("span", { class: "slab-mood-name" });
      this.keepSubEl = h("span", { class: "slab-mood-cents" });
      this.keepButton = h("button", {
        class: "slab-mood slab-keep",
        type: "button",
        "aria-pressed": "false",
        onclick: () => this.toggleKeep()
      }, this.keepNameEl, this.keepSubEl, h("span", { class: "slab-lock", "aria-hidden": "true", html: LOCK_KNOB }));
      this.keepButton.insertAdjacentHTML("afterbegin", pinstripe("keep"));
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
      this.djButton = h("button", {
        class: "slab-press slab-dj",
        type: "button",
        role: "switch",
        "aria-checked": String(state.dj),
        "aria-label": "DJ mode",
        title: "DJ mode: SLAB works the record itself, on full screw. A Chop or Screw pad of yours takes it back for eight bars.",
        onclick: () => this.toggleDj()
      }, h("span", {}, "DJ"));
      this.djStyleNameEl = h("span", { class: "slab-auto-name" });
      this.djHandEl = h("span", { class: "slab-every" });
      this.djStyleButton = h("button", {
        class: "slab-press slab-auto-press slab-dj-style",
        type: "button",
        onclick: () => this.cycleDjStyle()
      }, h("span", { class: "slab-auto-words" }, this.djStyleNameEl, this.djHandEl));
      this.handDown = h("button", { class: "slab-press slab-step", type: "button", "aria-label": "DJ plays less" }, h("span", {}, "\u2212"));
      this.handUp = h("button", { class: "slab-press slab-step", type: "button", "aria-label": "DJ plays more" }, h("span", {}, "+"));
      this.press(this.handDown, () => {
        if (!isOff(this.handDown)) this.setDjHandLevel(this.state.djHand - 1);
      });
      this.press(this.handUp, () => {
        if (!isOff(this.handUp)) this.setDjHandLevel(this.state.djHand + 1);
      });
      this.panel = this.buildPanel();
      onChop((event) => {
        const automatic = event.kind === "auto" || djRunning() && Date.now() - this.lastManualAt > 1500;
        this.flashActivity(event.label, !automatic, automatic);
        if (automatic) this.hitPad(this.pads[0]);
      });
    }
    mount() {
      this.injectStyles();
      this.mountChip();
      document.body.append(this.panel);
      document.addEventListener("pointerdown", this.onPointerStart, true);
      document.addEventListener("click", this.onDocumentClick, true);
      document.addEventListener("contextmenu", this.onDocumentClick, true);
      document.addEventListener("keydown", this.onKey);
      document.addEventListener("keyup", this.onKeyUp);
      window.addEventListener("blur", this.onBlur);
      document.addEventListener("visibilitychange", this.onVisibility);
      onHoldChange((held) => {
        for (const pad of this.pads) {
          if (pad.dataset.hold === "true") setData(pad, "latched", held.has(pad.dataset.pad) ? "true" : "false");
        }
      });
      window.addEventListener("resize", this.onResize);
      this.panel.addEventListener("scroll", this.onScroll, { passive: true });
      if (typeof ResizeObserver === "function") {
        this.sizeWatch = new ResizeObserver(() => this.onResize());
        this.sizeWatch.observe(this.panel);
      }
      if (this.state.open) this.open();
      else this.panel.hidden = true;
      this.renderMoodState();
      this.renderAutoState();
      this.renderBank();
      this.renderDepth();
      this.renderTape();
      this.renderKeep();
      onDj((label) => this.flashActivity(label, false, true));
      setDjHand(this.state.djHand);
      if (this.state.dj) startDj();
      this.renderDj();
      this.renderPitch();
      this.renderEqNote();
      if (this.modernEq && !this.slabOwnsEq()) void this.restoreModernEqCurve();
      let wasLinked = false;
      this.disposeDsp = onDspChange((status2) => {
        this.renderDsp();
        if (status2.linked && !wasLinked) {
          void sendDsp(this.sound());
        }
        wasLinked = status2.linked;
      });
      void probeDsp(true);
      void this.applyMood(this.state.moodId, false);
      this.applyKept(false);
      void this.syncGrid();
      void loadLines();
      this.refresh();
      void Promise.all([
        document.fonts?.load('600 14px "SLAB Barlow"'),
        document.fonts?.load('500 12px "SLAB Barlow"')
      ]).catch(() => void 0).then(() => {
        if (!this.disposed) this.renderSign();
      });
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
      if (this.announceTimer !== null) window.clearTimeout(this.announceTimer);
      if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
      if (this.resizeFrame !== null) window.cancelAnimationFrame(this.resizeFrame);
      for (const timer of this.padTimers.values()) window.clearTimeout(timer);
      this.padTimers.clear();
      for (const release3 of this.releases) release3();
      if (this.lampFrame !== null) window.cancelAnimationFrame(this.lampFrame);
      this.lampFrame = null;
      for (const animation of this.spinAnimations) animation.cancel();
      this.spinAnimations = [];
      this.spinning = false;
      this.strikeAnimation?.cancel();
      this.strikeAnimation = null;
      document.removeEventListener("pointerdown", this.onPointerStart, true);
      document.removeEventListener("click", this.onDocumentClick, true);
      document.removeEventListener("contextmenu", this.onDocumentClick, true);
      document.removeEventListener("keydown", this.onKey);
      document.removeEventListener("keyup", this.onKeyUp);
      window.removeEventListener("blur", this.onBlur);
      document.removeEventListener("visibilitychange", this.onVisibility);
      stopDj();
      onDj(null);
      this.releaseHolds();
      onHoldChange(null);
      window.removeEventListener("resize", this.onResize);
      this.panel.removeEventListener("scroll", this.onScroll);
      this.sizeWatch?.disconnect();
      this.sizeWatch = null;
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
      this.gridMisses = 0;
      void this.syncGrid();
      void loadLines();
      this.keepShown = null;
      this.applyKept(true);
      this.refresh();
    }
    /**
     * An older copy that stood aside may have left its sheet behind; this one
     * wins. Either way the sheet goes last in the head, so it sits after
     * Spotify's own CSS in the cascade, as it would on a clean boot.
     */
    injectStyles() {
      const style2 = document.getElementById(STYLE_ID) ?? h("style", { id: STYLE_ID });
      if (style2.textContent !== CSS) style2.textContent = CSS;
      document.head.append(style2);
    }
    /**
     * Beside the lyrics button, where the playbar's own controls live. Without
     * that anchor the end of the playbar will do for now; with no playbar at all
     * the chip waits off the page rather than landing somewhere it can't be seen.
     */
    mountChip() {
      const lyrics = document.querySelector('[data-testid="lyrics-button"]');
      const host = lyrics?.parentElement;
      if (lyrics && host) {
        if (this.chip.parentElement !== host) host.insertBefore(this.chip, lyrics);
        return;
      }
      if (this.chip.isConnected) return;
      document.querySelector('[data-testid="now-playing-bar"]')?.append(this.chip);
    }
    /**
     * Spotify builds the playbar late and rebuilds it on some navigation, so keep
     * re-homing the chip, and place an open panel again once its anchor exists.
     */
    ensureChip() {
      const wasHome = this.chip.isConnected;
      this.mountChip();
      if (!wasHome && this.chip.isConnected && !this.panel.hidden) this.position();
    }
    buildChip() {
      const chip = h("button", {
        class: "slab-chip",
        type: "button",
        "aria-label": "SLAB playback moods",
        "aria-expanded": "false",
        title: CHIP_TITLE,
        onclick: (event) => {
          event.stopPropagation();
          this.toggle(event.detail === 0);
        },
        onkeydown: (event) => this.handleTab(event, "chip")
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
      rail.style.setProperty("--slab-thumb", `${THUMB_SIZE}px`);
      rail.style.setProperty("--slab-wheel", `${WHEEL_SIZE}px`);
      rail.style.setProperty("--slab-tyre", `${TYRE_RADIUS}px`);
      rail.style.setProperty("--slab-poke", `${WHEEL_SIZE / 2 + POKE_X}px ${WHEEL_SIZE / 2 + POKE_Y}px`);
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
      const head = h("div", { class: "slab-head" }, h("span", { class: "slab-badge", role: "img", "aria-label": "SLAB" }, this.logoTube.node), this.tagEl, this.djButton, close);
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
      const bay = h("div", { class: "slab-bay" }, this.bigWheelEl, stage, pitchHead, this.railEl, scale);
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
        button.innerHTML = `${pinstripe(mood.id)}
        <span class="slab-mood-name">${mood.name}</span>
        <span class="slab-mood-cents">${formatCents(mood.dsp.pitch)}<span class="slab-sr"> cents</span></span>
        ${doorCurve(mood.gains)}`;
        this.moodButtons.set(mood.id, button);
        moodGrid.append(button);
      }
      const mine3 = h("button", {
        class: "slab-mood slab-mine",
        type: "button",
        role: "radio",
        "data-mood": MINE_ID,
        "aria-checked": "false",
        tabindex: "-1"
      });
      this.mineButton = mine3;
      this.moodButtons.set(MINE_ID, mine3);
      this.wireMine(mine3);
      moodGrid.append(mine3);
      this.renderMine();
      const doors = h("div", { class: "slab-doors" }, moodGrid, this.keepButton);
      const readout = h(
        "div",
        { class: "slab-read" },
        h(
          "div",
          { class: "slab-read-top" },
          h("span", { class: "slab-bpm" }, this.bpmEl, h("small", {}, "BPM")),
          h("span", { class: "slab-count" }, this.barEl, this.lampsEl, this.playEl)
        ),
        // What a press just did shows here, right above the pads, then the ruler comes back.
        h("div", { class: "slab-ruler-slot" }, this.rulerEl, this.noGridEl, this.flashEl)
      );
      const tooEarly = "Not that much record behind the needle yet.";
      const chopDefs = [
        { id: "chop1", label: "Chop", sub: "1 bar back", key: "1", bank: "chop", run: () => chopBars(1), miss: tooEarly },
        { id: "chop2", label: "Chop", sub: "2 bars back", key: "2", bank: "chop", run: () => chopBars(2), miss: tooEarly },
        { id: "chop4", label: "Chop", sub: "4 bars back", key: "3", bank: "chop", run: () => chopBars(4), miss: tooEarly },
        {
          id: "loop",
          label: "Loop",
          sub: LOOP_SUB,
          key: "4",
          bank: "chop",
          // A second press ends the loop early.
          run: () => {
            if (!isLooping()) return loopBars(LOOP_TIMES);
            cancelLoop();
            this.flashActivity("Loop off");
            return true;
          },
          miss: "Nothing to loop here yet."
        },
        {
          id: "stop",
          label: "Stop",
          sub: "Tape stop",
          key: "5",
          bank: "chop",
          run: () => {
            if (isStopping()) {
              this.flashActivity("Already stopping");
              return false;
            }
            if (!isPlaying()) {
              this.flashActivity("Already stopped");
              return false;
            }
            void tapeStop(dspStatus().linked ? { spinDown: dspTapeStop, spinDownMs: 470 } : {});
            return true;
          }
        }
      ];
      const screwDefs = [
        {
          id: "screw",
          label: "Screw",
          sub: "Hold it down",
          key: "6",
          bank: "screw",
          available: canHold,
          unavailable: () => NEEDS_HELPER,
          run: () => press("screw", { cents: -this.state.screwDepth * 100 }),
          release: () => release("screw"),
          miss: NEEDS_HELPER
        },
        { id: "line", label: "Line", sub: "Run it back", key: "7", bank: "screw", run: () => runLineBack(), miss: tooEarly },
        {
          id: "trunk",
          label: "Trunk",
          sub: "Hold it shut",
          key: "8",
          bank: "screw",
          available: canHold,
          unavailable: () => NEEDS_HELPER,
          run: () => press("trunk"),
          release: () => release("trunk"),
          miss: NEEDS_HELPER
        },
        {
          id: "echo",
          label: "Echo",
          sub: "Hold it",
          key: "9",
          bank: "screw",
          available: canHold,
          unavailable: () => NEEDS_HELPER,
          run: () => press("echo", { beatMs: this.beatMs() }),
          release: () => release("echo"),
          miss: NEEDS_HELPER
        },
        { id: "spin", label: "Spin", sub: "Back a bar", key: "0", bank: "screw", run: () => spinBack(), miss: tooEarly }
      ];
      const tapeLayer = (id, label, sub) => ({
        id,
        label,
        sub,
        key: "",
        bank: "tape",
        available: canTape,
        unavailable: tapeMissing,
        run: () => {
          const next = { ...this.state.tape };
          next[id] = !next[id];
          this.setTape(next);
          this.flashActivity(`${label} ${next[id] ? "on" : "off"}`);
          return true;
        }
      });
      const tapeDefs = [
        {
          id: "room",
          label: "Room",
          sub: roomName(this.state.tape.room),
          key: "",
          bank: "tape",
          available: processing,
          unavailable: () => NEEDS_HELPER,
          run: () => {
            const room = nextRoom(this.state.tape.room);
            this.setTape({ ...this.state.tape, room });
            this.flashActivity(room ? `In the ${roomName(room).toLowerCase()}` : "Back in the mood's own room");
            return true;
          }
        },
        tapeLayer("wow", "Wow", "Worn tape"),
        tapeLayer("hiss", "Hiss", "Cassette"),
        tapeLayer("crackle", "Crackle", "Vinyl"),
        tapeLayer("crush", "Crush", "Lo-fi")
      ];
      const chopRow = this.padRow("chop", "Cuts", chopDefs);
      const screwRow = this.padRow("screw", "Holds, a line and a spin", screwDefs);
      const tapeRow = this.padRow("tape", "Tape", tapeDefs);
      const auto = h("div", { class: "slab-auto", "data-for": "chop" }, this.everyDown, this.switchEl, this.everyUp);
      const depth = h(
        "div",
        { class: "slab-auto", "data-for": "screw" },
        h("div", { class: "slab-stepper" }, this.depthDown, this.depthEl, this.depthUp)
      );
      this.cleanButton = h("button", {
        class: "slab-press slab-clean",
        type: "button",
        onclick: () => this.cleanTape()
      }, h("span", {}, "Clean tape"));
      const tapeControl = h(
        "div",
        { class: "slab-auto", "data-for": "tape" },
        this.cleanButton,
        h("span", { class: "slab-every slab-tape-note" }, "On over every mood")
      );
      const banks = h(
        "div",
        { class: "slab-banks", role: "radiogroup", "aria-label": "Pads" },
        this.bankButton("chop", "Chop"),
        this.bankButton("screw", "Screw"),
        this.bankButton("tape", "Tape")
      );
      const djRow = h("div", { class: "slab-auto slab-dj-row", "data-for": "chop" }, this.handDown, this.djStyleButton, this.handUp);
      const bankRow = h("div", { class: "slab-bankrow" }, banks, auto, djRow, depth, tapeControl);
      this.sillEl = h(
        "div",
        { class: "slab-sill" },
        h("span", { class: "slab-screw-at slab-screw-left", html: SILL_SCREW_LEFT }),
        h("span", { class: "slab-screw-at slab-screw-right", html: SILL_SCREW_RIGHT }),
        h("div", { class: "slab-sill-plate" }, this.eqNote, this.helperEl, this.speedEl)
      );
      const lower = h("div", { class: "slab-lower" }, readout, chopRow, screwRow, tapeRow, bankRow);
      const body = h("div", { class: "slab-body" }, head, trim, doors, lower, this.sillEl);
      panel.append(h("div", { class: "slab-lip slab-lip-top" }), body, this.statusEl);
      panel.addEventListener("click", (event) => event.stopPropagation());
      panel.addEventListener("keydown", (event) => this.handleTab(event, "panel"));
      return panel;
    }
    /** A row of five pads, one bank: four, then the last a hand's width apart. */
    padRow(bank, label, defs) {
      const row = h("div", { class: "slab-pads", role: "group", "aria-label": label, "data-bank": bank });
      for (const def of defs) {
        const sub = h("small", {}, def.sub);
        const pad = h("button", {
          class: "slab-press slab-pad",
          type: "button",
          "data-pad": def.id,
          ...def.key ? { "aria-keyshortcuts": def.key } : {}
        }, h("i", { class: "slab-key", "aria-hidden": "true" }, def.key), h("b", {}, def.label), sub);
        if (def.id === "loop") this.loopSub = sub;
        if (def.id === "room") this.roomSub = sub;
        if (def.release) {
          setData(pad, "hold", "true");
          this.wireHold(pad, def);
        } else {
          this.press(pad, () => {
            this.showBank(def.bank);
            this.firePad(pad, def);
          });
        }
        this.padDefs.set(pad, def);
        if (def.key) this.padByKey.set(def.key, pad);
        this.pads.push(pad);
        row.append(pad);
      }
      return row;
    }
    /**
     * A held pad is down for as long as a finger, the pointer or its key is: it comes up on
     * the matching up, wherever the pointer has wandered by then.
     */
    wireHold(pad, def) {
      pad.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        try {
          pad.setPointerCapture(event.pointerId);
        } catch {
        }
        this.holdDown(pad, def, `pointer:${event.pointerId}`);
      });
      const up = (event) => this.holdUp(`pointer:${event.pointerId}`);
      pad.addEventListener("pointerup", up);
      pad.addEventListener("pointercancel", up);
      pad.addEventListener("lostpointercapture", up);
      pad.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        this.holdDown(pad, def, `key:${event.code}`);
      });
      pad.addEventListener("keyup", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.holdUp(`key:${event.code}`);
      });
      pad.addEventListener("click", (event) => {
        event.stopPropagation();
        if (event.detail !== 0) return;
        const by = `latch:${def.id}`;
        if (this.heldBy.has(by)) {
          this.holdUp(by);
          this.flashActivity(`${def.label} let go`);
          return;
        }
        this.holdDown(pad, def, by);
        if (this.heldBy.has(by)) this.flashActivity(`${def.label} held. Press again to let go.`);
      });
    }
    holdDown(pad, def, by) {
      if (this.heldBy.has(by)) return;
      this.showBank(def.bank);
      if (isOff(pad)) {
        this.flashActivity(def.available ? def.unavailable?.() ?? NEEDS_HELPER : NO_GRID);
        return;
      }
      this.handPlayed(def);
      if (def.run() !== true) {
        if (def.miss) this.flashActivity(def.miss);
        return;
      }
      this.heldBy.set(by, pad);
    }
    holdUp(by) {
      const pad = this.heldBy.get(by);
      if (!pad) return;
      this.heldBy.delete(by);
      for (const other of this.heldBy.values()) if (other === pad) return;
      this.padDefs.get(pad)?.release?.();
    }
    /** Every held pad up at once: the window lost the keys, or the panel is going. */
    releaseHolds() {
      this.heldBy.clear();
      releaseAll();
    }
    bankButton(bank, label) {
      const button = h("button", {
        class: "slab-press slab-bank",
        type: "button",
        role: "radio",
        "data-bank": bank,
        "aria-checked": "false",
        tabindex: "-1",
        onclick: () => this.showBank(bank),
        onkeydown: (event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const order = ["chop", "screw", "tape"];
          const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
          const next = order[(order.indexOf(bank) + step + order.length) % order.length];
          this.showBank(next);
          this.bankButtons.get(next)?.focus();
        }
      }, h("span", {}, label));
      this.bankButtons.set(bank, button);
      return button;
    }
    /** Shows a bank's pads and its control. Playing a pad from the other bank's key shows that bank. */
    showBank(bank) {
      if (this.state.bank !== bank) {
        this.state.bank = bank;
        saveState(this.state);
      }
      this.renderBank();
    }
    renderBank() {
      const bank = this.state.bank;
      setData(this.panel, "bank", bank);
      for (const [id, button] of this.bankButtons) {
        setAttr(button, "aria-checked", id === bank ? "true" : "false");
        setAttr(button, "tabindex", id === bank ? "0" : "-1");
      }
    }
    setScrewDepth(depth) {
      const next = Math.max(SCREW_MIN, Math.min(SCREW_MAX, Math.round(depth)));
      if (next === this.state.screwDepth) return;
      this.state.screwDepth = next;
      saveState(this.state);
      this.renderDepth();
      this.announceSettled(() => this.depthEl.textContent ?? "");
    }
    /**
     * DJ mode on: the sound you had is kept to go back to, the record goes on full screw, and the
     * DJ starts working it. Off: the DJ stops and your sound comes back as it was.
     */
    toggleDj() {
      if (this.state.dj) {
        stopDj();
        const before = this.state.djBefore;
        this.state.dj = false;
        this.state.djBefore = null;
        if (before) {
          this.state.pitch = before.pitch;
          this.state.tape = { ...before.tape };
          this.renderTape();
          void this.applyMood(before.moodId === MINE_ID && !mineMood() ? "flat" : before.moodId, false);
        } else {
          saveState(this.state);
        }
        this.applyKept(false);
        this.renderDj();
        this.renderAutoState();
        this.flashActivity("DJ off: the record is yours");
        return;
      }
      this.state.djBefore = { moodId: this.state.moodId, pitch: this.state.pitch, tape: { ...this.state.tape } };
      this.state.dj = true;
      this.state.pitch = DJ_PITCH;
      this.state.tape = { ...this.state.tape, wow: true };
      this.renderTape();
      void this.applyMood(DJ_MOOD, false);
      startDj();
      this.renderDj();
      this.renderAutoState();
      this.flashActivity("DJ on: full screw");
    }
    /** The next kind of record for the DJ to play this as; kept for the artist. */
    cycleDjStyle() {
      if (isOff(this.djStyleButton)) return;
      const next = nextDjStyle();
      if (!next) return;
      this.renderDj();
      const artist = currentArtist();
      this.flashActivity(artist?.name ? `Playing ${artist.name} as ${PLAYED_AS[next]} from now on` : `Playing it as ${PLAYED_AS[next]}`);
    }
    /** How hard the DJ plays, 1 to 4. */
    setDjHandLevel(level) {
      const next = Math.max(1, Math.min(HANDS.length, Math.round(level)));
      if (next === this.state.djHand) return;
      this.state.djHand = next;
      saveState(this.state);
      setDjHand(next);
      this.renderDj();
      this.announceSettled(() => `Plays ${HANDS[next - 1]}`);
    }
    /** The switch, in the tagline's place what the DJ makes of the record, and the DJ's row. */
    renderDj() {
      setAttr(this.djButton, "aria-checked", this.state.dj ? "true" : "false");
      setData(this.panel, "dj", this.state.dj ? "on" : "off");
      const style2 = djStyleName();
      setText(this.tagEl, this.state.dj ? style2 ? `DJ on: full screw, ${style2}` : "DJ on: full screw" : TAGLINE);
      const name = style2 ? style2[0].toUpperCase() + style2.slice(1) : "Reading it";
      const hand2 = `plays ${HANDS[this.state.djHand - 1]}`;
      setText(this.djStyleNameEl, name);
      setText(this.djHandEl, hand2);
      setAttr(this.djStyleButton, "aria-label", style2 ? `${name}, ${hand2}: press to play it as another kind of record` : `${name}, ${hand2}`);
      setOff(this.djStyleButton, !style2);
      setOff(this.handDown, this.state.djHand <= 1);
      setOff(this.handUp, this.state.djHand >= HANDS.length);
    }
    /** What the helper plays: the mood, through the tape, at the slider's pitch. */
    sound(mood = moodById(this.state.moodId)) {
      return { ...withTape(mood.dsp, this.state.tape), pitch: this.state.pitch };
    }
    setTape(tape) {
      this.state.tape = { ...tape };
      saveState(this.state);
      this.renderTape();
      void sendDsp(this.sound());
    }
    cleanTape() {
      if (isClean(this.state.tape)) {
        this.flashActivity("The tape is already clean");
        return;
      }
      this.setTape({ ...CLEAN_TAPE });
      this.flashActivity("Clean tape: the mood as it comes");
    }
    /** The tape pads stay lit while they're on, and say so to a screen reader; Room says which room it is. */
    renderTape() {
      const tape = this.state.tape;
      for (const pad of this.pads) {
        const id = pad.dataset.pad;
        if (id === "room") {
          setData(pad, "latched", tape.room ? "true" : "false");
        } else if (id === "wow" || id === "hiss" || id === "crackle" || id === "crush") {
          setData(pad, "latched", tape[id] ? "true" : "false");
          setAttr(pad, "aria-pressed", tape[id] ? "true" : "false");
        }
      }
      if (this.roomSub) setText(this.roomSub, roomName(tape.room));
      if (this.cleanButton) setOff(this.cleanButton, isClean(tape));
    }
    renderDepth() {
      const depth = this.state.screwDepth;
      setText(this.depthEl, `Screws ${depth} semitone${depth === 1 ? "" : "s"} down`);
      setOff(this.depthDown, depth <= SCREW_MIN);
      setOff(this.depthUp, depth >= SCREW_MAX);
    }
    /** One beat of the song where the needle is, for the echo; a 90 BPM beat with no grid. */
    beatMs() {
      const grid = gridFor();
      if (!grid) return 667;
      return beatLengthMs(grid, Math.max(0, beatIndexAt(grid, needlePosition())));
    }
    /**
     * Mine: a tap keeps the sound you hear when it's empty and brings it back when it isn't; a
     * hold keeps what you hear now over what was in it. Shift+Enter does the hold from the keys.
     */
    wireMine(button) {
      let timer = null;
      let kept = false;
      const cancel = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
      };
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        kept = false;
        cancel();
        if (!mineMood()) return;
        timer = window.setTimeout(() => {
          timer = null;
          kept = true;
          this.saveMine(true);
        }, MINE_HOLD_MS);
      });
      for (const type of ["pointerup", "pointerleave", "pointercancel"]) button.addEventListener(type, cancel);
      this.releases.push(cancel);
      button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || !event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        this.saveMine(true);
      });
      button.addEventListener("click", () => {
        if (kept) {
          kept = false;
          return;
        }
        if (mineMood()) {
          this.bringBackMineTape();
          void this.applyMood(MINE_ID, true);
        } else {
          this.saveMine(false);
        }
      });
    }
    /** Mine was kept with a tape: picking it puts that tape back on. */
    bringBackMineTape() {
      const tape = this.state.mine?.tape;
      if (!tape) return;
      this.state.tape = { ...tape };
      this.renderTape();
    }
    /** Keeps what you hear now in Mine: this mood's curve and room, the tape, and the pitch as the slider has it. */
    saveMine(over) {
      const current = moodById(this.state.moodId);
      const from = current.id === MINE_ID ? this.state.mine?.from ?? "flat" : current.id;
      const saved = { from, gains: [...current.gains], dsp: { ...current.dsp, pitch: this.state.pitch }, tape: { ...this.state.tape } };
      this.state.mine = saved;
      setMine(saved);
      this.state.moodId = MINE_ID;
      saveState(this.state);
      this.renderMine();
      this.renderMoodState();
      this.keepFollows();
      this.flashActivity(over ? "Mine holds what you hear now" : "Kept what you hear as Mine");
    }
    renderMine() {
      const button = this.mineButton;
      if (!button) return;
      const mine3 = mineMood();
      setData(button, "empty", mine3 ? "false" : "true");
      button.innerHTML = mine3 ? `${pinstripe(MINE_ID)}
        <span class="slab-mood-name">Mine</span>
        <span class="slab-mood-cents">${formatCents(mine3.dsp.pitch)}<span class="slab-sr"> cents</span></span>
        ${doorCurve(mine3.gains)}` : `${pinstripe(MINE_ID)}
        <span class="slab-mood-name">Mine</span>
        <span class="slab-mood-cents">Tap to keep this sound</span>`;
      setAttr(button, "title", mine3 ? "Your own mood. Hold to keep what you hear now in its place." : "Keeps the mood, pitch and room you hear now as your own.");
    }
    /** The Keep door, for whoever is playing: drawn again only when the artist or what's kept changes. */
    renderKeep() {
      const artist = currentArtist();
      const kept = keptFor(artist);
      const shown = `${artist?.uri ?? ""}|${artist?.name ?? ""}|${kept ? `${kept.moodId}:${kept.pitch}` : ""}`;
      if (shown === this.keepShown) return;
      this.keepShown = shown;
      setAttr(this.keepButton, "aria-pressed", kept ? "true" : "false");
      if (!artist) {
        setText(this.keepNameEl, "Keep for an artist");
        setText(this.keepSubEl, "Nobody playing to keep it for");
        setOff(this.keepButton, true);
        setAttr(this.keepButton, "title", "");
        return;
      }
      const name = artist.name || "this artist";
      setOff(this.keepButton, false);
      setText(this.keepNameEl, `Keep for ${name}`);
      setText(this.keepSubEl, kept ? `Locked on ${moodById(kept.moodId).name}` : "Locks this mood to them");
      setAttr(this.keepButton, "title", kept ? `${name} comes on ${moodById(kept.moodId).name} every time. Press to let it go.` : `Every time ${name} comes on, so does the mood you have now.`);
    }
    toggleKeep() {
      if (isOff(this.keepButton)) return;
      const artist = currentArtist();
      if (!artist) return;
      const name = artist.name || "This artist";
      if (keptFor(artist)) {
        forget(artist);
        this.flashActivity(`${name} plays on whatever's on`);
      } else {
        keep(artist, this.state.moodId, this.state.pitch);
        this.flashActivity(`${name} comes on ${moodById(this.state.moodId).name} from now on`);
      }
      this.renderKeep();
    }
    /** While a mood is kept for this artist, keeping follows what you pick for them. */
    keepFollows() {
      const artist = currentArtist();
      if (artist && keptFor(artist)) keep(artist, this.state.moodId, this.state.pitch);
      this.renderKeep();
    }
    /**
     * A kept artist's track: their mood goes on. Quietly at boot, said out loud on a track change.
     * While DJ mode has the record it stays on full screw, and the kept mood waits for it to go off.
     */
    applyKept(say2) {
      if (this.state.dj) return;
      const artist = currentArtist();
      const kept = keptFor(artist);
      if (!artist || !kept) return;
      const id = kept.moodId === MINE_ID && !mineMood() ? "flat" : kept.moodId;
      const pitch = clampPitch(kept.pitch);
      if (id === this.state.moodId && pitch === this.state.pitch) return;
      this.state.pitch = pitch;
      if (id === MINE_ID) this.bringBackMineTape();
      void this.applyMood(id, false);
      if (say2) this.flashActivity(`${moodById(id).name}, kept for ${artist.name || "this artist"}`);
    }
    handleOutside(event) {
      if (this.panel.hidden) return;
      const target = event.target;
      if (!target) return;
      if (event.type === "click" && event.detail > 0 && this.pressedInside) {
        this.pressedInside = false;
        return;
      }
      if (this.panel.contains(target) || this.chip.contains(target)) return;
      if (event.type === "click" && target instanceof Element && target.closest(TRANSPORT)) return;
      this.close();
    }
    /** Everything Tab can land on in the panel, in order, skipping what is hidden or disabled. */
    focusables() {
      return [...this.panel.querySelectorAll("button, input, [tabindex]")].filter(
        (node) => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length > 0
      );
    }
    /**
     * The panel lives at the end of the page but belongs right after the chip in
     * the tab order: Tab on the open chip goes in, Shift+Tab from the first
     * control comes back out to it, and Tab off the last control carries on to
     * whatever follows the chip in the playbar.
     */
    handleTab(event, from) {
      if (event.key !== "Tab" || this.panel.hidden) return;
      const stops = this.focusables();
      if (!stops.length) return;
      const active = document.activeElement;
      if (from === "chip") {
        if (event.shiftKey) return;
        event.preventDefault();
        stops[0].focus({ preventScroll: true });
        return;
      }
      if (event.shiftKey && active === stops[0]) {
        event.preventDefault();
        this.chip.focus({ preventScroll: true });
      } else if (!event.shiftKey && active === stops[stops.length - 1]) {
        const next = this.stopAfterChip();
        if (!next) return;
        event.preventDefault();
        next.focus({ preventScroll: true });
      }
    }
    /** The next thing Tab would reach after the chip in the page's own order, skipping the panel and anything disabled. */
    stopAfterChip() {
      const all = [...document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")].filter(
        (node) => node.tabIndex >= 0 && !node.hasAttribute("disabled") && !this.panel.contains(node) && node.getClientRects().length > 0
      );
      const at2 = all.indexOf(this.chip);
      return at2 >= 0 ? all[at2 + 1] ?? null : null;
    }
    handleKey(event) {
      if (this.panel.hidden || event.defaultPrevented) return;
      const target = event.target;
      if (event.key === "Tab" && event.shiftKey && target instanceof HTMLElement && target === this.stopAfterChip()) {
        const stops = this.focusables();
        if (stops.length) {
          event.preventDefault();
          stops[stops.length - 1].focus({ preventScroll: true });
        }
        return;
      }
      const inPanel = Boolean(target && (this.panel.contains(target) || this.chip.contains(target)));
      if (event.key === "Escape") {
        if (inPanel || target === document.body || target === document.documentElement) this.close();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const pad = this.padByKey.get(event.key);
      if (!pad) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      if (event.repeat) return;
      const def = this.padDefs.get(pad);
      if (!def) return;
      if (def.release) {
        this.holdDown(pad, def, `key:${event.code}`);
        return;
      }
      this.showBank(def.bank);
      this.firePad(pad, def);
    }
    /**
     * Radiogroup keys: down and right go to the next mood, up and left to the one
     * before. Picking a mood moves live pitch, so a held key doesn't sweep through
     * them and the ends don't wrap from −560 straight to +400.
     */
    handleMoodKey(event) {
      const order = MOODS_BY_PITCH.map((mood) => mood.id);
      if (mineMood()) order.push(MINE_ID);
      const from = order.indexOf(moodById(this.state.moodId).id);
      let to;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          to = Math.min(order.length - 1, from + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          to = Math.max(0, from - 1);
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
      if (event.repeat || to === from) return;
      void this.applyMood(order[to], true, false);
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
      this.chip.removeAttribute("title");
      this.position();
      this.renderMoodState();
      this.refresh();
      void probeDsp(true);
      if (fromKeyboard) {
        if (!this.pitchInput.disabled) this.pitchInput.focus({ preventScroll: true });
        else this.moodButtons.get(moodById(this.state.moodId).id)?.focus({ preventScroll: true });
      }
    }
    close() {
      if (this.panel.contains(document.activeElement) && this.chip.isConnected) this.chip.focus({ preventScroll: true });
      this.releaseHolds();
      this.panel.hidden = true;
      this.state.open = false;
      saveState(this.state);
      this.chip.setAttribute("aria-expanded", "false");
      this.chip.setAttribute("title", CHIP_TITLE);
      this.updateSpin();
    }
    /**
     * Above the chip, then below it, then beside it, so a short window never opens
     * the panel over the button that closes it. The CSS caps height to the window.
     */
    position() {
      if (this.panel.hidden) return;
      const rect = this.chip.getBoundingClientRect();
      const bar = document.querySelector('[data-testid="now-playing-bar"]')?.getBoundingClientRect();
      const ceiling = Math.min(rect.top, bar && bar.height > 0 && bar.top > 0 ? bar.top : rect.top) - 8;
      const room = ceiling - 8;
      const fit = Math.min(1, Math.max(0.5, (window.innerWidth - 16) / PANEL_WIDTH_PX));
      if (fit < 1) this.panel.style.setProperty("scale", String(Math.floor(fit * 1e3) / 1e3));
      else this.panel.style.removeProperty("scale");
      const layoutRoom = room / fit;
      const wasShort = this.panel.dataset.short === "true";
      const natural = this.panel.scrollHeight + (wasShort ? SHORT_SAVING_PX : 0);
      const short = layoutRoom < Math.min(PANEL_MAX_PX, natural);
      if (short !== wasShort) {
        setData(this.panel, "short", String(short));
        this.renderSign();
      }
      const width = (this.panel.offsetWidth || PANEL_WIDTH_PX) * fit;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      let left = Math.max(8, Math.min(maxLeft, rect.right - width));
      let top;
      if (room >= MIN_ROOM_PX) {
        this.panel.style.maxHeight = `${Math.min(PANEL_MAX_PX, layoutRoom)}px`;
        top = ceiling - this.panel.offsetHeight * fit;
      } else {
        this.panel.style.maxHeight = "";
        const height = (this.panel.offsetHeight || PANEL_MAX_PX) * fit;
        const maxTop = Math.max(8, window.innerHeight - height - 8);
        top = rect.bottom + 10;
        if (top > maxTop) {
          top = Math.max(8, Math.min(maxTop, rect.bottom - height));
          if (rect.left - width - 10 >= 8) left = rect.left - width - 10;
          else if (rect.right + 10 <= maxLeft) left = rect.right + 10;
        }
      }
      this.panel.style.left = `${Math.round(left)}px`;
      this.panel.style.top = `${Math.round(Math.max(8, top))}px`;
      this.placeBigWheel();
      this.renderScrollCue();
    }
    /** The big wheel's hub sits on Normal, the middle of the slider, wherever the layout puts it. */
    placeBigWheel() {
      const rail = this.railEl;
      if (!rail.offsetParent) return;
      const x = rail.offsetLeft + railX(0);
      const y = rail.offsetTop + rail.offsetHeight / 2;
      this.bigWheelEl.style.left = `${Math.round(x - BIG_WHEEL_BOX / 2)}px`;
      this.bigWheelEl.style.top = `${Math.round(y - BIG_WHEEL_BOX / 2)}px`;
    }
    /**
     * The big wheel turns once a bar and its ring kicks on every beat. Both run
     * as compositor animations, so a busy page can't make them stutter, and the
     * beat clock only steers them: it reads the playhead, works out where the
     * wheel should be, and nudges its speed a few percent to close any gap, the
     * way a DJ rides a turntable's pitch to hold a mix. Only a real jump (a seek,
     * a new track) snaps it. Chops and loops jump whole bars, so the phase they
     * land on is the phase the wheel already has.
     */
    turnBigWheel(grid, raw) {
      if (reducedMotion()) {
        this.stopBigWheel();
        return;
      }
      const t = performance.now();
      const clock = this.wheelClock;
      if (!clock || Math.abs(raw - (clock.pos + (t - clock.at))) > 320) {
        this.wheelClock = { pos: raw, at: t, raw };
      } else if (raw !== clock.raw) {
        const predicted = clock.pos + (t - clock.at);
        this.wheelClock = { pos: predicted + (raw - predicted) * 0.2, at: t, raw };
      }
      const steering = this.wheelTurn?.playState === "running" && this.ringKick?.playState === "running";
      if (steering && t - this.lastWheelSteer < 180) return;
      this.lastWheelSteer = t;
      const pos = this.wheelClock.pos + (t - this.wheelClock.at);
      const bar = barIndexAt(grid, pos);
      if (bar < 0) return;
      const barLength = barLengthMs(grid, bar);
      if (!(barLength > 0)) return;
      this.wheelTurn ?? (this.wheelTurn = this.bigTurnEl.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
        duration: 1e3,
        iterations: Infinity,
        easing: "linear"
      }));
      this.ringKick ?? (this.ringKick = this.ringTube.gas.animate(
        [
          { opacity: 0.9, easing: "cubic-bezier(0.15, 0.7, 0.3, 1)" },
          { opacity: 0.28, offset: 0.8 },
          { opacity: 0.28 }
        ],
        { duration: 1e3, iterations: Infinity }
      ));
      const settling = t - this.wheelStartedAt < 1200;
      if (steer(this.wheelTurn, (pos - barStartMs(grid, bar)) / barLength, barLength, settling)) this.wheelStartedAt = t;
      const beat = beatIndexAt(grid, pos);
      const beatStart = grid.beats[beat];
      if (beatStart === void 0) return;
      const beatLength = (grid.beats[beat + 1] ?? beatStart + barLength / Math.max(1, grid.timeSignature || 4)) - beatStart;
      if (beatLength > 0) steer(this.ringKick, (pos - beatStart) / beatLength, beatLength, settling);
    }
    /** Paused, closed or no beat: the wheel stops where it is, and picks the beat up again on play. */
    stopBigWheel() {
      this.wheelTurn?.pause();
      this.ringKick?.pause();
      this.wheelClock = null;
    }
    /** Only when a short window has hidden part of the panel. Writes only on change. */
    renderScrollCue() {
      const hidden = this.panel.scrollHeight - this.panel.clientHeight;
      setData(this.panel, "more", hidden - this.panel.scrollTop > 2 ? "true" : "false");
      setData(this.panel, "above", this.panel.scrollTop > 2 ? "true" : "false");
    }
    async applyMood(id, announce, speak = true) {
      this.state.moodId = id;
      const mood = moodById(id);
      if (announce) this.state.pitch = mood.dsp.pitch;
      saveState(this.state);
      if (announce) this.keepFollows();
      this.renderMoodState();
      this.renderPitch(announce);
      this.renderDsp();
      if (announce) this.strikeSign();
      if (this.slabOwnsEq()) {
        if (id === "flat") await restoreBaseline();
        else await applyCurve(mood.gains);
      }
      void sendDsp(this.sound(mood));
      if (announce) this.flashActivity(mood.name, speak);
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
      this.state.pitch = clampPitch(cents);
      this.renderPitch();
      this.renderLit();
      this.pendingPitch = this.state.pitch;
      if (commit) {
        this.flushPitch(true);
        return;
      }
      if (this.pitchTimer !== null) return;
      this.pitchTimer = window.setTimeout(() => this.flushPitch(false), 90);
    }
    /**
     * The range's own big steps are a tenth of its travel, 240 cents, which lands
     * on no semitone. PageUp/PageDown and Shift+arrows move one semitone instead.
     */
    onPitchKey(event) {
      let step = 0;
      if (event.key === "PageUp") step = 100;
      else if (event.key === "PageDown") step = -100;
      else if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowRight")) step = 100;
      else if (event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowLeft")) step = -100;
      if (!step) return;
      event.preventDefault();
      if (!this.pitchInput.disabled) this.setPitch(this.state.pitch + step, false);
    }
    stopRoll() {
      if (this.rollTimer !== null) window.clearTimeout(this.rollTimer);
      this.rollTimer = null;
      delete this.railEl.dataset.rolling;
    }
    /** Nudges and Normal, which arrive as one committed value; the new pitch is said once the presses stop. */
    setPitch(cents, roll) {
      this.state.pitch = clampPitch(cents);
      this.announceSettled(() => this.pitchInput.getAttribute("aria-valuetext") ?? "");
      this.renderPitch(roll);
      this.renderLit();
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
      if (persist) {
        saveState(this.state);
        this.keepFollows();
      }
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
      const applied = this.hearing().processing;
      if (this.pitchInput.value !== String(cents)) this.pitchInput.value = String(cents);
      if (!linked && document.activeElement === this.pitchInput) this.normalButton.focus();
      if (this.pitchInput.disabled === linked) this.pitchInput.disabled = !linked;
      setOff(this.nudgeDown, !linked || cents <= -PITCH_LIMIT);
      setOff(this.nudgeUp, !linked || cents >= PITCH_LIMIT);
      setOff(this.normalButton, !linked);
      setAttr(
        this.railEl,
        "title",
        linked ? "Pitch shift applied to Spotify\u2019s audio by the SLAB helper." : "Pitch needs the SLAB helper running. The browser cannot repitch a DRM-protected stream."
      );
      setText(
        this.semiEl,
        !status2.checked ? "Looking for the helper" : !linked ? "Pitch needs the helper" : cents === 0 ? "Original key" : `${applied ? "" : "Set to "}${formatSemitones(cents)} ${cents < 0 ? "down" : "up"}`
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
      const turned = `rotate(${(x / TYRE_RADIUS * (180 / Math.PI)).toFixed(1)}deg)`;
      this.wheelEl.style.transform = `translateX(${x}px)`;
      this.rollEl.style.transform = turned;
      this.knockRollEl.style.transform = turned;
      const reach = Math.abs(cents) / PITCH_LIMIT;
      this.hotUp.style.transform = `scaleX(${cents > 0 ? reach : 0})`;
      this.hotDown.style.transform = `scaleX(${cents < 0 ? reach : 0})`;
      this.runUp.style.transform = this.hotUp.style.transform;
      this.runDown.style.transform = this.hotDown.style.transform;
      for (const animation of this.spinAnimations) animation.playbackRate = 2 ** (cents / 1200);
    }
    /**
     * The spokes turn only while this computer is making the sound being shifted.
     * A long-lived animation with a playback rate, so a pitch change speeds the
     * wheel up in place instead of snapping it back to the start of a turn.
     */
    updateSpin() {
      if (this.disposed) return;
      const should = !this.panel.hidden && this.hearing().shifting && !reducedMotion();
      if (should === this.spinning) return;
      this.spinning = should;
      setData(this.wheelEl, "spin", should ? "on" : "off");
      if (!should) {
        for (const animation of this.spinAnimations) animation.pause();
        return;
      }
      if (!this.spinAnimations.length) {
        const turn = [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }];
        const timing = { duration: SPIN_MS, iterations: Infinity, easing: "linear" };
        this.spinAnimations = [this.spinEl.animate(turn, timing), this.knockSpinEl.animate(turn, timing)];
        for (const animation of this.spinAnimations) animation.playbackRate = 2 ** (this.state.pitch / 1200);
      }
      for (const animation of this.spinAnimations) animation.play();
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
    /** Places the panel again if it's open; its height changes with the ModernEQ row. */
    reposition() {
      if (!this.panel.hidden) this.position();
    }
    /** With no ModernEQ the row goes and the sill's fixed height re-centres the rest. */
    renderEqNote() {
      if (!this.modernEq && this.state.eqOwner !== "modern") {
        if (!this.eqNote.hidden && this.eqNote.contains(document.activeElement)) {
          this.moodButtons.get(moodById(this.state.moodId).id)?.focus({ preventScroll: true });
        }
        this.eqNote.hidden = true;
        if (this.sillEl) setData(this.sillEl, "eq", "off");
        this.reposition();
        return;
      }
      this.eqNote.hidden = false;
      if (this.sillEl) setData(this.sillEl, "eq", "on");
      this.reposition();
      const label = this.eqNoteButton.firstElementChild;
      if (this.slabOwnsEq()) {
        setText(this.eqNoteText, "SLAB has the EQ.");
        setText(label, "Use ModernEQ");
      } else {
        setText(this.eqNoteText, "ModernEQ has the EQ.");
        setText(label, "Use SLAB EQ");
      }
    }
    /**
     * Hand the bands back with the curve ModernEQ last saved. With no saved
     * curve, put back the user's own, so SLAB's mood isn't left on the filters
     * while the sill says SLAB isn't changing the sound.
     */
    async restoreModernEqCurve() {
      const bands = modernEqBands();
      if (bands) await applyCurveAtFrequencies(bands);
      else await restoreBaseline();
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
     * The parameters the helper is running: what it has confirmed, by answering
     * a POST or in its own status, so a POST that didn't land never shows as
     * playing. Fields a helper doesn't report fall back to what SLAB sent;
     * syncDspParams() gets the panel's values through when they drift.
     */
    helperParams() {
      const sent2 = this.sound();
      const got = dspStatus().params ?? {};
      const pick2 = (key) => {
        const value = got[key];
        return typeof value === "number" && Number.isFinite(value) ? value : sent2[key];
      };
      return { pitch: pick2("pitch"), reverb: pick2("reverb"), delayMix: pick2("delayMix"), lowpass: pick2("lowpass") };
    }
    helperEffects() {
      const running3 = this.helperParams();
      return [
        ...Math.abs(running3.pitch) >= 1 ? ["pitch"] : [],
        ...running3.reverb > 0 ? ["reverb"] : [],
        ...running3.delayMix > 0 ? ["delay"] : [],
        ...running3.lowpass < 2e4 ? ["low-pass"] : [],
        ...this.helperTape() ? ["tape"] : []
      ];
    }
    /** The tape is running: a helper that plays it has a layer on, by what it confirmed or was sent. */
    helperTape() {
      const status2 = dspStatus();
      if (status2.tape !== true) return false;
      const sent2 = this.sound();
      const got = status2.params ?? {};
      return ["wow", "hiss", "crackle", "crush"].some((key) => {
        const value = got[key];
        return (typeof value === "number" && Number.isFinite(value) ? value : sent2[key]) > 0;
      });
    }
    /**
     * What can be heard right now, decided in one place so the sign, the chip,
     * the tube, the wheel and the sill can never tell different stories. The EQ
     * and the tap both only reach audio on this computer. The EQ half counts when
     * there is an EQ, SLAB owns it and the mood isn't Flat; the helper half counts
     * while audio is flowing through it and it is changing something.
     */
    hearing() {
      const status2 = dspStatus();
      const remote = remoteDeviceName();
      const processing2 = !remote && status2.linked && status2.tapping === true && status2.audio === true && isPlaying();
      const eq = !remote && eqAvailable() && this.slabOwnsEq() && this.state.moodId !== "flat";
      const helper = processing2 && this.helperEffects().length > 0;
      const shifting = processing2 && Math.abs(this.helperParams().pitch) >= 1;
      return { remote, processing: processing2, shifting, audible: isPlaying() && (eq || helper) };
    }
    /**
     * The sign and the chip are lit only while the mood can be heard. The pitch
     * tube, its number and the wheel's spin say the same about pitch: lit and
     * turning only while the helper is actually shifting it, warm idle glass
     * while the helper is ready with nothing to shift. The paint only goes when
     * the sound has left the room.
     */
    renderLit() {
      const { remote, shifting, audible } = this.hearing();
      const mood = moodById(this.state.moodId);
      setData(this.panel, "primer", remote ? "true" : "false");
      setData(this.panel, "gas", audible ? "on" : "off");
      setData(this.panel, "tube", remote || !dspStatus().linked ? "off" : shifting ? "on" : "idle");
      setData(this.chip, "remote", remote ? "true" : "false");
      setData(this.chip, "on", audible ? "true" : "false");
      setData(this.panel, "eq", eqAvailable() && this.slabOwnsEq() ? "slab" : "other");
      setAttr(
        this.chip,
        "aria-label",
        remote ? `SLAB playback moods. Spotify is playing on ${remote}, so SLAB isn\u2019t heard.` : audible ? `SLAB playback moods, ${mood.name}${this.state.pitch !== 0 ? `, ${formatSemitones(this.state.pitch)} ${this.state.pitch < 0 ? "down" : "up"}` : ""} on` : mood.id === "flat" ? "SLAB playback moods, Flat" : `SLAB playback moods, ${mood.name} picked but not heard right now`
      );
    }
    /** The panel states what is true now, including the cases where SLAB is doing nothing audible. */
    renderDsp() {
      const remote = remoteDeviceName();
      this.renderLit();
      this.deadRemote = remote;
      if (remote) {
        setText(this.deadWhereEl, `Playing on ${deviceSentence(remote)}`);
        setAttr(this.deadEl, "title", `Playing on ${remote}. Moods, pitch and effects apply when Spotify plays here.`);
        this.deadEl.hidden = false;
      } else {
        this.deadEl.hidden = true;
        setText(this.deadWhereEl, "");
        this.deadEl.removeAttribute("title");
      }
      this.renderSign();
      this.renderHelperLine();
      this.renderPitch();
      this.updateSpin();
    }
    /** What the helper is doing, built from what it reports and what was sent to it. */
    helperLine() {
      const status2 = dspStatus();
      if (remoteDeviceName()) {
        return {
          state: "remote",
          text: status2.linked ? "Helper has nothing to process until this computer plays." : "Helper isn\u2019t running.",
          title: "The EQ and the helper only touch audio on this computer."
        };
      }
      if (!status2.checked) {
        return {
          state: "checking",
          text: "Looking for the helper.",
          title: "Checking whether the SLAB helper is running on this computer."
        };
      }
      if (!status2.linked) {
        const shaping = eqAvailable() && this.slabOwnsEq() && this.state.moodId !== "flat";
        return {
          state: "offline",
          text: shaping ? "Helper isn\u2019t running, so SLAB only shapes the EQ." : !eqAvailable() ? "No helper and no EQ here, so SLAB can\u2019t change the sound." : this.state.moodId === "flat" && this.slabOwnsEq() ? "Helper isn\u2019t running. Flat leaves your EQ as it was." : "Helper isn\u2019t running, so SLAB isn\u2019t changing the sound.",
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
      if (!status2.audio || !isPlaying()) {
        const paused = !isPlaying();
        return {
          state: paused ? "paused" : "silent",
          text: paused ? "Helper is attached. Spotify is paused." : "Helper is attached. No audio coming through yet.",
          title: "The SLAB helper is attached to Spotify and nothing is playing here."
        };
      }
      const behind = typeof status2.latencyMs === "number" ? `, ${Math.round(status2.latencyMs)} ms behind` : "";
      const effects = this.helperEffects();
      const doing = effects.length === 0 ? "live and dry" : effects.length === 1 && effects[0] === "pitch" ? "shifting pitch" : `running ${listWords(effects)}`;
      return {
        state: "live",
        text: `Helper is ${doing}${behind}.`,
        title: "The SLAB helper is running and processing Spotify\u2019s audio."
      };
    }
    /** Runs from the refresh loop so the latency and the mood can't go stale. */
    renderHelperLine() {
      const { state, text, title } = this.helperLine();
      setText(this.helperEl, text);
      setAttr(this.helperEl, "title", title);
      const quiet = (name) => name === "live" || name === "paused" || name === "silent";
      if (this.lastHelperState !== null && this.lastHelperState !== "checking" && this.lastHelperState !== state && !(quiet(this.lastHelperState) && quiet(state))) {
        this.announce(text);
      }
      this.lastHelperState = state;
    }
    /** For values a held button steps through: speak only the one it stops on, read when it stops. */
    announceSettled(text) {
      if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => {
        this.settleTimer = null;
        this.announce(text());
      }, 500);
    }
    /** Emptied first, so the same words twice (two chops in a row) are still spoken twice. */
    announce(text) {
      this.statusEl.textContent = "";
      if (this.announceTimer !== null) window.clearTimeout(this.announceTimer);
      this.announceTimer = window.setTimeout(() => {
        this.announceTimer = null;
        this.statusEl.textContent = text;
      }, 40);
    }
    /** Playback can move to another device at any moment, and a screen reader hears it go and come back. */
    refreshConnect() {
      const remote = remoteDeviceName();
      if (remote === this.lastRemote) return;
      const before = this.lastRemote;
      this.lastRemote = remote;
      this.renderDsp();
      if (remote) this.announce(`Playing on ${deviceSentence(remote)} SLAB only reaches this computer.`);
      else if (before) this.announce("Spotify is playing on this computer again.");
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
      this.renderLit();
    }
    /**
     * "Playing on …" keeps to its one line: a long device name is cut back a word
     * at a time until it fits, so the line under it is never the one pushed out,
     * at any text spacing. The full name stays in the title and the chip's name.
     * A hidden panel measures nothing; opening it renders again.
     */
    fitDeadLine() {
      const remote = this.deadRemote;
      if (!remote || this.deadEl.hidden) return;
      const where = this.deadWhereEl;
      let max = DEVICE_NAME_MAX;
      setText(where, `Playing on ${deviceSentence(remote, max)}`);
      while (max > 8 && where.offsetHeight > DEAD_LINE_PX * 1.5) {
        max -= 4;
        setText(where, `Playing on ${deviceSentence(remote, max)}`);
      }
    }
    /**
     * The tube keeps its gauge at any size; a message that wraps to two lines gets
     * the sign's lower part. Measured, not counted, so a fallback font or a narrow
     * name can't fool it. A hidden panel measures nothing, and opening it renders again.
     */
    renderSign() {
      this.fitDeadLine();
      const mood = moodById(this.state.moodId);
      const compact = this.panel.dataset.short === "true" || !this.deadEl.hidden && this.deadEl.scrollHeight > DEAD_LINE_PX * 1.5;
      setData(this.panel, "compact", compact ? "true" : "false");
      this.signTube.set(signLayout(mood.id, mood.name, compact ? COMPACT_SIGN_HEIGHT : SIGN_HEIGHT));
      this.placeBigWheel();
    }
    toggleAuto() {
      if (!this.state.auto && !gridFor()) {
        this.flashActivity("Auto chop needs a beat grid, and this track has none.");
        return;
      }
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
      this.announceSettled(() => `Every ${next} bar${next === 1 ? "" : "s"}`);
    }
    renderAutoState() {
      const every = this.state.every;
      setAttr(this.switchEl, "aria-checked", String(this.state.auto));
      setData(this.panel, "auto", this.state.auto ? "on" : "off");
      this.renderEvery();
      setOff(this.everyDown, every <= EVERY_MIN);
      setOff(this.everyUp, every >= EVERY_MAX);
      setAuto(this.state.auto && !this.state.dj, every);
    }
    /** "Every 4 bars", and while auto chop runs, how far off the next cut is, so it can be played to. */
    renderEvery() {
      const every = this.state.every;
      const base = `Every ${every} bar${every === 1 ? "" : "s"}`;
      const grid = gridFor();
      const ahead = this.state.auto && grid && isPlaying() ? autoBarsAhead(barIndexAt(grid, progressMs())) : null;
      setText(this.everyEl, ahead === null ? base.toLowerCase() : `every ${every}, ${ahead === 1 ? "next bar" : `next in ${ahead}`}`);
    }
    /**
     * What a press just did, said right above the pads in the ruler's place for
     * a moment, so the answer lands where the hand is. Nothing else moves. What
     * plays on its own (the DJ, auto chop) waits behind the answer to a press for
     * a moment, so the answer is read.
     */
    flashActivity(text, speak = true, onItsOwn = false) {
      if (onItsOwn && Date.now() - this.answeredAt < ANSWER_HOLD_MS) return;
      if (!onItsOwn) this.answeredAt = Date.now();
      this.flashEl.textContent = text;
      setData(this.panel, "flash", "true");
      if (speak) this.announce(text);
      if (this.activityTimer !== null) window.clearTimeout(this.activityTimer);
      this.activityTimer = window.setTimeout(() => {
        this.activityTimer = null;
        this.flashEl.textContent = "";
        setData(this.panel, "flash", "false");
      }, 1800);
    }
    /**
     * Pads and nudges act on the way down, like hardware: pointerdown for the
     * mouse, keydown for Enter and Space. A click with no pointer behind it, from
     * a screen reader or the number keys, still works. With `repeat`, holding
     * keeps it going, after a pause long enough that a tap stays a tap.
     */
    press(button, action, repeat = false) {
      let downAt = 0;
      let holdTimer = null;
      const release3 = () => {
        if (holdTimer !== null) window.clearTimeout(holdTimer);
        holdTimer = null;
      };
      const hold2 = (event, delay) => {
        holdTimer = window.setTimeout(() => {
          if (isOff(button)) return release3();
          action(event);
          hold2(event, 70);
        }, delay);
      };
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        downAt = Date.now();
        action(event);
        if (repeat) {
          release3();
          hold2(event, 420);
        }
      });
      for (const type of ["pointerup", "pointerleave", "pointercancel"]) button.addEventListener(type, release3);
      button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat && !repeat) return;
        action(event);
      });
      button.addEventListener("keyup", (event) => {
        if (event.key === " ") event.preventDefault();
      });
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (event.detail === 0 && Date.now() - downAt > 400) action(event);
      });
      this.releases.push(release3);
    }
    /** A pad played by hand: DJ mode steps back for eight bars, and learns where you play. */
    handPlayed(def) {
      this.lastManualAt = Date.now();
      if (def.bank !== "tape") djYield(isMove(def.id) ? def.id : void 0);
    }
    /** Lights the pad only when the edit actually happened, and says why when it couldn't. */
    firePad(pad, def) {
      if (isOff(pad)) {
        this.flashActivity(def.available ? def.unavailable?.() ?? NEEDS_HELPER : NO_GRID);
        return;
      }
      this.handPlayed(def);
      void Promise.resolve(def.run()).then((ran) => {
        if (this.disposed) return;
        if (ran) this.hitPad(pad);
        else if (def.miss) this.flashActivity(def.miss);
      });
    }
    /** A hit lights the pad with the sign's gas for a moment. */
    hitPad(pad) {
      if (!pad) return;
      pad.dataset.hit = "true";
      const running3 = this.padTimers.get(pad);
      if (running3 !== void 0) window.clearTimeout(running3);
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
      const want = this.sound();
      const have = status2.params ?? {};
      const tapeDrift = status2.tape === true && ["wow", "hiss", "crackle", "crush"].some(
        (key) => Math.abs((have[key] ?? 0) - want[key]) > 0.01
      );
      const drifted = Math.abs((have.pitch ?? 0) - want.pitch) > 1 || Math.abs((have.reverb ?? 0) - want.reverb) > 1 || Math.abs((have.lowpass ?? 2e4) - want.lowpass) > 50 || tapeDrift;
      if (!drifted) return;
      this.lastDspSync = now;
      void sendDsp(want);
    }
    async syncGrid(force = false) {
      const uri2 = Spicetify.Player.data?.item?.uri;
      if (!uri2) return;
      if (!force && uri2 === this.lastGridUri && gridFor(uri2)) return;
      if (uri2 !== this.lastGridUri) this.gridMisses = 0;
      this.lastGridUri = uri2;
      this.lastGridAttempt = Date.now();
      const grid = await loadGrid(uri2);
      if (this.disposed) return;
      if (uri2 === this.lastGridUri) this.gridMisses = grid ? 0 : this.gridMisses + 1;
      this.refresh();
    }
    /**
     * Analysis can fail on the first try (player not hydrated, network hiccup),
     * so a missing grid is fetched again: after 5 s, 30 s and 2 min, then left
     * alone until the track changes. A track that changed without a songchange
     * event is picked up here too.
     */
    retryGrid() {
      const uri2 = Spicetify.Player.data?.item?.uri;
      if (!uri2 || gridFor(uri2)) return;
      if (uri2 !== this.lastGridUri) {
        void this.syncGrid();
        return;
      }
      const wait = GRID_RETRY_MS[this.gridMisses - 1];
      if (wait !== void 0 && Date.now() - this.lastGridAttempt > wait) void this.syncGrid(true);
    }
    /**
     * One tick per real bar at its real time, a taller one on every phrase line
     * (every N bars, the count auto chop cuts on), closing on the track's end. A track too long for that at two pixels a tick draws every
     * fourth bar instead, or every sixteenth, and the title says so.
     */
    buildRuler(grid) {
      const phrase = Math.max(1, this.state.every);
      const key = `${grid.uri}:${grid.bars.length}:${phrase}`;
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
        d += `M${x} ${index % phrase === 0 ? 1 : 7}V14`;
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
      watchNeedle();
      void probeDsp(false, !this.panel.hidden);
      this.retryGrid();
      this.syncDspParams();
      this.refreshEqOwner();
      this.refreshConnect();
      const playingNow = isPlaying();
      if (playingNow !== this.lastPlaying) {
        this.lastPlaying = playingNow;
        this.renderDsp();
      }
      this.renderLit();
      this.updateSpin();
      if (!playingNow || this.panel.hidden) this.stopBigWheel();
      if (this.panel.hidden) return;
      this.renderHelperLine();
      const playing2 = isPlaying();
      setData(this.panel, "playing", playing2 ? "true" : "false");
      setText(this.playEl, playing2 ? "Playing" : "Paused");
      const grid = gridFor();
      setData(this.panel, "grid", grid ? "true" : "false");
      if (!grid) {
        setText(this.bpmEl, "\u2013");
        setText(this.barEl, "Bar \u2013");
        setText(this.noGridEl, NO_GRID);
        setAttr(this.lampsEl, "aria-label", "No beat");
        this.setLampCount(4);
        this.renderLamps(-1);
      } else {
        setText(this.bpmEl, grid.tempo > 0 ? grid.tempo.toFixed(1) : "\u2013");
        setText(this.noGridEl, "");
        this.renderBeat(grid);
      }
      const speed = this.speedInfo();
      setText(this.speedEl, speed.text);
      setAttr(this.speedEl, "title", speed.hint);
      for (const pad of this.pads) {
        const def = this.padDefs.get(pad);
        const off = def?.available ? !def.available() : pad.dataset.pad !== "stop" && !grid;
        setOff(pad, off);
        if (off && !def?.available) setAttr(pad, "aria-describedby", "slab-nogrid");
        else if (pad.hasAttribute("aria-describedby")) pad.removeAttribute("aria-describedby");
        setAttr(pad, "title", off && def?.available ? def.unavailable?.() ?? NEEDS_HELPER : "");
      }
      this.renderKeep();
      this.renderDj();
      this.renderEvery();
      const left = loopRemaining();
      const looping = isLooping();
      const loopPad = this.pads.find((pad) => pad.dataset.pad === "loop");
      if (loopPad) setData(loopPad, "latched", looping ? "true" : "false");
      if (this.loopSub) setText(this.loopSub, !looping ? LOOP_SUB : left > 0 ? `${left} to go` : "Last pass");
      const autoOff = !grid && !this.state.auto || this.state.dj;
      setOff(this.switchEl, autoOff);
      if (autoOff) setAttr(this.switchEl, "aria-describedby", "slab-nogrid");
      else if (this.switchEl.hasAttribute("aria-describedby")) this.switchEl.removeAttribute("aria-describedby");
      if (playing2 && grid && this.lampFrame === null) this.lampFrame = window.requestAnimationFrame(() => this.tickBeat());
    }
    /** Bar, beat lamps and ruler, from where the record actually is. */
    renderBeat(grid) {
      const progress = progressMs();
      const bar = barIndexAt(grid, progress);
      const beat = beatIndexAt(grid, progress);
      const beatsPerBar = Math.max(1, grid.timeSignature || 4);
      const firstBeat = beatIndexAt(grid, (grid.bars[Math.max(0, bar)] ?? 0) + 30);
      const beatInBar = Math.max(0, Math.min(beatsPerBar - 1, beat - firstBeat));
      setText(this.barEl, `Bar ${Math.max(1, bar + 1)} of ${barCount(grid)}`);
      this.setLampCount(Math.min(7, beatsPerBar));
      this.renderLamps(beatInBar);
      setAttr(this.lampsEl, "aria-label", `Beat ${beatInBar + 1} of ${beatsPerBar}`);
      this.turnBigWheel(grid, progress);
      this.buildRuler(grid);
      if (bar !== this.rulerBar) {
        this.rulerBar = bar;
        const span = grid.durationMs || 1;
        const start = grid.bars[Math.max(0, bar)] ?? 0;
        const lit = bar < 0 ? 0 : Math.min(RULER_WIDTH, Math.round(start / span * (RULER_WIDTH - 1)) + 1);
        this.rulerClip.style.clipPath = `inset(0 ${RULER_WIDTH - lit}px 0 0)`;
      }
    }
    /**
     * While the panel is open and the record is playing, the lamps follow the
     * beat every frame instead of every tenth of a second, so a lamp is never a
     * hundred milliseconds late. Writes still only happen when a lamp changes.
     */
    tickBeat() {
      this.lampFrame = null;
      if (this.disposed || this.panel.hidden || !isPlaying()) {
        this.stopBigWheel();
        return;
      }
      const grid = gridFor();
      if (!grid) {
        this.stopBigWheel();
        return;
      }
      this.renderBeat(grid);
      this.renderEvery();
      this.lampFrame = window.requestAnimationFrame(() => this.tickBeat());
    }
    /**
     * The speed lock only explains anything while the helper is absent. With the
     * helper live, tempo staying put is the README's business, not a line that
     * sits on the sill all day.
     */
    speedInfo() {
      const dsp = dspStatus();
      const remote = remoteDeviceName();
      if (!dsp.checked || dsp.linked || remote) return { text: "", hint: "" };
      const api = Spicetify.Platform.PlayerAPI;
      const capabilities = typeof api.getCapabilities === "function" ? api.getCapabilities() : null;
      const state = api.getState();
      const reasons = state?.restrictions?.disallowSettingPlaybackSpeedReasons ?? [];
      if (capabilities && !capabilities.canChangeSpeed) {
        return {
          text: "This client has no playback speed control.",
          hint: "This client does not expose playback speed."
        };
      }
      if (reasons.length > 0) {
        const reason = String(reasons[0]);
        return {
          text: reason === "unknown" ? "Spotify locks playback speed for music." : `Speed is locked: ${reason.replace(/_/g, " ")}.`,
          hint: "Spotify blocks playback speed for music on this build. SLAB shapes tone and edits instead."
        };
      }
      if (!capabilities) return { text: "", hint: "" };
      return {
        text: "This build allows playback speed.",
        hint: "This build allows playback speed."
      };
    }
  };

  // src/main.ts
  var VERSION = "0.10.1";
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
  function release2(claim) {
    if (window.__slabClaim === claim) window.__slabClaim = void 0;
  }
  async function boot2(claim) {
    const player = await waitFor(
      () => typeof Spicetify !== "undefined" && Spicetify.Player ? Spicetify.Player : null
    );
    if (!player) {
      console.warn(LOG, "player never appeared, giving up");
      release2(claim);
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
  var running2 = window.SLAB;
  var claimed = window.__slabClaim;
  var rival = running2?.version ?? claimed?.version;
  if (rival && !isNewer(VERSION, rival)) {
    console.info(LOG, `v${VERSION} standing down, v${rival} is already loaded`);
  } else {
    const claim = { version: VERSION };
    window.__slabClaim = claim;
    try {
      running2?.destroy?.();
    } catch {
    }
    void boot2(claim).catch((error) => {
      release2(claim);
      console.error(LOG, "boot failed", error);
    });
  }
})();
