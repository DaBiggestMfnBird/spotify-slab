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
    /** Tape, each 0–1: the speed wandering, a cassette's hiss, a record's crackle, a sampler's crunch. */
    wow: number;
    hiss: number;
    crackle: number;
    crush: number;
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
    /** The helper can jump inside its own memory of the record (0.4.0 on): chops land at once. */
    jump?: boolean;
    /** It can spin the record back into a chop (0.5.0 on). */
    spin?: boolean;
    /** It can hold a pad on top of the mood and ramp it (0.5.0 on). */
    hold?: boolean;
    /** It plays the record through tape: wow, hiss, crackle, crush (0.6.0 on). */
    tape?: boolean;
    /** Its echo is a send, so a thrown echo rings out after the pad is let go (0.6.0 on). */
    throw?: boolean;
    /** What Spotify's seeks have lately cost, as the helper measured them: the typical one. */
    seekGapMs?: number;
    /** And the slow end of them (0.6.2 on), which SLAB aims by. */
    seekGapHighMs?: number;
    /** Jumps the helper gave up on (Spotify never came back) and went live from, since it started. */
    wentLive?: number;
}

let status: DspStatus = { checked: false, linked: false };
let lastProbe = 0;
let misses = 0;
/** Each probe's number: when probes overlap, only the newest one's answer is published. */
let probeSeq = 0;
/** Bumped by every accepted POST, so a probe that started before it can't put older params back. */
let paramsSeq = 0;
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
        next.audio !== status.audio ||
        next.jump !== status.jump ||
        next.spin !== status.spin ||
        next.hold !== status.hold ||
        next.tape !== status.tape;
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
    const seq = ++probeSeq;
    const paramsAtStart = paramsSeq;

    const payload = (await request("/status")) as
        | {
              ok?: boolean;
              version?: string;
              tapping?: boolean;
              audio?: boolean;
              sampleRate?: number;
              latencyMs?: number;
              params?: Partial<DspParams>;
              features?: unknown;
              seekGapMs?: number;
              seekGapHighMs?: number;
              chops?: { wentLive?: number };
          }
        | null;

    // A newer probe started while this one was out; its answer is the one that counts.
    if (seq !== probeSeq) return status;
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
            // Params the helper accepted after this probe went out are newer than what it reported.
            params: paramsSeq === paramsAtStart ? payload.params : status.params,
            jump: Array.isArray(payload.features) && payload.features.includes("jump"),
            spin: Array.isArray(payload.features) && payload.features.includes("spin"),
            hold: Array.isArray(payload.features) && payload.features.includes("hold"),
            tape: Array.isArray(payload.features) && payload.features.includes("tape"),
            throw: Array.isArray(payload.features) && payload.features.includes("throw"),
            seekGapMs: typeof payload.seekGapMs === "number" ? payload.seekGapMs : undefined,
            seekGapHighMs: typeof payload.seekGapHighMs === "number" ? payload.seekGapHighMs : undefined,
            wentLive: typeof payload.chops?.wentLive === "number" ? payload.chops.wentLive : undefined,
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
                paramsSeq += 1;
                // The helper answers with what it applied; an older one that doesn't is taken at its word.
                const applied = (payload as { params?: Partial<DspParams> }).params;
                publish({ ...status, checked: true, linked: true, params: { ...status.params, ...body, ...applied } });
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
/** True only when the helper ramped the audio; it answers 503 when it has nothing tapped. */
export async function dspTapeStop(): Promise<boolean> {
    const payload = await request(
        "/tapstop",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ downMs: 380, holdMs: 70, upMs: 240 }),
        },
        // On loopback the answer is near-instant; don't hold the stop up waiting on a stuck helper.
        300,
    );
    return Boolean(payload);
}

/** Before the helper has measured one: about what a seek costs Spotify on a Mac. */
const DEFAULT_SEEK_GAP_MS = 250;
/**
 * Spotify is aimed this far past what its slow seeks cost. Back early, the helper plays memory up
 * to it and crosses over unheard, then catches up a touch fast, pitch held; back late, it has to
 * repeat a moment, which is heard. So it aims for the slow ones.
 */
const SEEK_MARGIN_MS = 60;

/** A helper that can jump in its own memory, with Spotify's audio coming through it now. */
export function canJump(): boolean {
    return status.linked && status.tapping === true && status.audio === true && status.jump === true;
}

