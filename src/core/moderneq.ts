/**
 * Coexistence with ModernEQ.
 *
 * Both extensions write the same six native EqualizerAPI filters, so only one
 * of them can own the bands. ModernEQ keeps its curve in its own localStorage
 * key; SLAB reads that key only to hand the bands back when the user asks for
 * ModernEQ again. Nothing here imitates ModernEQ's UI.
 */

const STATE_KEY = "moderneq:state";

/** ModernEQ's band centres, in the order its state array stores them. */
const BANDS = [32, 64, 125, 250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 24_000];

/** ModernEQ has saved a curve, or it has already built its menu entry. */
export function modernEqPresent(): boolean {
    try {
        if (localStorage.getItem(STATE_KEY) !== null) return true;
    } catch {
        /* storage blocked — fall through to the DOM check */
    }
    return Boolean(document.querySelector(".meq-menu-item, .meq-overlay"));
}

/** The curve ModernEQ last saved, expressed at its own band centres. */
export function modernEqBands(): { frequency: number; gain: number }[] | null {
    try {
        const raw = localStorage.getItem(STATE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { bands?: unknown };
        if (!Array.isArray(parsed.bands) || parsed.bands.length !== BANDS.length) return null;
        const gains = parsed.bands.map((value) => (typeof value === "number" ? value : 0));
        return BANDS.map((frequency, index) => ({ frequency, gain: gains[index] }));
    } catch {
        return null;
    }
}
