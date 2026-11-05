/**
 * What kind of record it is, so DJ mode plays it the way that music gets played. In order:
 * the kind you picked for the artist; the artist's genres from Spotify; how the track sounds
 * (rapped or sung, loud or soft, made to dance to or not); and last, its tempo.
 *
 * Spotify has marked artist genres deprecated and leaves more of them empty every year, so
 * none of this leans on them alone. What it does get is kept, and what you pick is kept too.
 */

export type StyleId = "houston" | "trap" | "rap" | "slowjam" | "band" | "dance" | "pop";

export const STYLES: readonly StyleId[] = ["houston", "trap", "rap", "slowjam", "band", "dance", "pop"];

export const STYLE_NAMES: Record<StyleId, string> = {
    houston: "Houston",
    trap: "trap",
    rap: "rap",
    slowjam: "slow jam",
    band: "band",
    dance: "dance",
    pop: "pop",
};

/** Where a reading came from. */
export type StyleSource = "picked" | "genres" | "sound" | "tempo";

export interface StyleReading {
    style: StyleId;
    by: StyleSource;
}

/** Most particular first: a Houston rapper is also tagged rap, and an R&B singer pop. */
const MATCHES: [StyleId, RegExp][] = [
    ["houston", /houston|screw|chopped|texas|dirty south|southern hip hop|memphis/],
    ["trap", /trap|drill|plugg|rage|crunk/],
    ["slowjam", /r&b|rnb|soul|quiet storm|slow jam|funk|motown/],
    ["rap", /hip hop|rap|gangster|g funk|boom bap/],
    ["dance", /house|techno|edm|electro|dance|dubstep|drum and bass|trance|garage/],
    ["band", /rock|metal|punk|indie|grunge|alternative|emo|shoegaze|country|folk/],
    ["pop", /pop/],
];

// ---- Genres ------------------------------------------------------------------------------------

const GENRES_KEY = "slab:genres:v1";
/** Artists remembered, newest first; past this the oldest are let go. */
const GENRES_LIMIT = 500;
/** An artist Spotify had no genres for is asked again after a week. */
const EMPTY_AGAIN_MS = 7 * 24 * 3_600_000;
/** A request that failed is tried again after ten minutes, not before. */
const FAILED_AGAIN_MS = 10 * 60_000;

interface Asked {
    genres: string[];
    at: number;
}

let genres: Record<string, Asked> | null = null;
const failed = new Map<string, number>();
const inflight = new Map<string, Promise<string[]>>();

function genreStore(): Record<string, Asked> {
    if (genres) return genres;
    genres = {};
    try {
        const parsed = JSON.parse(localStorage.getItem(GENRES_KEY) ?? "{}") as Record<string, Partial<Asked>>;
        for (const [uri, asked] of Object.entries(parsed ?? {})) {
            if (Array.isArray(asked?.genres) && typeof asked.at === "number") {
                genres[uri] = { genres: asked.genres.filter((g): g is string => typeof g === "string"), at: asked.at };
            }
        }
    } catch {
        /* a bad store is the same as none */
    }
    return genres;
}

function saveGenres(): void {
    const kept = Object.entries(genreStore()).sort((a, b) => b[1].at - a[1].at).slice(0, GENRES_LIMIT);
    genres = Object.fromEntries(kept);
    try {
        localStorage.setItem(GENRES_KEY, JSON.stringify(genres));
    } catch {
        /* ignore */
    }
}

/**
 * An artist's genres, as Spotify files them; empty when it has none or won't say. Asked once
 * per artist and kept. It goes through the Web API on the client's own session, the way
 * Spicetify's own extensions still make their api.spotify.com requests.
 */
export async function artistGenres(artistUri: string): Promise<string[]> {
    const known = genreStore()[artistUri];
    if (known && (known.genres.length > 0 || Date.now() - known.at < EMPTY_AGAIN_MS)) return known.genres;
    if (Date.now() - (failed.get(artistUri) ?? -Infinity) < FAILED_AGAIN_MS) return known?.genres ?? [];
    const running = inflight.get(artistUri);
    if (running) return running;
    const id = /^spotify:artist:([A-Za-z0-9]+)$/.exec(artistUri)?.[1];
    const cosmos = Spicetify.CosmosAsync;
    if (!id || !cosmos) return [];
    const request = (async () => {
        try {
            const body = (await cosmos.get(`https://api.spotify.com/v1/artists/${id}`)) as { genres?: unknown } | null;
            if (!body || typeof body !== "object") throw new Error("no artist");
            const found = Array.isArray(body.genres) ? body.genres.filter((g): g is string => typeof g === "string") : [];
            genreStore()[artistUri] = { genres: found, at: Date.now() };
            saveGenres();
            failed.delete(artistUri);
            return found;
        } catch {
            // Turned away or rate-limited: try again later, and keep what was known.
            failed.set(artistUri, Date.now());
            return known?.genres ?? [];
        } finally {
            inflight.delete(artistUri);
        }
    })();
    inflight.set(artistUri, request);
    return request;
}

