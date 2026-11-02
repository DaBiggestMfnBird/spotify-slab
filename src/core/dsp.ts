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
    linked: boolean;
    version?: string;
    sampleRate?: number;
    latencyMs?: number;
    params?: Partial<DspParams>;
}

let status: DspStatus = { linked: false };
let lastProbe = 0;
const listeners = new Set<(status: DspStatus) => void>();

export function onDspChange(listener: (status: DspStatus) => void): () => void {
    listeners.add(listener);
    listener(status);
    return () => listeners.delete(listener);
}

export function dspStatus(): DspStatus {
    return status;
}

function publish(next: DspStatus): void {
    const changed = next.linked !== status.linked || next.version !== status.version;
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

/** Cheap liveness check. Cached for a few seconds so the panel can poll freely. */
export async function probeDsp(force = false): Promise<DspStatus> {
    const now = Date.now();
    if (!force && now - lastProbe < 4000) return status;
    lastProbe = now;

    const payload = (await request("/status")) as
        | { ok?: boolean; version?: string; sampleRate?: number; latencyMs?: number; params?: Partial<DspParams> }
        | null;

    if (payload?.ok) {
        publish({
            linked: true,
            version: payload.version,
            sampleRate: payload.sampleRate,
            latencyMs: payload.latencyMs,
            params: payload.params,
        });
    } else {
        publish({ linked: false });
    }
    return status;
}

export async function sendDsp(params: Partial<DspParams>): Promise<boolean> {
    const payload = await request("/params", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
    });
    if (!payload) {
        publish({ linked: false });
        return false;
    }
    publish({ ...status, linked: true, params: { ...status.params, ...params } });
    return true;
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

export async function resetDsp(): Promise<boolean> {
    return (await request("/reset", { method: "POST" })) !== null;
}