/** How far past a jump to send Spotify, so its audio comes back ahead of what the helper plays. */
export function seekAheadMs(): number {
    const gap = status.seekGapHighMs ?? status.seekGapMs ?? DEFAULT_SEEK_GAP_MS;
    return Math.round(Math.max(60, Math.min(900, gap + SEEK_MARGIN_MS)));
}

export interface JumpOrder {
    /** How far back from what is heard when it fires, in ms; negative jumps forward. */
    backMs: number;
    /** When it fires, from now. */
    inMs?: number;
    /** How far past the jump target SLAB is about to send Spotify. */
    seekAheadMs: number;
    /** How much song has played unbroken behind what is heard: the helper never jumps further back. */
    availableMs: number;
}

let measureTimer: number | null = null;

/**
 * Asks the helper to jump. True when it took the order; false (no helper, an older one, or not
 * that much record in its memory) means SLAB seeks Spotify the plain way.
 */
export async function dspJump(order: JumpOrder): Promise<boolean> {
    if (!canJump()) return false;
    const payload = (await request(
        "/jump",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(order),
        },
        250,
    )) as { ok?: boolean } | null;
    const ok = payload?.ok === true;
    if (ok) {
        // What this seek cost, or that the helper gave up waiting for it (after 2 s), shows up in
        // its status: look once both are known, and aim the next seek by it.
        if (measureTimer !== null) window.clearTimeout(measureTimer);
        measureTimer = window.setTimeout(() => {
            measureTimer = null;
            void probeDsp(true);
        }, 2_600 + (order.inMs ?? 0));
    }
    return ok;
}

/**
 * A new track or a pause: a jump still to come is called off, and one waiting on Spotify's
 * audio, which is now never coming, goes back to live at once.
 */
export async function dspCancelJump(): Promise<void> {
    if (!status.linked || !status.jump) return;
    await request("/jump/cancel", { method: "POST" }, 250);
}

/** A helper that can spin the record back into a chop. */
export function canSpin(): boolean {
    return canJump() && status.spin === true;
}

export interface SpinOrder {
    /** How far back from where the spin begins it lands, in ms. */
    backMs: number;
    /** How long it spins: it lands this long from now. */
    spinMs: number;
    seekAheadMs: number;
    availableMs: number;
}

/** Asks the helper for a backspin into a chop. True when it took it. */
export async function dspSpin(order: SpinOrder): Promise<boolean> {
    if (!canSpin()) return false;
    const payload = (await request(
        "/spin",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) },
        250,
    )) as { ok?: boolean } | null;
    const ok = payload?.ok === true;
    if (ok) {
        if (measureTimer !== null) window.clearTimeout(measureTimer);
        measureTimer = window.setTimeout(() => {
            measureTimer = null;
            void probeDsp(true);
        }, 2_600 + order.spinMs);
    }
    return ok;
}

/** A helper that plays the record through tape, with Spotify's audio coming through it now. */
export function canTape(): boolean {
    return status.linked && status.tapping === true && status.audio === true && status.tape === true;
}

/** A helper that can hold a pad on top of the mood, with Spotify's audio coming through it now. */
export function canHold(): boolean {
    return status.linked && status.tapping === true && status.audio === true && status.hold === true;
}

/** What is held on top of the mood; what is left out is let go. */
export interface HoldOverlay {
    /** Added to the mood's pitch, in cents. */
    pitchOffset?: number;
    /** The low-pass can't open past this, in Hz. */
    lowpassCap?: number;
    /** Added to the output trim, in dB. */
    gainBoost?: number;
    echoMix?: number;
    echoFeedback?: number;
    /** Seconds. */
    echoTime?: number;
}

let holdChain: Promise<unknown> = Promise.resolve();

/**
 * Sets what is held, ramped over `ms`. Sent in order, one after another, so a quick press and
 * release can't land back to front and leave a pad held.
 */
export function dspHold(overlay: HoldOverlay, ms: number): Promise<boolean> {
    const body = JSON.stringify({ ...overlay, ms: Math.round(ms) });
    const sent = holdChain.then(() =>
        request("/hold", { method: "POST", headers: { "Content-Type": "application/json" }, body }, 400),
    );
    holdChain = sent.catch(() => null);
    return sent.then((payload) => (payload as { ok?: boolean } | null)?.ok === true);
}

