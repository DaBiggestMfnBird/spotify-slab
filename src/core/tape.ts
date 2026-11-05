/**
 * Tape: what the record is played through, laid over whatever mood is on. A room for the
 * reverb to live in, a worn cassette's wow and hiss, a played record's crackle, a cheap
 * sampler's crunch. It stays on over every mood until it's turned off, and Mine keeps it.
 */

import type { TapeState } from "../types";
import type { DspParams } from "./dsp";

export interface Room {
    /** The helper's reverb preset. */
    id: string;
    name: string;
    /** The least reverb it brings, so picking a room on a dry mood is heard. */
    wet: number;
}

/** Smallest to biggest, the order the Room pad steps through them. */
export const ROOMS: Room[] = [
    { id: "smallRoom", name: "Small room", wet: 18 },
    { id: "plate", name: "Plate", wet: 22 },
    { id: "mediumChamber", name: "Chamber", wet: 24 },
    { id: "largeHall", name: "Hall", wet: 28 },
    { id: "cathedral", name: "Cathedral", wet: 32 },
];

export const CLEAN_TAPE: TapeState = { room: null, wow: false, hiss: false, crackle: false, crush: false };

export type TapeLayer = "wow" | "hiss" | "crackle" | "crush";

/** The mood's settings as played through the tape. */
export function withTape(dsp: DspParams, tape: TapeState): DspParams {
    const room = ROOMS.find((r) => r.id === tape.room);
    return {
        ...dsp,
        reverbPreset: room ? room.id : dsp.reverbPreset,
        reverb: room ? Math.max(dsp.reverb, room.wet) : dsp.reverb,
        wow: tape.wow ? 1 : dsp.wow,
        hiss: tape.hiss ? 1 : dsp.hiss,
        crackle: tape.crackle ? 1 : dsp.crackle,
        crush: tape.crush ? 1 : dsp.crush,
    };
}

/** The next room up, and after the biggest, back to the mood's own. */
export function nextRoom(id: string | null): string | null {
    const index = ROOMS.findIndex((room) => room.id === id);
    if (index < 0) return ROOMS[0].id;
    return index + 1 < ROOMS.length ? ROOMS[index + 1].id : null;
}

export function roomName(id: string | null): string {
    return ROOMS.find((room) => room.id === id)?.name ?? "The mood's";
}

export function isClean(tape: TapeState): boolean {
    return !tape.room && !tape.wow && !tape.hiss && !tape.crackle && !tape.crush;
}

/** A tape as stored, or clean if it doesn't hold together. */
export function readTape(raw: unknown): TapeState {
    if (!raw || typeof raw !== "object") return { ...CLEAN_TAPE };
    const tape = raw as Partial<TapeState>;
    return {
        room: typeof tape.room === "string" && ROOMS.some((room) => room.id === tape.room) ? tape.room : null,
        wow: tape.wow === true,
        hiss: tape.hiss === true,
        crackle: tape.crackle === true,
        crush: tape.crush === true,
    };
}
