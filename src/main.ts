import { disposeChops } from "./core/chops";
import { disposeClock } from "./core/clock";
import { eqAvailable, initEq } from "./core/eq";
import { loadState } from "./core/state";
import { Deck } from "./ui/deck";

const VERSION = "0.10.1";
const LOG = "[SLAB]";

interface BootClaim {
    version: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(predicate: () => T | null | undefined, timeout = 20000): Promise<T | null> {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        try {
            const value = predicate();
            if (value) return value;
        } catch {
            /* not ready yet */
        }
        await sleep(120);
    }
    return null;
}

/** True when dotted version `a` is strictly newer than `b`. */
function isNewer(a: string, b: string): boolean {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const difference = (left[i] ?? 0) - (right[i] ?? 0);
        if (difference !== 0) return difference > 0;
    }
    return false;
}

/** A copy that gives up hands the claim back, so a later copy of the same version can still load. */
function release(claim: BootClaim): void {
    if (window.__slabClaim === claim) window.__slabClaim = undefined;
}

async function boot(claim: BootClaim): Promise<void> {
    const player = await waitFor(() =>
        typeof Spicetify !== "undefined" && Spicetify.Player ? Spicetify.Player : null,
    );
    if (!player) {
        console.warn(LOG, "player never appeared, giving up");
        release(claim);
        return;
    }

    const eqApi = await waitFor(() => Spicetify.Platform.EqualizerAPI ?? null, 10000);
    const eqReady = eqApi ? await initEq() : false;
    if (!eqReady) console.warn(LOG, "equalizer unavailable, moods will be inert");

    // Another copy loaded while this one was waiting on the player.
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
            /* ignore */
        }
        deck.destroy();
        disposeChops();
        disposeClock();
        if (window.SLAB) window.SLAB = undefined;
    };

    window.SLAB = {
        version: VERSION,
        deck,
        state,
        eq: eqAvailable(),
        open: () => deck.open(),
        close: () => deck.close(),
        toggle: () => deck.toggle(),
        destroy,
    };

    console.info(LOG, `v${VERSION} ready, eq=${eqReady ? "on" : "off"}`);
}

// The same extension can load twice: once from the local Extensions folder and
// once from the Marketplace's CDN copy. A newer build takes over from an older
// one; an older or identical copy stands down, so a stale CDN copy of the same
// version can't silently replace the one already running. (scripts/dev-inject
// clears the claim first, so a hot reload always lands.)
const running = window.SLAB as { version?: string; destroy?: () => void } | undefined;
const claimed = window.__slabClaim as BootClaim | undefined;
const rival = running?.version ?? claimed?.version;

if (rival && !isNewer(VERSION, rival)) {
    console.info(LOG, `v${VERSION} standing down, v${rival} is already loaded`);
} else {
    const claim: BootClaim = { version: VERSION };
    window.__slabClaim = claim;
    try {
        running?.destroy?.();
    } catch {
        /* ignore */
    }
    void boot(claim).catch((error) => {
        release(claim);
        console.error(LOG, "boot failed", error);
    });
}
