/**
 * A mood kept for an artist: when one of their tracks comes on, SLAB puts it on.
 * UGK always comes on Screwed. Kept on this computer only, the most recent 200.
 */

const KEY = "slab:keep:v1";
const LIMIT = 200;

export interface Kept {
    name: string;
    moodId: string;
    pitch: number;
    at: number;
}

export interface Artist {
    uri: string;
    name: string;
}

let memory: Record<string, Kept> | null = null;

function load(): Record<string, Kept> {
    if (memory) return memory;
    memory = {};
    try {
        const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Partial<Kept>>;
        for (const [uri, kept] of Object.entries(parsed)) {
            if (typeof kept?.moodId === "string" && typeof kept.pitch === "number") {
                memory[uri] = {
                    name: typeof kept.name === "string" ? kept.name : "",
                    moodId: kept.moodId,
                    pitch: kept.pitch,
                    at: typeof kept.at === "number" ? kept.at : 0,
                };
            }
        }
    } catch {
        /* a bad entry is the same as none */
    }
    return memory;
}

function save(): void {
    if (!memory) return;
    const entries = Object.entries(memory).sort((a, b) => b[1].at - a[1].at).slice(0, LIMIT);
    memory = Object.fromEntries(entries);
    try {
        localStorage.setItem(KEY, JSON.stringify(memory));
    } catch {
        /* ignore */
    }
}

/** Whose track this is: the first artist named, which is the one it's filed under. */
export function currentArtist(): Artist | null {
    try {
        const metadata = Spicetify.Player.data?.item?.metadata;
        const uri = metadata?.artist_uri;
        if (!uri || !uri.startsWith("spotify:artist:")) return null;
        return { uri, name: metadata?.artist_name ?? "" };
    } catch {
        return null;
    }
}

export function keptFor(artist: Artist | null): Kept | null {
    if (!artist) return null;
    return load()[artist.uri] ?? null;
}

/** Keeps a mood for an artist, or updates it: keeping follows what you pick while they play. */
export function keep(artist: Artist, moodId: string, pitch: number): void {
    load()[artist.uri] = { name: artist.name, moodId, pitch, at: Date.now() };
    save();
}

export function forget(artist: Artist): void {
    const kept = load();
    if (!(artist.uri in kept)) return;
    delete kept[artist.uri];
    save();
}
