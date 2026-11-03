/**
 * Moods are two things at once: an EQ curve the native player can actually
 * apply, and a set of real DSP parameters for the optional companion helper.
 *
 * The EQ half always works. The DSP half needs SLAB DSP (macOS) because
 * Spotify refuses playback-speed changes for music and never exposes the
 * decoded samples to extensions.
 *
 * What the DSP half does NOT do is change tempo. Live audio can't be slowed
 * without either dropping samples or drifting forever, so SLAB shifts pitch
 * (the audible half of a screw tape) and leaves the tempo honest.
 */

import type { DspParams } from "./dsp";

export const BANDS = [60, 150, 400, 1000, 2400, 15000] as const;

export interface Mood {
    id: string;
    name: string;
    sub: string;
    /** dB per band, same order as BANDS. */
    gains: number[];
    /** Parameters for the companion helper. */
    dsp: DspParams;
    /** Shown in the README, not the panel. */
    note: string;
}

const dry: DspParams = {
    pitch: 0,
    reverb: 0,
    reverbPreset: "largeHall2",
    delayTime: 0.36,
    delayFeedback: 0,
    delayMix: 0,
    lowpass: 20_000,
    gain: 0,
};

export const MOODS: Mood[] = [
    {
        id: "slowed",
        name: "Slowed + Reverb",
        sub: "tape drowned in the room",
        gains: [3.5, 2.0, 0.8, -0.6, -2.6, -4.2],
        dsp: { ...dry, pitch: -320, reverb: 34, reverbPreset: "largeHall2", lowpass: 11_000 },
        note: "The highs come off first when a record is dragged. Presence drops, the low-mids swell, the top turns to air, and the helper adds the room.",
    },
    {
        id: "screwed",
        name: "Screwed",
        sub: "gray-tape low end, top rolled off",
        gains: [5.0, 3.2, 0.4, -1.2, -3.0, -6.0],
        dsp: { ...dry, pitch: -560, reverb: 16, reverbPreset: "largeRoom", lowpass: 8_000 },
        note: "Screw mixed for a trunk. Sub and low-mid pushed hard, everything above 2k pulled back so the 808 owns the room.",
    },
    {
        id: "chopped",
        name: "Chopped",
        sub: "dry, bright, cuts",
        gains: [2.2, 1.0, -0.2, 1.4, 3.0, 1.2],
        dsp: { ...dry, reverbPreset: "smallRoom" },
        note: "Chopped records stay dry and forward. The cut has to land, so the presence band comes up instead of down.",
    },
    {
        id: "memphis",
        name: "Memphis Tape",
        sub: "midrange honk, hiss on top",
        gains: [1.4, 0.8, 3.0, 2.2, -1.0, -5.0],
        dsp: { ...dry, pitch: -160, reverb: 10, reverbPreset: "plate", lowpass: 6_500 },
        note: "Cassette dub: 400-1k pushed until it honks, top rolled off, bottom kept loose.",
    },
    {
        id: "sped",
        name: "Sped Up",
        sub: "nightcore bright, thin low end",
        gains: [-1.2, -0.2, -0.6, 1.0, 2.4, 3.6],
        dsp: { ...dry, pitch: 400 },
        note: "The other direction. Low end leans out, presence and air come up, the whole thing gets lighter.",
    },
    {
        id: "flat",
        name: "Flat",
        sub: "back to your own curve",
        gains: [0, 0, 0, 0, 0, 0],
        dsp: { ...dry },
        note: "Returns every filter to the gains it had when SLAB loaded, and the helper to dry.",
    },
];

export function moodById(id: string): Mood {
    return MOODS.find((mood) => mood.id === id) ?? MOODS[MOODS.length - 1];
}

/**
 * Log-spaced x positions so the little curve in each button looks like the EQ
 * it represents instead of six evenly spaced dots.
 */
export function curvePath(gains: number[], width = 62, height = 18): string {
    const min = Math.log(BANDS[0]);
    const max = Math.log(BANDS[BANDS.length - 1]);
    const mid = height / 2;
    const span = mid - 1.5;
    // The panel is small; ±6 dB fills the strip, ±12 would flatten every curve.
    const ceiling = 6.5;
    const points = gains.map((gain, index) => {
        const x = ((Math.log(BANDS[index]) - min) / (max - min)) * width;
        const value = Math.max(-ceiling, Math.min(ceiling, gain));
        const y = mid - (value / ceiling) * span;
        return [x, y] as const;
    });
    return points
        .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
        .join(" ");
}
