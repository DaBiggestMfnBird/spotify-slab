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

function boot(): void {
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
                    /* one bad subscriber shouldn't stop the clock */
                }
            }
        };
        worker.postMessage("start");
    } catch {
        worker = null;
    }
}

export function subscribe(tick: Tick): () => void {
    boot();
    const wasIdle = subscribers.size === 0;
    subscribers.add(tick);
    if (wasIdle && worker) worker.postMessage("start");
    return () => {
        subscribers.delete(tick);
        if (subscribers.size === 0 && worker) worker.postMessage("stop");
    };
}

export function disposeClock(): void {
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