// ---- How it sounds -----------------------------------------------------------------------------

/** What Spotify's audio features say about a track, each 0 to 1, where it says anything. */
export interface Sound {
    speechiness?: number;
    energy?: number;
    acousticness?: number;
    instrumentalness?: number;
    danceability?: number;
}

const sounds = new Map<string, Sound | null>();
const SOUNDS_LIMIT = 64;

function unit(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/**
 * How a track sounds, from the audio-attributes service the beat grid comes from; Spicetify's
 * own lyrics app reads these features for its tempo. Null when it won't say.
 */
export async function trackSound(trackUri: string): Promise<Sound | null> {
    if (sounds.has(trackUri)) return sounds.get(trackUri) ?? null;
    const id = /^spotify:track:([A-Za-z0-9]+)$/.exec(trackUri)?.[1];
    const cosmos = Spicetify.CosmosAsync;
    if (!id || !cosmos) return null;
    let sound: Sound | null = null;
    try {
        const body = (await cosmos.get(
            `https://spclient.wg.spotify.com/audio-attributes/v1/audio-features/${id}?format=json`,
        )) as Record<string, unknown> | null;
        if (body && typeof body === "object") {
            const read: Sound = {
                speechiness: unit(body.speechiness),
                energy: unit(body.energy),
                acousticness: unit(body.acousticness),
                instrumentalness: unit(body.instrumentalness),
                danceability: unit(body.danceability),
            };
            if (Object.values(read).some((value) => value !== undefined)) sound = read;
        }
    } catch {
        /* nothing said is nothing to go on */
    }
    if (sounds.size >= SOUNDS_LIMIT) {
        const oldest = sounds.keys().next().value;
        if (oldest !== undefined) sounds.delete(oldest);
    }
    sounds.set(trackUri, sound);
    return sound;
}

/**
 * The kind of record by how it sounds. Rapped records score 0.15 and up for speech, where sung
 * ones sit well under 0.1; trap is rap at trap's tempo. Null when the features say too little.
 */
export function styleBySound(sound: Sound | null, tempo: number): StyleId | null {
    if (!sound) return null;
    const { speechiness: speech, energy, acousticness: acoustic, instrumentalness: instrumental, danceability: dance } = sound;
    if (speech === undefined && energy === undefined && dance === undefined) return null;
    if (speech !== undefined && speech >= 0.15) return tempo >= 130 && tempo <= 165 ? "trap" : "rap";
    if (instrumental !== undefined && instrumental >= 0.5 && dance !== undefined && dance >= 0.6) return "dance";
    if (energy !== undefined && energy < 0.45 && ((tempo > 0 && tempo < 100) || (acoustic ?? 0) >= 0.5)) return "slowjam";
    if (energy !== undefined && energy >= 0.7 && dance !== undefined && dance < 0.5) return "band";
    if (dance !== undefined && dance >= 0.7 && (energy ?? 0) >= 0.6) return "dance";
    return "pop";
}

// ---- What you picked ---------------------------------------------------------------------------

const PICKS_KEY = "slab:style-picks:v1";
let picks: Record<string, StyleId> | null = null;

function pickStore(): Record<string, StyleId> {
    if (picks) return picks;
    picks = {};
    try {
        const parsed = JSON.parse(localStorage.getItem(PICKS_KEY) ?? "{}") as Record<string, unknown>;
        for (const [uri, style] of Object.entries(parsed ?? {})) {
            if (STYLES.includes(style as StyleId)) picks[uri] = style as StyleId;
        }
    } catch {
        /* a bad store is the same as none */
    }
    return picks;
}

/** The kind of record you picked for an artist, if you did. */
export function pickedStyle(artistUri: string): StyleId | null {
    return pickStore()[artistUri] ?? null;
}

/** Plays an artist as `style` from now on; null goes back to reading it. */
export function pickStyle(artistUri: string, style: StyleId | null): void {
    const store = pickStore();
    if (style) store[artistUri] = style;
    else delete store[artistUri];
    try {
        localStorage.setItem(PICKS_KEY, JSON.stringify(store));
    } catch {
        /* ignore */
    }
}

// ---- Reading it --------------------------------------------------------------------------------

/** By its artist's genres, or by how it sounds, or with neither, by its tempo. */
export function styleFor(genres: string[], tempo: number, sound: Sound | null = null): StyleReading {
    const all = genres.join(" | ").toLowerCase();
    for (const [style, pattern] of MATCHES) if (pattern.test(all)) return { style, by: "genres" };
    const heard = styleBySound(sound, tempo);
    if (heard) return { style: heard, by: "sound" };
    if (tempo > 0 && tempo < 85) return { style: "slowjam", by: "tempo" };
    if (tempo >= 130 && tempo <= 165) return { style: "trap", by: "tempo" };
    if (tempo >= 118 && tempo < 130) return { style: "dance", by: "tempo" };
    return { style: "rap", by: "tempo" };
}
