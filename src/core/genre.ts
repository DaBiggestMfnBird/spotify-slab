/**
 * What kind of record it is, so DJ mode plays it the way that music gets played:
 * the artist's genres from Spotify, read once per artist. Without them, the tempo
 * decides.
 */

export type StyleId = "houston" | "trap" | "rap" | "slowjam" | "band" | "dance" | "pop";

export const STYLE_NAMES: Record<StyleId, string> = {
    houston: "Houston",
    trap: "trap",
    rap: "rap",
    slowjam: "slow jam",
    band: "band",
    dance: "dance",
    pop: "pop",
};

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

const cache = new Map<string, string[]>();
const inflight = new Map<string, Promise<string[]>>();

/** An artist's genres, as Spotify files them; empty when it won't say. */
export async function artistGenres(artistUri: string): Promise<string[]> {
    const cached = cache.get(artistUri);
    if (cached) return cached;
    const running = inflight.get(artistUri);
    if (running) return running;
    const id = /^spotify:artist:([A-Za-z0-9]+)$/.exec(artistUri)?.[1];
    const cosmos = Spicetify.CosmosAsync;
    if (!id || !cosmos) return [];
    const request = (async () => {
        try {
            const body = (await cosmos.get(`https://api.spotify.com/v1/artists/${id}`)) as { genres?: unknown } | null;
            const genres = Array.isArray(body?.genres) ? body.genres.filter((g): g is string => typeof g === "string") : [];
            cache.set(artistUri, genres);
            return genres;
        } catch {
            cache.set(artistUri, []);
            return [];
        } finally {
            inflight.delete(artistUri);
        }
    })();
    inflight.set(artistUri, request);
    return request;
}

/** The style for a record: by its artist's genres, or with none, by its tempo. */
export function styleFor(genres: string[], tempo: number): StyleId {
    const all = genres.join(" | ").toLowerCase();
    for (const [style, pattern] of MATCHES) if (pattern.test(all)) return style;
    if (tempo > 0 && tempo < 85) return "slowjam";
    if (tempo >= 130 && tempo <= 165) return "trap";
    if (tempo >= 118 && tempo < 130) return "dance";
    return "rap";
}
