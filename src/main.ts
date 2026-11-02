import { disposeChops } from "./core/chops";
import { disposeClock } from "./core/clock";
import { eqAvailable, initEq } from "./core/eq";
import { loadState } from "./core/state";
import { Deck } from "./ui/deck";

const VERSION = "0.2.0";
const LOG = "[SLAB]";

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

async function boot(): Promise<void> {
    const player = await waitFor(() =>
        typeof Spicetify !== "undefined" && Spicetify.Player ? Spicetify.Player : null,
    );
    if (!player) {
        console.warn(LOG, "player never appeared, giving up");
        return;
    }

    const eqApi = await waitFor(() => Spicetify.Platform.EqualizerAPI ?? null, 10000);
    const eqReady = eqApi ? await initEq() : false;
    if (!eqReady) console.warn(LOG, "equalizer unavailable — moods will be inert");

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

    console.info(LOG, `v${VERSION} ready · eq=${eqReady ? "on" : "off"}`);
}

try {
    const previous = window.SLAB as { destroy?: () => void } | undefined;
    if (previous?.destroy) previous.destroy();
} catch {
    /* ignore */
}

void boot().catch((error) => console.error(LOG, "boot failed", error));
