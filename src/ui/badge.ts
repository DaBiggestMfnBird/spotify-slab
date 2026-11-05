/**
 * The deck-lid nameplate: "Slab" as a script, the way 70s and 80s GM
 * luxury cars carried their names on the trunk (Eldorado, Brougham, Caprice
 * Classic), not import-tuner block letters. One monoline stroke slanted like
 * handwriting, a swash off the b running back under the word. It is bent in
 * the same glass as the sign (see Tube): frosted while nothing can be heard,
 * lit gas while the mood plays, so the lid's name is part of the trunk's neon.
 */

const SCRIPT = [
    // S
    "M13.4 4.6C12.4 2.3 7.6 1.5 5.2 3.2C2.6 5 3.5 7.7 7.3 9.3C11.1 10.9 12.6 12.9 11.3 15.5C10 18.1 5.6 18.7 2.4 16.6",
    // l, a, b in one run of the pen
    "M13.8 15.6C16.6 13.6 19.4 8.6 19.9 4.8C20.2 2.4 18.4 1.9 17.8 4.1C17 7.6 16.4 12.6 17 16C17.4 18.3 19.8 18.1 22 16.2" +
        "C23.4 14.9 24.6 11.6 27.4 10.7C25.2 10.1 22.6 11.9 23 14.9C23.4 18.1 27.4 17.6 28.8 14.2L29.6 10.6L28.9 15.6C28.6 17.8 30.6 18.1 32.8 16.4" +
        "C35 14.3 37 8.6 37.4 4.8C37.7 2.4 35.9 1.9 35.3 4.1C34.5 7.6 33.9 12.6 34.4 16C34.8 18.5 38.6 18.6 40.2 15.7C41.3 13.6 40.4 10.8 38.1 10.8C36.7 10.8 35.7 11.7 35.3 12.6",
    // the swash, off the b and back under "lab"
    "M40.2 15.7C44.6 16.6 47 19.6 42.6 21.2C35.2 23.8 23.2 22.8 15.6 20.6",
].join("");

/** The nameplate's box on the deck lid, in pixels. */
export const NAMEPLATE_WIDTH = 58;
export const NAMEPLATE_HEIGHT = 28;

/**
 * The same script bent in neon: the chrome nameplate's centreline, slanted and
 * scaled into the lid's pixels, so the glass follows the letters exactly. The
 * path is only absolute M, C and L, so every pair of numbers is a point.
 */
export function nameplateTubePath(): string {
    const scale = NAMEPLATE_WIDTH / 50;
    const top = (NAMEPLATE_HEIGHT - 24 * scale) / 2;
    const slant = Math.tan((12 * Math.PI) / 180);
    const round = (value: number) => String(Math.round(value * 100) / 100);
    return SCRIPT.replace(/(-?\d*\.?\d+)[ ,](-?\d*\.?\d+)/g, (_match, xs: string, ys: string) => {
        const x = Number(xs), y = Number(ys);
        return `${round((x + 4.4 - slant * y) * scale)} ${round(y * scale + top)}`;
    });
}
