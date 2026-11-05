/**
 * Spotify's own synced lyrics, for running a line back.
 *
 * The client fetches them for its lyrics view; SLAB asks for the same thing once
 * per track and only uses them when they're synced line by line. A track without
 * them, or a client that won't hand them over, gets a bar chop instead.
 */

export interface LyricLine {
    /** Where the line starts, ms into the track. */
    startMs: number;
    words: string;
}

/** A line that began less than this ago was barely heard: the one before it is the one meant. */
const JUST_BEGUN_MS = 450;
/** Keep the lines of the last few tracks, not of every track ever played. */
const CACHE_LIMIT = 24;

const cache = new Map<string, LyricLine[] | null>();
const inflight = new Map<string, Promise<LyricLine[] | null>>();

function remember(uri: string, lines: LyricLine[] | null): void {
    cache.delete(uri);
    cache.set(uri, lines);
    while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

function currentUri(): string | null {
    return Spicetify.Player.data?.item?.uri ?? null;
}

interface ColorLyrics {
    lyrics?: {
        syncType?: string;
        lines?: { startTimeMs?: string | number; words?: string }[];
    };
}

/** The track's lines, synced, or null when it has none SLAB can use. Fetched once per track. */
export async function loadLines(uri?: string): Promise<LyricLine[] | null> {
    const target = uri ?? currentUri();
    if (!target) return null;
    if (cache.has(target)) {
        const cached = cache.get(target) ?? null;
        remember(target, cached);
        return cached;
    }
    const running = inflight.get(target);
    if (running) return running;

    const id = /^spotify:track:([A-Za-z0-9]+)$/.exec(target)?.[1];
    const cosmos = Spicetify.CosmosAsync;
    if (!id || !cosmos) {
        remember(target, null);
        return null;
    }
    const request = (async (): Promise<LyricLine[] | null> => {
        try {
            const body = (await cosmos.get(
                `https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&vocalRemoval=false&market=from_token`,
            )) as ColorLyrics | null;
            const lyrics = body?.lyrics;
            if (lyrics?.syncType !== "LINE_SYNCED" || !Array.isArray(lyrics.lines)) {
                remember(target, null);
                return null;
            }
            const lines = lyrics.lines
                .map((line) => ({ startMs: Number(line.startTimeMs), words: String(line.words ?? "").trim() }))
                // The client marks a stretch with no singing with a note: that is no line to run back.
                .filter((line) => Number.isFinite(line.startMs) && line.words !== "" && line.words !== "♪")
                .sort((a, b) => a.startMs - b.startMs);
            const result = lines.length >= 2 ? lines : null;
            remember(target, result);
            return result;
        } catch {
            // No lyrics for this one, or none for this client: a bar it is, for the rest of the track.
            remember(target, null);
            return null;
        } finally {
            inflight.delete(target);
        }
    })();
    inflight.set(target, request);
    return request;
}

/** The line just heard at `ms`: the one under it, or the one before if this one has barely begun. */
export function lineJustHeard(lines: LyricLine[], ms: number): LyricLine | null {
    let index = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startMs > ms) break;
        index = i;
    }
    if (index < 0) return null;
    if (ms - lines[index].startMs < JUST_BEGUN_MS && index > 0) index -= 1;
    return lines[index];
}
