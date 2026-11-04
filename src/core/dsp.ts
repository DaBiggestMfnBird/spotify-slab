/**
 * Bridge to the optional SLAB DSP helper (macOS).
 *
 * Spotify's player refuses playback-speed changes for music
 * (`not_supported_by_content_type`), and the music stream is DRM-protected, so
 * an extension cannot touch the samples. The helper taps Spotify's audio at the
 * OS level, runs it through a real DSP chain, and exposes a tiny local HTTP API.
 *
 * Everything here degrades to "not linked" — the panel keeps working with the
 * native EQ alone.
 */

export const DSP_ORIGIN = "http://127.0.0.1:47832";

export interface DspParams {
    /** Pitch shift in cents. */
    pitch: number;
    /** Reverb wet/dry 0–100. */
    reverb: number;
    reverbPreset: string;
    delayTime: number;
    delayFeedback: number;
    delayMix: number;
    /** Low-pass cutoff in Hz; 20000 = bypass. */
    lowpass: number;
    gain: number;
}

export interface DspStatus {
    /** At least one probe has come back, so `linked` is an answer, not a guess. */
    checked: boolean;
    /** The helper answered. It may still have nothing to process. */
    linked: boolean;
    /** Attached to Spotify's audio process. */
    tapping?: boolean;
    /** Audio is actually arriving through the tap. */
    audio?: boolean;
    version?: string;
    sampleRate?: number;
    latencyMs?: number;
    params?: Partial<DspParams>;
}

let status: DspStatus = { checked: false, linked: false };
let lastProbe = 0;
let misses = 0;
const listeners = new Set<(status: DspStatus) => void>();

/** Linked: every 4 s. Absent: the same for the first few tries, then every 30 s. */
const PROBE_LINKED_MS = 4_000;
const PROBE_ABSENT_MS = 30_000;
const PROBE_FAST_TRIES = 3;

export function onDspChange(listener: (status: DspStatus) => void): () => void {
    listeners.add(listener);
    listener(status);
    return () => listeners.delete(listener);
}

export function dspStatus(): DspStatus {
    return status;
}

function publish(next: DspStatus): void {
    const changed =
        next.checked !== status.checked ||
        next.linked !== status.linked ||
        next.version !== status.version ||
        next.tapping !== status.tapping ||
        next.audio !== status.audio;
    status = next;
    if (changed) for (const listener of listeners) listener(status);
}

async function request(path: string, init?: RequestInit, timeout = 700): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(`${DSP_ORIGIN}${path}`, {
            ...init,
            signal: controller.signal,
            cache: "no-store",
        });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Cheap liveness check, cached so the panel can poll freely. With no helper
 * installed (every Windows and Linux client) it backs off, so the console isn't
 * filled with refused connections; opening the panel forces a fresh look.
 */
export async function probeDsp(force = false, eager = false): Promise<DspStatus> {
    const now = Date.now();
    // Someone looking at the panel may have just started the helper: keep looking quickly while it's open.
    const every = status.linked || eager || misses < PROBE_FAST_TRIES ? PROBE_LINKED_MS : PROBE_ABSENT_MS;
    if (!force && now - lastProbe < every) return status;
    lastProbe = now;

    const payload = (await request("/status")) as
        | {
              ok?: boolean;
              version?: string;
              tapping?: boolean;
              audio?: boolean;
              sampleRate?: number;
              latencyMs?: number;
              params?: Partial<DspParams>;
          }
        | null;

    if (payload?.ok) {
        misses = 0;
        publish({
            checked: true,
            linked: true,
            // Helpers before 0.3.0 don't report these and only ran while tapping.
            tapping: payload.tapping !== false,
            audio: payload.audio !== false,
            version: payload.version,
            sampleRate: payload.sampleRate,
            latencyMs: payload.latencyMs,
            params: payload.params,
        });
    } else {
        misses += 1;
        publish({ checked: true, linked: false });
    }
    return status;
}

let pending: Partial<DspParams> | null = null;
let waiting: ((sent: boolean) => void)[] = [];
let draining = false;

/**
 * One request in flight at a time, and only the newest values wait behind it.
 * A drag fires dozens of changes; sent side by side they could land out of
 * order and leave the helper on an older pitch than the panel shows.
 */
export function sendDsp(params: Partial<DspParams>): Promise<boolean> {
    pending = { ...pending, ...params };
    const result = new Promise<boolean>((resolve) => waiting.push(resolve));
    if (!draining) void drain();
    return result;
}

async function drain(): Promise<void> {
    draining = true;
    try {
        while (pending) {
            const body = pending;
            const settle = waiting;
            pending = null;
            waiting = [];
            const payload = await request("/params", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (payload) {
                misses = 0;
                publish({ ...status, checked: true, linked: true, params: { ...status.params, ...body } });
            } else {
                // One slow or dropped POST isn't a dead helper: don't disable the slider
                // mid-drag on it. Ask /status straight away and let that decide.
                void probeDsp(true);
            }
            for (const resolve of settle) resolve(Boolean(payload));
        }
    } finally {
        draining = false;
    }
}

/** Real tape-stop: the helper ramps its time-stretcher down and back up. */
export async function dspTapeStop(): Promise<boolean> {
    const payload = await request("/tapstop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ downMs: 380, holdMs: 70, upMs: 240 }),
    });
    return Boolean(payload);
}


