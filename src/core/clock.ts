/**
 * A ticker that survives a backgrounded Spotify window.
 *
 * Chrome clamps main-thread timers to ~1s once the window is occluded, which
 * would put every auto-chop a bar behind. Worker timers are not clamped, so the
 * clock lives there and posts a plain timestamp.
 */

type Tick = (now: number) => void;

const subscribers = new Set<Tick>();
let worker: Worker | null = null;
let objectUrl: string | null = null;

const SOURCE = `
let id = null;
self.onmessage = (event) => {
  if (event.data === "start") {
    if (id === null) id = setInterval(() => self.postMessage(Date.now()), 40);
  } else if (event.data === "stop") {
    if (id !== null) { clearInterval(id); id = null; }
  }
};
`;

/** Where the ticks come from: a worker, or (when one can't run) a main-thread timer. */
let mode: "worker" | "main" | null = null;
let mainTimer: number | null = null;
let watchdog: number | null = null;
/** When the worker last ticked. */
let lastTick = 0;
/** A worker silent this long while something listens has died; the main thread takes over. */
const WORKER_SILENT_MS = 3_000;

function tickAll(now: number): void {
    for (const tick of subscribers) {
        try {
            tick(now);
        } catch {
            /* one bad subscriber shouldn't stop the clock */
        }
    }
}

function startMainTimer(): void {
    if (mainTimer === null) mainTimer = window.setInterval(() => tickAll(Date.now()), 40);
}

function stopTimers(): void {
    if (mainTimer !== null) window.clearInterval(mainTimer);
    if (watchdog !== null) window.clearInterval(watchdog);
    mainTimer = null;
    watchdog = null;
}

/** No worker (a locked-down client), or one that stopped ticking: a main-thread timer is slower when hidden, but it ticks. */
function useMainThread(): void {
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

/**
 * For as long as anything listens, not just at the start: a worker that ticks
 * and then goes quiet would otherwise leave a loop latched and auto chop dead
 * while the record plays on.
 */
function watchWorker(): void {
    if (watchdog !== null) return;
    const armedAt = Date.now();
    watchdog = window.setInterval(() => {
        if (mode === "worker" && subscribers.size && Date.now() - Math.max(lastTick, armedAt) > WORKER_SILENT_MS) useMainThread();
    }, 1_000);
}

function boot(): void {
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

export function subscribe(tick: Tick): () => void {
    boot();
    const wasIdle = subscribers.size === 0;
    subscribers.add(tick);
    if (wasIdle) {
        if (mode === "worker" && worker) {
            worker.postMessage("start");
            watchWorker();
        } else {
            startMainTimer();
        }
    }
    return () => {
        if (!subscribers.delete(tick) || subscribers.size > 0) return;
        // Nothing is listening: no timer runs on either thread until something does.
        stopTimers();
        if (worker) worker.postMessage("stop");
    };
}

export function disposeClock(): void {
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
