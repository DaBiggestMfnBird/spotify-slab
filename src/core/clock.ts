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

let fallback: number | null = null;
/** When the worker last ticked; a worker that never does (blocked by policy) hands over to the main thread. */
let lastTick = 0;

function tickAll(now: number): void {
    for (const tick of subscribers) {
        try {
            tick(now);
        } catch {
            /* one bad subscriber shouldn't stop the clock */
        }
    }
}

/** No worker (a locked-down client): a main-thread timer is slower when hidden, but it ticks. */
function useMainThread(): void {
    if (fallback !== null) return;
    if (worker) {
        worker.terminate();
        worker = null;
    }
    if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
    }
    fallback = window.setInterval(() => {
        if (subscribers.size) tickAll(Date.now());
    }, 40);
}

/** A worker that starts but never ticks is as good as none: a stop would never pause and a loop never jump. */
function watch(): void {
    const armedAt = Date.now();
    window.setTimeout(() => {
        if (worker && subscribers.size && lastTick < armedAt) useMainThread();
    }, 1_000);
}

function boot(): void {
    if (worker || fallback !== null) return;
    try {
        objectUrl = URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" }));
        worker = new Worker(objectUrl);
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
    if (wasIdle && worker) {
        worker.postMessage("start");
        watch();
    }
    return () => {
        subscribers.delete(tick);
        if (subscribers.size === 0 && worker) worker.postMessage("stop");
    };
}

export function disposeClock(): void {
    subscribers.clear();
    if (fallback !== null) window.clearInterval(fallback);
    fallback = null;
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
