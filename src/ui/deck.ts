import {
    autoBarsAhead,
    cancelLoop,
    chopBars,
    isLooping,
    isStopping,
    loopBars,
    loopRemaining,
    needlePosition,
    onChop,
    resetForTrack,
    runLineBack,
    setAuto,
    spinBack,
    tapeStop,
    watchNeedle,
} from "../core/chops";
import { HANDS, djRunning, djStyleName, djYield, nextDjStyle, onDj, setDjHand, startDj, stopDj } from "../core/dj";
import { canHold, canTape, type DspParams, dspStatus, dspTapeStop, onDspChange, probeDsp, sendDsp } from "../core/dsp";
import { applyCurve, applyCurveAtFrequencies, eqAvailable, restoreBaseline } from "../core/eq";
import {
    barCount,
    barIndexAt,
    barLengthMs,
    barStartMs,
    beatIndexAt,
    beatLengthMs,
    gridFor,
    loadGrid,
} from "../core/grid";
import { type HoldName, onHoldChange, press as pressHold, release as releaseHold, releaseAll } from "../core/holds";
import { type Artist, currentArtist, forget, keep, keptFor } from "../core/keep";
import { loadLines } from "../core/lyrics";
import { modernEqBands, modernEqPresent } from "../core/moderneq";
import { MINE_ID, MOODS, curvePath, mineMood, moodById, setMine } from "../core/moods";
import { SCREW_MAX, SCREW_MIN, clampPitch, saveState } from "../core/state";
import { isMove } from "../core/style";
import type { StyleId } from "../core/genre";
import { CLEAN_TAPE, isClean, nextRoom, roomName, type TapeLayer, withTape } from "../core/tape";
import type { Grid, SlabState } from "../types";
import {
    BIG_WHEEL,
    BIG_WHEEL_BOX,
    CHIP_ICON,
    CLOSE_ICON,
    POKE_X,
    POKE_Y,
    SILL_SCREW_LEFT,
    SILL_SCREW_RIGHT,
    TYRE_RADIUS,
    WHEEL_CONE,
    WHEEL_KNOCKOFF,
    WHEEL_SIZE,
    WHEEL_SPOKES,
    WHEEL_STATIC,
    bigWheelRingPath,
} from "./art";
import { NUMBER_HEIGHT, NUMBER_WIDTH, SIGN_HEIGHT, SIGN_WIDTH, numberLayout, signLayout } from "./neon";
import { CSS, STYLE_ID } from "./styles";
import { Tube } from "./tube";
import { NAMEPLATE_HEIGHT, NAMEPLATE_WIDTH, nameplateTubePath } from "./badge";

type Props = Record<string, unknown>;

const PITCH_LIMIT = 1200;
const EVERY_MIN = 1;
const EVERY_MAX = 16;
const DEVICE_NAME_MAX = 56;
/** The tallest the panel gets, and the least room above the playbar worth opening into. */
const PANEL_MAX_PX = 680;
/** The car's width. A window narrower than this, as when the client is zoomed right in, gets the whole car scaled to fit. */
const PANEL_WIDTH_PX = 400;
const MIN_ROOM_PX = 160;
/** What short mode saves (sign 14, doors 3 x 8, sill 18); keep in step with the data-short rules in styles.ts. */
const SHORT_SAVING_PX = 56;
/** Line height of the dead-sign message; two of these and the sign makes room. Keep in step with styles.ts. */
const DEAD_LINE_PX = 18;
/** After a failed analysis fetch, wait this long before each retry; then stop until the track changes. */
const GRID_RETRY_MS = [5_000, 30_000, 120_000];
/** The sign's height when it shares its bay with two lines of message. */
const COMPACT_SIGN_HEIGHT = 50;

/** One rotation of the spokes at normal pitch. */
const SPIN_MS = 1600;
/** Keep in step with the transition in styles.ts. */
const ROLL_MS = 640;
const TAGLINE = "Slow, loud and bangin’";

/** Full screw: DJ mode's sound, the Screwed mood ridden seven semitones down on a worn tape. */
const DJ_MOOD = "screwed";
const DJ_PITCH = -700;
/** How long the answer to a press holds the readout against what plays on its own. */
const ANSWER_HOLD_MS = 1_500;
/** What the DJ plays a record as, for a sentence. */
const PLAYED_AS: Record<StyleId, string> = {
    houston: "Houston",
    trap: "trap",
    rap: "rap",
    slowjam: "a slow jam",
    band: "a band record",
    dance: "a dance record",
    pop: "pop",
};
const CHIP_TITLE = "SLAB, Third Coast playback moods";

/** Pixels per cent. The track is laid out so 100 cents is exactly 12 px. */
const PX_PER_CENT = 12 / 100;
const RAIL_WIDTH = WHEEL_SIZE + PX_PER_CENT * PITCH_LIMIT * 2;
const RULER_WIDTH = 360;
/** The native thumb is the whole wheel, so grabbing it anywhere drags it instead of jumping. */
const THUMB_SIZE = WHEEL_SIZE;

/** Centre of the wheel at this value, and the x of everything aligned to it. */
function railX(cents: number): number {
    return WHEEL_SIZE / 2 + (cents + PITCH_LIMIT) * PX_PER_CENT;
}

/** The Connect device playing right now, when it isn't this computer. */
function remoteDeviceName(): string | null {
    try {
        const device = Spicetify.Platform.ConnectAPI?.state?.activeDevice;
        return device && device.isLocal === false ? (device.name ?? "another device") : null;
    } catch {
        return null;
    }
}

/** A device can be called anything. Long names are cut at a word and end the sentence themselves. */
function deviceSentence(raw: string, max = DEVICE_NAME_MAX): string {
    const name = raw.trim().replace(/[.\s]+$/, "") || "another device";
    if (name.length <= max) return `${name}.`;
    const cut = name.slice(0, max);
    const word = cut.lastIndexOf(" ");
    return `${(word > 12 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/** −320 → "−320", 0 → "0", 400 → "+400". */
function formatCents(cents: number): string {
    if (cents === 0) return "0";
    return `${cents > 0 ? "+" : "−"}${Math.abs(cents)}`;
}

function formatSemitones(cents: number): string {
    const value = Math.abs(cents) / 100;
    const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return `${text} semitone${value === 1 ? "" : "s"}`;
}

function listWords(words: string[]): string {
    if (words.length < 2) return words.join("");
    return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function capitalise(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

let motionQuery: MediaQueryList | null = null;

/** Asked on every tick while the wheel turns, so the query is made once. */
function reducedMotion(): boolean {
    try {
        motionQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
        return motionQuery.matches;
    } catch {
        return false;
    }
}

/** Spotify's transport: play, skip, the seek bar and volume. Clicking these keeps the panel open. */
const TRANSPORT = [
    '[data-testid^="control-button-"]',
    '[data-testid="playback-progressbar"]',
    '[data-testid="volume-bar"]',
    '[data-testid="volume-bar-toggle-mute-button"]',
    ".player-controls",
].join(", ");

/** Inputs that take no typing; a focused slider or switch must not swallow the pad keys. */
const KEYLESS_INPUTS = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"]);

/** Typing belongs to whatever has the caret, never to the pads. */
function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target instanceof HTMLInputElement) return !KEYLESS_INPUTS.has(target.type);
    return Boolean(target.closest('textarea, select, [role="textbox"], [role="searchbox"], [role="combobox"]'));
}

/**
 * Spicetify's Player wrapper throws while the app is still hydrating
 * (`_state` is undefined for the first moment after a reload). Every read goes
 * through these so a slow boot cannot take the whole extension down.
 */
function isPlaying(): boolean {
    try {
        return Spicetify.Player?.isPlaying?.() === true;
    } catch {
        return false;
    }
}

/**
 * Holds a looping animation (one iteration = 1000 ms of its own time) on a
 * phase of a period: a small error is closed by riding its speed up to 6%, a
 * big one, or a stopped animation, is set straight.
 */
function steer(animation: Animation, phase: number, periodMs: number, settling = false): boolean {
    const rate = 1000 / periodMs;
    const want = ((phase % 1) + 1) % 1;
    // The page's animation clock only moves between frames; after a busy stretch
    // it still reads the last frame's time while the compositor has moved on.
    const timeline = Number(document.timeline?.currentTime ?? performance.now());
    const since = Math.max(0, performance.now() - timeline);
    const time = Number(animation.currentTime ?? 0) + (animation.playState === "running" ? since * animation.playbackRate : 0);
    let error = want - (((time % 1000) + 1000) % 1000) / 1000;
    error -= Math.round(error);
    // Just after it starts, the first positions Spotify hands over can be a
    // quarter of a second stale, so it may set itself straight once more.
    const snapAt = settling ? 0.012 : 0.12;
    if (animation.playState !== "running" || Math.abs(error) > snapAt) {
        const started = animation.playState !== "running";
        animation.currentTime = want * 1000 - (started ? 0 : since * rate);
        animation.playbackRate = rate;
        animation.play();
        return started;
    }
    const ride = rate * (1 + Math.max(-0.06, Math.min(0.06, error * 1.6)));
    if (typeof animation.updatePlaybackRate === "function") animation.updatePlaybackRate(ride);
    else animation.playbackRate = ride;
    return false;
}

/** What is heard, so the count, the lamps and the wheel follow the sound, not where Spotify was sent. */
function progressMs(): number {
    try {
        return needlePosition();
    } catch {
        return 0;
    }
}

function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Props = {},
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null) continue;
        if (key === "class") node.className = String(value);
        else if (key === "html") node.innerHTML = String(value);
        else if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        } else if (typeof value === "boolean") {
            node.toggleAttribute(key, value);
        } else {
            node.setAttribute(key, String(value));
        }
    }
    for (const child of children) {
        node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
}

/** The refresh loop runs every 100 ms; it only writes what actually changed. */
function setText(node: Element, value: string): void {
    if (node.textContent !== value) node.textContent = value;
}

function setAttr(node: Element, name: string, value: string): void {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function setData(node: HTMLElement, name: string, value: string): void {
    if (node.dataset[name] !== value) node.dataset[name] = value;
}

/** Stays focusable at a limit, so a keyboard user keeps their place. Style it like :disabled. */
function setOff(button: HTMLButtonElement, off: boolean): void {
    setAttr(button, "aria-disabled", off ? "true" : "false");
}

function isOff(button: HTMLButtonElement): boolean {
    return button.getAttribute("aria-disabled") === "true";
}

/**
 * A pinstripe pulled by hand along the top of a door and down its leading
 * edge: it comes in from nothing, turns the corner, and finishes in a spear.
 * Open, never a box around the door.
 */
function pinstripe(id: string): string {
    const fade = `slab-stripe-${id}`;
    return `<svg class="slab-stripe" viewBox="0 0 188 ${DOOR_HEIGHT}" width="188" height="${DOOR_HEIGHT}" aria-hidden="true" focusable="false">
  <defs><linearGradient id="${fade}" gradientUnits="userSpaceOnUse" x1="120" y1="0" x2="78" y2="0">
    <stop offset="0" stop-color="currentColor" stop-opacity="0"/><stop offset="1" stop-color="currentColor"/>
  </linearGradient></defs>
  <path d="M120 4.5H11Q4.5 4.5 4.5 11V24" fill="none" stroke="url(#${fade})" stroke-width="1"/>
  <path d="M108 6.5H11.5Q6.5 6.5 6.5 11.5V21" fill="none" stroke="url(#${fade})" stroke-width=".5"/>
  <path d="M4.5 23.5L6.1 27.2L4.5 32L2.9 27.2Z" fill="currentColor"/>
</svg>`;
}

/**
 * The Keep door's lock: a chrome knob in the sill, the kind an old Cadillac door has. Up, the
 * door is open to any mood; pushed down, this artist's mood is locked in.
 */
const LOCK_KNOB = `<svg viewBox="0 0 22 30" width="22" height="30" focusable="false">
  <defs>
    <linearGradient id="slab-lock-chrome" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#5E5956"/><stop offset=".34" stop-color="#F6F2EE"/>
      <stop offset=".62" stop-color="#B7B1AC"/><stop offset="1" stop-color="#4B4643"/>
    </linearGradient>
    <clipPath id="slab-lock-hole"><rect x="0" y="0" width="22" height="25"/></clipPath>
  </defs>
  <ellipse cx="11" cy="25" rx="7.2" ry="2.4" fill="#120104"/>
  <g clip-path="url(#slab-lock-hole)"><g class="slab-lock-pin">
    <rect x="7.2" y="5" width="7.6" height="24" rx="3.8" fill="url(#slab-lock-chrome)" stroke="rgba(0,0,0,.5)" stroke-width=".6"/>
    <path d="M9 7.6Q11 6.4 13 7.6" fill="none" stroke="#FFFFFF" stroke-opacity=".7" stroke-width=".8" stroke-linecap="round"/>
  </g></g>
  <path d="M3.4 25a7.6 2.6 0 0 0 15.2 0" fill="none" stroke="url(#slab-lock-chrome)" stroke-width="1.7"/>
</svg>`;

/** Each door's height: four rows of them now, Mine and Keep on the last. */
const DOOR_HEIGHT = 36;
/** The sparkline's drawing box on a door. */
const CURVE_WIDTH = 58;
const CURVE_HEIGHT = 28;

/** Hold Mine this long to keep what you hear over what's in it. */
const MINE_HOLD_MS = 650;

/** The little curve on a door: the actual EQ the mood applies. */
function doorCurve(gains: number[]): string {
    return `<svg class="slab-mood-curve" viewBox="0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}" width="${CURVE_WIDTH}" height="${CURVE_HEIGHT}" aria-hidden="true" focusable="false">
          <path class="slab-mood-zero" d="M0 ${CURVE_HEIGHT / 2}H${CURVE_WIDTH}"/>
          <path class="slab-mood-line" d="${curvePath(gains, CURVE_WIDTH, CURVE_HEIGHT)}"/>
        </svg>`;
}

/**
 * Display order only: lowest landing pitch first, reading the same way as the
 * rail under the sign, so a screw tool opens on Screwed and position means
 * something. Of the two at 0, Flat sits next to Sped Up, at the end.
 */
const MOODS_BY_PITCH = [...MOODS].sort(
    (a, b) => a.dsp.pitch - b.dsp.pitch || Number(a.id === "flat") - Number(b.id === "flat"),
);

interface SpeedInfo {
    text: string;
    hint: string;
}

type Bank = "chop" | "screw" | "tape";

interface PadDef {
    id: string;
    label: string;
    sub: string;
    /** The number key that plays it, and the bank it sits in. */
    key: string;
    bank: Bank;
    /** Resolves false when the edit couldn't happen; the pad then stays dark. */
    run: () => boolean | Promise<boolean>;
    /** Said when `run` comes back false. */
    miss?: string;
    /** A held pad: `run` puts it down, this lets it up. */
    release?: () => void;
    /** It needs the helper (or a newer one) and does nothing without it; this says why. */
    available?: () => boolean;
    unavailable?: () => string;
}

/** Said when a pad that needs the helper is pressed without one. */
const NEEDS_HELPER = "That pad needs SLAB DSP running on this Mac.";
const NEEDS_NEWER = "That pad needs a newer SLAB DSP: run bun run dsp:install.";

/** A helper with Spotify's audio coming through it, whatever it can do beyond. */
function processing(): boolean {
    const status = dspStatus();
    return status.linked && status.tapping === true && status.audio === true;
}

/** Why a tape pad is dark: no helper, or one from before tape. */
function tapeMissing(): string {
    return processing() ? NEEDS_NEWER : NEEDS_HELPER;
}

/** Said once, under the readout, whenever a track has no beat grid. */
const NO_GRID = "No beat grid here, so only Stop works and auto chop waits.";

/** Loop repeats the bar this many more times before the record runs on. */
const LOOP_TIMES = 4;
const LOOP_SUB = `${LOOP_TIMES} times`;

export class Deck {
    private state: SlabState;
    private chip: HTMLButtonElement;
    private panel: HTMLDivElement;
    private moodButtons = new Map<string, HTMLButtonElement>();

    private tagEl: HTMLSpanElement;
    private signTube: Tube;
    /** The nameplate, bent in neon. */
    private logoTube: Tube;
    /** The big wheel on the board behind the slider, and the neon ring round it. */
    private bigWheelEl: HTMLDivElement;
    private bigTurnEl: HTMLDivElement;
    private ringTube: Tube;
    private signEl: HTMLDivElement;
    private subEl: HTMLParagraphElement;
    private deadEl: HTMLParagraphElement;
    private deadWhereEl: HTMLSpanElement;
    /** The device Spotify is playing on, when it isn't this computer. */
    private deadRemote: string | null = null;

    private numberTube: Tube;
    private semiEl: HTMLSpanElement;
    private nudgeDown: HTMLButtonElement;
    private nudgeUp: HTMLButtonElement;
    private normalButton: HTMLButtonElement;
    private railEl: HTMLDivElement;
    private pitchInput: HTMLInputElement;
    private wheelEl: HTMLSpanElement;
    private rollEl: HTMLSpanElement;
    private spinEl: HTMLSpanElement;
    private knockRollEl: HTMLSpanElement;
    private knockSpinEl: HTMLSpanElement;
    private hotUp: HTMLSpanElement;
    private hotDown: HTMLSpanElement;
    private runUp: HTMLSpanElement;
    private runDown: HTMLSpanElement;
    private moodClips = new Map<number, HTMLSpanElement>();
    private moodFeet = new Map<number, HTMLSpanElement>();

    private bpmEl: HTMLElement;
    private barEl: HTMLSpanElement;
    private lampsEl: HTMLSpanElement;
    private lamps: HTMLElement[] = [];
    private playEl: HTMLSpanElement;
    private rulerEl: HTMLDivElement;
    private rulerDim: SVGPathElement;
    private rulerLit: SVGPathElement;
    private rulerClip: HTMLDivElement;
    private noGridEl: HTMLParagraphElement;
    private rulerKey = "";
    private rulerBar = -2;

    private pads: HTMLButtonElement[] = [];
    private padTimers = new Map<HTMLButtonElement, number>();
    private loopSub: HTMLElement | null = null;
    private padDefs = new Map<HTMLButtonElement, PadDef>();
    /** Pads by the number key that plays them, 1 through 0. */
    private padByKey = new Map<string, HTMLButtonElement>();
    /** Held pads by the key or pointer holding them down, so the right up lets the right one go. */
    private heldBy = new Map<string, HTMLButtonElement>();
    private bankButtons = new Map<Bank, HTMLButtonElement>();
    private roomSub: HTMLElement | null = null;
    private djButton: HTMLButtonElement;
    /** While DJ mode is on, the Chop bank's last row is the DJ's: how hard it plays, and what as. */
    private djStyleButton: HTMLButtonElement;
    private djStyleNameEl: HTMLSpanElement;
    private djHandEl: HTMLSpanElement;
    private handDown: HTMLButtonElement;
    private handUp: HTMLButtonElement;
    /** When a hand last played a pad: what happens just after is the hand's, not the DJ's. */
    private lastManualAt = 0;
    /** When the readout last answered something you did. */
    private answeredAt = 0;
    private cleanButton: HTMLButtonElement | null = null;
    private depthEl: HTMLSpanElement;
    private depthDown: HTMLButtonElement;
    private depthUp: HTMLButtonElement;
    private mineButton: HTMLButtonElement | null = null;
    private keepButton: HTMLButtonElement;
    private keepNameEl: HTMLSpanElement;
    private keepSubEl: HTMLSpanElement;
    /** The artist the Keep door last showed, so it is drawn again only when that changes. */
    private keepShown: string | null = null;
    /** Stops any held-button repeat; run on destroy. */
    private releases: (() => void)[] = [];
    private switchEl: HTMLButtonElement;
    private everyEl: HTMLSpanElement;
    private everyDown: HTMLButtonElement;
    private everyUp: HTMLButtonElement;

    private eqNote: HTMLDivElement;
    private eqNoteText: HTMLSpanElement;
    private eqNoteButton: HTMLButtonElement;
    private helperEl: HTMLParagraphElement;
    private speedEl: HTMLParagraphElement;
    private statusEl: HTMLSpanElement;
    private flashEl: HTMLSpanElement;
    private sillEl: HTMLDivElement | null = null;
    private lastHelperState: string | null = null;

    private disposed = false;
    private disposeDsp: (() => void) | null = null;
    private refreshTimer: number | null = null;
    private chipTimer: number | null = null;
    private activityTimer: number | null = null;
    private rollTimer: number | null = null;
    private lastGridUri: string | null = null;
    private lastGridAttempt = 0;
    /** Failed analysis fetches for the current track; each retry waits longer. */
    private gridMisses = 0;
    private announceTimer: number | null = null;
    private settleTimer: number | null = null;
    private resizeFrame: number | null = null;
    private lastPlaying: boolean | null = null;
    private lampFrame: number | null = null;
    /** Re-places the panel when its own height changes (the ModernEQ row, a short window). */
    private sizeWatch: ResizeObserver | null = null;
    private lastDspSync = 0;
    private pitchTimer: number | null = null;
    private pendingPitch: number | null = null;
    private renderedCents: number | null = null;
    /** Spokes and knock-off spin as one; two animations on one clock. */
    private spinAnimations: Animation[] = [];
    /** The big wheel's turn and its ring's beat kick, run by the compositor and steered from the beat clock. */
    private wheelTurn: Animation | null = null;
    private ringKick: Animation | null = null;
    /** A smooth playhead for the wheel: Spotify's position reaches the page in steps and with jitter. */
    private wheelClock: { pos: number; at: number; raw: number } | null = null;
    private lastWheelSteer = 0;
    /** When the wheel last started turning; for a moment after, it may still set itself straight. */
    private wheelStartedAt = 0;
    private strikeAnimation: Animation | null = null;
    private spinning = false;
    private modernEq = false;
    private lastEqCheck = 0;
    private lastRemote: string | null = null;
    private onDocumentClick = (event: MouseEvent) => this.handleOutside(event);
    /** Where the last press began: a click is only "outside" if it started outside. */
    private pressedInside = false;
    private onPointerStart = (event: PointerEvent) => {
        const target = event.target as Node | null;
        this.pressedInside = Boolean(target && (this.panel.contains(target) || this.chip.contains(target)));
    };
    private onKey = (event: KeyboardEvent) => this.handleKey(event);
    /** One reposition per frame, however fast the window is dragged. */
    private onResize = () => {
        if (this.resizeFrame !== null) return;
        this.resizeFrame = window.requestAnimationFrame(() => {
            this.resizeFrame = null;
            this.position();
        });
    };
    private onScroll = () => this.renderScrollCue();

    constructor(state: SlabState) {
        this.state = state;
        this.chip = this.buildChip();

        this.tagEl = h("span", { class: "slab-tag" }, TAGLINE);
        this.signTube = new Tube("slab-sign-tube", SIGN_WIDTH, SIGN_HEIGHT);
        this.logoTube = new Tube("slab-logo-tube", NAMEPLATE_WIDTH, NAMEPLATE_HEIGHT);
        this.logoTube.set({ lit: nameplateTubePath(), dark: "", boots: "", supports: "" });
        this.ringTube = new Tube("slab-ring-tube", BIG_WHEEL_BOX, BIG_WHEEL_BOX);
        this.ringTube.set({ lit: bigWheelRingPath(), dark: "", boots: "", supports: "" });
        this.bigTurnEl = h("div", { class: "slab-bigwheel-turnwrap", html: BIG_WHEEL.turn });
        this.bigWheelEl = h("div", { class: "slab-bigwheel", "aria-hidden": "true", html: BIG_WHEEL.base }, this.bigTurnEl, this.ringTube.node);
        this.signEl = h("div", { class: "slab-sign", role: "img" }, this.signTube.node);
        this.subEl = h("p", { class: "slab-sub" });
        // Where it's playing, then what that means, each on its own line, so the second is never the one cut.
        this.deadWhereEl = h("span", { class: "slab-dead-where" });
        this.deadEl = h("p", { class: "slab-dead" }, this.deadWhereEl, " ",
            h("span", { class: "slab-dead-why" }, "SLAB only reaches this computer."));
        this.deadEl.hidden = true;

        this.numberTube = new Tube("slab-number-tube", NUMBER_WIDTH, NUMBER_HEIGHT);
        this.semiEl = h("span", { class: "slab-semi", id: "slab-semi" });
        // Visible text first in every name, so a voice command that reads the button works.
        this.nudgeDown = h("button", {
            class: "slab-press slab-nudge",
            type: "button",
            "aria-label": "−10 cents",
            title: "Down 10 cents. Hold to keep going, Shift for a semitone.",
        }, h("span", {}, "−10"));
        this.nudgeUp = h("button", {
            class: "slab-press slab-nudge",
            type: "button",
            "aria-label": "+10 cents",
            title: "Up 10 cents. Hold to keep going, Shift for a semitone.",
        }, h("span", {}, "+10"));
        this.normalButton = h("button", {
            class: "slab-press slab-normal",
            type: "button",
            "aria-label": "Normal pitch",
        }, h("span", {}, "Normal"));
        const nudge = (button: HTMLButtonElement, sign: 1 | -1) => (event: Event) => {
            if (isOff(button)) return;
            this.setPitch(this.state.pitch + sign * ((event as MouseEvent).shiftKey ? 100 : 10), false);
        };
        this.press(this.nudgeDown, nudge(this.nudgeDown, -1), true);
        this.press(this.nudgeUp, nudge(this.nudgeUp, 1), true);
        this.press(this.normalButton, () => {
            if (!isOff(this.normalButton)) this.setPitch(0, true);
        });

        this.pitchInput = h("input", {
            class: "slab-range",
            id: "slab-pitch",
            type: "range",
            min: String(-PITCH_LIMIT),
            max: String(PITCH_LIMIT),
            step: "10",
            "aria-describedby": "slab-semi",
            oninput: () => this.onPitchInput(false),
            onchange: () => this.onPitchInput(true),
            onkeydown: (event: KeyboardEvent) => this.onPitchKey(event),
            // A drag right after a mood pick must follow the pointer, not finish the roll.
            onpointerdown: () => this.stopRoll(),
        });
        this.hotUp = h("span", { class: "slab-rail-hot slab-rail-hot-up" });
        this.hotDown = h("span", { class: "slab-rail-hot slab-rail-hot-down" });
        this.runUp = h("span", { class: "slab-rail-run slab-rail-hot-up" });
        this.runDown = h("span", { class: "slab-rail-run slab-rail-hot-down" });
        // The spokes roll and spin about the axle; the cone is fixed to the
        // viewpoint; the knock-off rolls and spins about the cone's tip.
        this.spinEl = h("span", { class: "slab-spin", html: WHEEL_SPOKES });
        this.rollEl = h("span", { class: "slab-roll" }, this.spinEl);
        this.knockSpinEl = h("span", { class: "slab-spin slab-knock", html: WHEEL_KNOCKOFF });
        this.knockRollEl = h("span", { class: "slab-roll slab-knock" }, this.knockSpinEl);
        this.wheelEl = h(
            "span",
            { class: "slab-wheel", html: WHEEL_STATIC },
            this.rollEl,
            h("span", { class: "slab-cone", html: WHEEL_CONE }),
            this.knockRollEl,
        );
        this.railEl = this.buildRail();

        this.bpmEl = h("b", {}, "–");
        this.barEl = h("span", { class: "slab-bar" }, "Bar –");
        this.lampsEl = h("span", { class: "slab-lamps", role: "img", "aria-label": "No beat" });
        this.setLampCount(4);
        // Only a pause is news; playing is what the deck is for.
        this.playEl = h("span", { class: "slab-play" }, "Paused");
        this.flashEl = h("span", { class: "slab-flash" });

        this.rulerEl = h("div", {
            class: "slab-ruler",
            "aria-hidden": "true",
            html: `<svg width="${RULER_WIDTH}" height="14" viewBox="0 0 ${RULER_WIDTH} 14" focusable="false"><path class="slab-ruler-dim"/></svg>
<div class="slab-ruler-clip"><svg width="${RULER_WIDTH}" height="14" viewBox="0 0 ${RULER_WIDTH} 14" focusable="false"><path class="slab-ruler-lit"/></svg></div>`,
        });
        this.rulerDim = this.rulerEl.querySelector(".slab-ruler-dim") as SVGPathElement;
        this.rulerLit = this.rulerEl.querySelector(".slab-ruler-lit") as SVGPathElement;
        this.rulerClip = this.rulerEl.querySelector(".slab-ruler-clip") as HTMLDivElement;
        this.noGridEl = h("p", { class: "slab-nogrid", id: "slab-nogrid" });

        // A latching press, in the same tuck and roll as the pads: it stays pushed
        // in and lit while auto chop runs, and its second line says how often, and how
        // soon the next cut is while it runs.
        this.everyEl = h("span", { class: "slab-every" });
        this.switchEl = h("button", {
            class: "slab-press slab-auto-press",
            type: "button",
            role: "switch",
            "aria-checked": String(state.auto),
            "aria-label": "Auto chop",
            onclick: () => this.toggleAuto(),
        }, h("span", { class: "slab-auto-words" }, h("span", { class: "slab-auto-name" }, "Auto chop"), this.everyEl));
        this.everyDown = h("button", {
            class: "slab-press slab-step",
            type: "button",
            "aria-label": "Fewer bars between chops",
        }, h("span", {}, "−"));
        this.everyUp = h("button", {
            class: "slab-press slab-step",
            type: "button",
            "aria-label": "More bars between chops",
        }, h("span", {}, "+"));
        this.press(this.everyDown, () => {
            if (!isOff(this.everyDown)) this.setEvery(this.state.every - 1);
        }, true);
        this.press(this.everyUp, () => {
            if (!isOff(this.everyUp)) this.setEvery(this.state.every + 1);
        }, true);

        // How far the Screw pad rides the pitch down.
        this.depthEl = h("span", { class: "slab-every slab-depth-words" });
        this.depthDown = h("button", {
            class: "slab-press slab-step",
            type: "button",
            "aria-label": "Screw rides less far down",
        }, h("span", {}, "−"));
        this.depthUp = h("button", {
            class: "slab-press slab-step",
            type: "button",
            "aria-label": "Screw rides further down",
        }, h("span", {}, "+"));
        this.press(this.depthDown, () => {
            if (!isOff(this.depthDown)) this.setScrewDepth(this.state.screwDepth - 1);
        }, true);
        this.press(this.depthUp, () => {
            if (!isOff(this.depthUp)) this.setScrewDepth(this.state.screwDepth + 1);
        }, true);

        // The last door: keep this mood for whoever is playing, and it comes on with them.
        this.keepNameEl = h("span", { class: "slab-mood-name" });
        this.keepSubEl = h("span", { class: "slab-mood-cents" });
        this.keepButton = h("button", {
            class: "slab-mood slab-keep",
            type: "button",
            "aria-pressed": "false",
            onclick: () => this.toggleKeep(),
        }, this.keepNameEl, this.keepSubEl, h("span", { class: "slab-lock", "aria-hidden": "true", html: LOCK_KNOB }));
        this.keepButton.insertAdjacentHTML("afterbegin", pinstripe("keep"));

        this.eqNoteText = h("span", { class: "slab-eq-text" });
        this.eqNoteButton = h("button", {
            class: "slab-press slab-eq-btn",
            type: "button",
            onclick: (event: Event) => {
                event.stopPropagation();
                this.toggleEqOwner();
            },
        }, h("span", {}, "Use SLAB EQ"));
        this.eqNote = h("div", { class: "slab-eq" }, this.eqNoteText, this.eqNoteButton);
        this.eqNote.hidden = true;
        this.helperEl = h("p", { class: "slab-status" }, "Looking for the helper.");
        this.speedEl = h("p", { class: "slab-status" });
        this.statusEl = h("span", { class: "slab-sr", role: "status", "aria-live": "polite" });
        this.modernEq = modernEqPresent();

        // DJ mode: SLAB works the record itself, on full screw, until it's switched off.
        this.djButton = h("button", {
            class: "slab-press slab-dj",
            type: "button",
            role: "switch",
            "aria-checked": String(state.dj),
            "aria-label": "DJ mode",
            title: "DJ mode: SLAB works the record itself, on full screw. A Chop or Screw pad of yours takes it back for eight bars.",
            onclick: () => this.toggleDj(),
        }, h("span", {}, "DJ"));
        // While it plays, the Chop bank's last row is the DJ's, laid out like Auto chop's: the press
        // says what kind of record it plays it as (press for the next, kept for the artist), and
        // −/+ set how hard it plays.
        this.djStyleNameEl = h("span", { class: "slab-auto-name" });
        this.djHandEl = h("span", { class: "slab-every" });
        this.djStyleButton = h("button", {
            class: "slab-press slab-auto-press slab-dj-style",
            type: "button",
            onclick: () => this.cycleDjStyle(),
        }, h("span", { class: "slab-auto-words" }, this.djStyleNameEl, this.djHandEl));
        this.handDown = h("button", { class: "slab-press slab-step", type: "button", "aria-label": "DJ plays less" }, h("span", {}, "−"));
        this.handUp = h("button", { class: "slab-press slab-step", type: "button", "aria-label": "DJ plays more" }, h("span", {}, "+"));
        this.press(this.handDown, () => {
            if (!isOff(this.handDown)) this.setDjHandLevel(this.state.djHand - 1);
        });
        this.press(this.handUp, () => {
            if (!isOff(this.handUp)) this.setDjHandLevel(this.state.djHand + 1);
        });

        this.panel = this.buildPanel();

        onChop((event) => {
            // Auto chop and DJ mode cut on their own; what they do is shown, not spoken each time.
            const automatic = event.kind === "auto" || (djRunning() && Date.now() - this.lastManualAt > 1_500);
            this.flashActivity(event.label, !automatic, automatic);
            if (automatic) this.hitPad(this.pads[0]);
        });
    }

    mount(): void {
        this.injectStyles();
        this.mountChip();
        document.body.append(this.panel);
        document.addEventListener("pointerdown", this.onPointerStart, true);
        document.addEventListener("click", this.onDocumentClick, true);
        // The panel sits above Spotify's own menus, so opening one closes it.
        document.addEventListener("contextmenu", this.onDocumentClick, true);
        document.addEventListener("keydown", this.onKey);
        document.addEventListener("keyup", this.onKeyUp);
        // Keys and pointers that come up while the window is away never say so: let every hold go.
        window.addEventListener("blur", this.onBlur);
        document.addEventListener("visibilitychange", this.onVisibility);
        onHoldChange((held) => {
            for (const pad of this.pads) {
                if (pad.dataset.hold === "true") setData(pad, "latched", held.has(pad.dataset.pad as HoldName) ? "true" : "false");
            }
        });
        window.addEventListener("resize", this.onResize);
        this.panel.addEventListener("scroll", this.onScroll, { passive: true });
        if (typeof ResizeObserver === "function") {
            this.sizeWatch = new ResizeObserver(() => this.onResize());
            this.sizeWatch.observe(this.panel);
        }

        if (this.state.open) this.open();
        else this.panel.hidden = true;

        this.renderMoodState();
        this.renderAutoState();
        this.renderBank();
        this.renderDepth();
        this.renderTape();
        this.renderKeep();
        onDj((label) => this.flashActivity(label, false, true));
        setDjHand(this.state.djHand);
        if (this.state.dj) startDj();
        this.renderDj();
        this.renderPitch();
        this.renderEqNote();
        // Yielding is not the same as doing nothing: ModernEQ only writes its
        // curve when its own UI is used, so SLAB puts that curve back on boot
        // instead of leaving whatever the previous session left behind.
        if (this.modernEq && !this.slabOwnsEq()) void this.restoreModernEqCurve();
        let wasLinked = false;
        this.disposeDsp = onDspChange((status) => {
            this.renderDsp();
            // The helper can start (or restart) after the extension does. When
            // it comes back, re-push the current mood so the panel and the audio
            // agree without the user having to reselect anything.
            if (status.linked && !wasLinked) {
                void sendDsp(this.sound());
            }
            wasLinked = status.linked;
        });
        void probeDsp(true);
        void this.applyMood(this.state.moodId, false);
        // Whoever is playing at boot gets their kept mood too, without a word about it.
        this.applyKept(false);
        void this.syncGrid();
        void loadLines();
        this.refresh();
        // Measurements taken before the embedded faces arrive are in the fallback
        // font, and nothing asks for them until text is drawn, so ask now.
        void Promise.all([
            document.fonts?.load('600 14px "SLAB Barlow"'),
            document.fonts?.load('500 12px "SLAB Barlow"'),
        ])
            .catch(() => undefined)
            .then(() => {
                if (!this.disposed) this.renderSign();
            });
        this.refreshTimer = window.setInterval(() => this.refresh(), 100);
        this.chipTimer = window.setInterval(() => this.ensureChip(), 1200);
    }

    destroy(): void {
        this.disposed = true;
        if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
        if (this.chipTimer !== null) window.clearInterval(this.chipTimer);
        if (this.activityTimer !== null) window.clearTimeout(this.activityTimer);
        if (this.rollTimer !== null) window.clearTimeout(this.rollTimer);
        if (this.pitchTimer !== null) window.clearTimeout(this.pitchTimer);
        if (this.announceTimer !== null) window.clearTimeout(this.announceTimer);
        if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
        if (this.resizeFrame !== null) window.cancelAnimationFrame(this.resizeFrame);
        for (const timer of this.padTimers.values()) window.clearTimeout(timer);
        this.padTimers.clear();
        for (const release of this.releases) release();
        if (this.lampFrame !== null) window.cancelAnimationFrame(this.lampFrame);
        this.lampFrame = null;
        for (const animation of this.spinAnimations) animation.cancel();
        this.spinAnimations = [];
        this.spinning = false;
        this.strikeAnimation?.cancel();
        this.strikeAnimation = null;
        document.removeEventListener("pointerdown", this.onPointerStart, true);
        document.removeEventListener("click", this.onDocumentClick, true);
        document.removeEventListener("contextmenu", this.onDocumentClick, true);
        document.removeEventListener("keydown", this.onKey);
        document.removeEventListener("keyup", this.onKeyUp);
        window.removeEventListener("blur", this.onBlur);
        document.removeEventListener("visibilitychange", this.onVisibility);
        stopDj();
        onDj(null);
        this.releaseHolds();
        onHoldChange(null);
        window.removeEventListener("resize", this.onResize);
        this.panel.removeEventListener("scroll", this.onScroll);
        this.sizeWatch?.disconnect();
        this.sizeWatch = null;
        this.chip.remove();
        this.panel.remove();
        // A newer copy may be taking over, and it brings its own sheet.
        document.getElementById(STYLE_ID)?.remove();
        onChop(null);
        this.disposeDsp?.();
        this.disposeDsp = null;
    }

    onTrackChange(): void {
        resetForTrack();
        this.lastGridUri = null;
        this.gridMisses = 0;
        void this.syncGrid();
        // Fetched now so the Line pad has the words the first time it's hit.
        void loadLines();
        this.keepShown = null;
        this.applyKept(true);
        this.refresh();
    }

    /**
     * An older copy that stood aside may have left its sheet behind; this one
     * wins. Either way the sheet goes last in the head, so it sits after
     * Spotify's own CSS in the cascade, as it would on a clean boot.
     */
    private injectStyles(): void {
        const style = (document.getElementById(STYLE_ID) as HTMLStyleElement | null) ?? h("style", { id: STYLE_ID });
        if (style.textContent !== CSS) style.textContent = CSS;
        document.head.append(style);
    }

    /**
     * Beside the lyrics button, where the playbar's own controls live. Without
     * that anchor the end of the playbar will do for now; with no playbar at all
     * the chip waits off the page rather than landing somewhere it can't be seen.
     */
    private mountChip(): void {
        const lyrics = document.querySelector('[data-testid="lyrics-button"]');
        const host = lyrics?.parentElement;
        if (lyrics && host) {
            // Already among the controls is home, even if another extension sits between it and Lyrics.
            if (this.chip.parentElement !== host) host.insertBefore(this.chip, lyrics);
            return;
        }
        if (this.chip.isConnected) return;
        document.querySelector('[data-testid="now-playing-bar"]')?.append(this.chip);
    }

    /**
     * Spotify builds the playbar late and rebuilds it on some navigation, so keep
     * re-homing the chip, and place an open panel again once its anchor exists.
     */
    private ensureChip(): void {
        const wasHome = this.chip.isConnected;
        this.mountChip();
        if (!wasHome && this.chip.isConnected && !this.panel.hidden) this.position();
    }

    private buildChip(): HTMLButtonElement {
        const chip = h("button", {
            class: "slab-chip",
            type: "button",
            "aria-label": "SLAB playback moods",
            "aria-expanded": "false",
            title: CHIP_TITLE,
            onclick: (event: MouseEvent) => {
                event.stopPropagation();
                // A keyboard press arrives as a click with no pointer detail.
                this.toggle(event.detail === 0);
            },
            onkeydown: (event: KeyboardEvent) => this.handleTab(event, "chip"),
        });
        chip.innerHTML = CHIP_ICON;
        return chip;
    }

    /**
     * The tube, its marks and the wheel. Everything takes its x from railX, which
     * is the same line the native range thumb travels, so a tick, a clip and the
     * wheel's centre can only ever agree.
     */
    private buildRail(): HTMLDivElement {
        let ticks = "";
        for (let cents = -PITCH_LIMIT; cents <= PITCH_LIMIT; cents += 100) {
            const major = cents % PITCH_LIMIT === 0;
            const x = railX(cents);
            ticks += major
                ? `<rect x="${x - 1}" y="1" width="2" height="9"/>`
                : `<rect x="${x - 0.5}" y="2" width="1" height="4"/>`;
        }
        const rail = h("div", { class: "slab-rail" });
        rail.style.width = `${RAIL_WIDTH}px`;
        // The native thumb's width comes from the same number as the input's travel.
        rail.style.setProperty("--slab-thumb", `${THUMB_SIZE}px`);
        rail.style.setProperty("--slab-wheel", `${WHEEL_SIZE}px`);
        rail.style.setProperty("--slab-tyre", `${TYRE_RADIUS}px`);
        rail.style.setProperty("--slab-poke", `${WHEEL_SIZE / 2 + POKE_X}px ${WHEEL_SIZE / 2 + POKE_Y}px`);

        const tube = h("span", { class: "slab-rail-tube" });
        tube.style.left = `${railX(-PITCH_LIMIT)}px`;
        tube.style.width = `${railX(PITCH_LIMIT) - railX(-PITCH_LIMIT)}px`;
        this.hotUp.style.left = `${railX(0)}px`;
        this.hotUp.style.width = `${railX(PITCH_LIMIT) - railX(0)}px`;
        this.hotDown.style.left = `${railX(-PITCH_LIMIT)}px`;
        this.hotDown.style.width = `${railX(0) - railX(-PITCH_LIMIT)}px`;
        this.runUp.style.left = this.hotUp.style.left;
        this.runUp.style.width = this.hotUp.style.width;
        this.runDown.style.left = this.hotDown.style.left;
        this.runDown.style.width = this.hotDown.style.width;

        rail.append(tube, this.hotDown, this.hotUp);

        // The scale runs under the tyre, where the wheel can never cover it: the
        // lit run shows distance from normal and each clip drops a foot onto it.
        const line = h("span", { class: "slab-rail-line" });
        line.style.left = tube.style.left;
        line.style.width = tube.style.width;
        const marks = h(
            "div",
            { class: "slab-rail-marks" },
            h("span", {
                class: "slab-rail-ticks",
                html: `<svg width="${RAIL_WIDTH}" height="11" viewBox="0 0 ${RAIL_WIDTH} 11" aria-hidden="true" focusable="false">${ticks}</svg>`,
            }),
            line,
            this.runDown,
            this.runUp,
        );

        // Moods landing on the same cents share one clip.
        for (const mood of MOODS) {
            const cents = mood.dsp.pitch;
            if (this.moodClips.has(cents)) continue;
            const clip = h("span", { class: "slab-clip" });
            clip.style.left = `${railX(cents)}px`;
            this.moodClips.set(cents, clip);
            rail.append(clip);
            const foot = h("span", { class: "slab-clip-foot" });
            foot.style.left = clip.style.left;
            this.moodFeet.set(cents, foot);
            marks.append(foot);
        }

        this.pitchInput.style.left = `${(WHEEL_SIZE - THUMB_SIZE) / 2}px`;
        this.pitchInput.style.width = `${RAIL_WIDTH - (WHEEL_SIZE - THUMB_SIZE)}px`;
        rail.append(this.pitchInput, this.wheelEl, marks);
        return rail;
    }

    private buildPanel(): HTMLDivElement {
        const panel = h("div", {
            class: "slab-panel",
            role: "dialog",
            "aria-label": "SLAB playback moods",
            "data-gas": "on",
            "data-tube": "off",
            "data-primer": "false",
            "data-grid": "false",
        });
        panel.hidden = true;
        this.chip.dataset.remote = "false";

        const close = h("button", {
            class: "slab-close",
            type: "button",
            "aria-label": "Close SLAB",
            html: CLOSE_ICON,
            onclick: () => this.close(),
        });

        const head = h("div", { class: "slab-head" }, h("span", { class: "slab-badge", role: "img", "aria-label": "SLAB" }, this.logoTube.node), this.tagEl, this.djButton, close);

        const scale = h(
            "div",
            { class: "slab-scale" },
            h("span", { class: "slab-scale-end", style: `left:${railX(-PITCH_LIMIT)}px` }, "Octave down"),
            this.normalButton,
            h("span", { class: "slab-scale-end", style: `left:${railX(PITCH_LIMIT)}px` }, "Octave up"),
        );
        this.normalButton.style.left = `${railX(0)}px`;

        const stage = h("div", { class: "slab-stage" }, this.signEl, this.subEl, this.deadEl);

        const pitchHead = h(
            "div",
            { class: "slab-pitch-head" },
            h("div", { class: "slab-pitch-words" },
                h("label", { class: "slab-pitch-label", for: "slab-pitch" }, "Pitch in cents"),
                this.semiEl,
            ),
            this.numberTube.node,
            h("div", { class: "slab-nudges" }, this.nudgeDown, this.nudgeUp),
        );

        const bay = h("div", { class: "slab-bay" }, this.bigWheelEl, stage, pitchHead, this.railEl, scale);
        const trim = h("div", { class: "slab-trim" }, bay);

        const moodGrid = h("div", {
            class: "slab-moods",
            role: "radiogroup",
            "aria-label": "Mood",
            onkeydown: (event: KeyboardEvent) => this.handleMoodKey(event),
        });
        for (const mood of MOODS_BY_PITCH) {
            const button = h("button", {
                class: "slab-mood",
                type: "button",
                role: "radio",
                "data-mood": mood.id,
                "aria-checked": "false",
                tabindex: "-1",
                onclick: () => void this.applyMood(mood.id, true),
            });
            button.innerHTML = `${pinstripe(mood.id)}
        <span class="slab-mood-name">${mood.name}</span>
        <span class="slab-mood-cents">${formatCents(mood.dsp.pitch)}<span class="slab-sr"> cents</span></span>
        ${doorCurve(mood.gains)}`;
            this.moodButtons.set(mood.id, button);
            moodGrid.append(button);
        }
        // Mine: tap to keep the sound you're hearing, tap again to bring it back, hold to keep a new one over it.
        const mine = h("button", {
            class: "slab-mood slab-mine",
            type: "button",
            role: "radio",
            "data-mood": MINE_ID,
            "aria-checked": "false",
            tabindex: "-1",
        });
        this.mineButton = mine;
        this.moodButtons.set(MINE_ID, mine);
        this.wireMine(mine);
        moodGrid.append(mine);
        this.renderMine();
        // Keep is a switch, not a mood, so it sits in the last door's place outside the group.
        const doors = h("div", { class: "slab-doors" }, moodGrid, this.keepButton);

        const readout = h(
            "div",
            { class: "slab-read" },
            h("div", { class: "slab-read-top" },
                h("span", { class: "slab-bpm" }, this.bpmEl, h("small", {}, "BPM")),
                h("span", { class: "slab-count" }, this.barEl, this.lampsEl, this.playEl),
            ),
            // What a press just did shows here, right above the pads, then the ruler comes back.
            h("div", { class: "slab-ruler-slot" }, this.rulerEl, this.noGridEl, this.flashEl),
        );

        const tooEarly = "Not that much record behind the needle yet.";
        const chopDefs: PadDef[] = [
            { id: "chop1", label: "Chop", sub: "1 bar back", key: "1", bank: "chop", run: () => chopBars(1), miss: tooEarly },
            { id: "chop2", label: "Chop", sub: "2 bars back", key: "2", bank: "chop", run: () => chopBars(2), miss: tooEarly },
            { id: "chop4", label: "Chop", sub: "4 bars back", key: "3", bank: "chop", run: () => chopBars(4), miss: tooEarly },
            {
                id: "loop",
                label: "Loop",
                sub: LOOP_SUB,
                key: "4",
                bank: "chop",
                // A second press ends the loop early.
                run: () => {
                    if (!isLooping()) return loopBars(LOOP_TIMES);
                    cancelLoop();
                    this.flashActivity("Loop off");
                    return true;
                },
                miss: "Nothing to loop here yet.",
            },
            {
                id: "stop",
                label: "Stop",
                sub: "Tape stop",
                key: "5",
                bank: "chop",
                run: () => {
                    if (isStopping()) {
                        this.flashActivity("Already stopping");
                        return false;
                    }
                    if (!isPlaying()) {
                        this.flashActivity("Already stopped");
                        return false;
                    }
                    // 380 ms down + 70 ms hold in the helper; pause right after
                    // the ramp bottoms out so the effect is not clipped. If the
                    // helper can't ramp, the fader does the stop. The pad lights
                    // now, as the stop starts, not when it's over.
                    void tapeStop(dspStatus().linked ? { spinDown: dspTapeStop, spinDownMs: 470 } : {});
                    return true;
                },
            },
        ];
        // The other half of the name: pitch ridden down by hand, the lid shut, an echo thrown, a
        // line run back, the record spun. The holds last as long as the pad is down.
        const screwDefs: PadDef[] = [
            {
                id: "screw",
                label: "Screw",
                sub: "Hold it down",
                key: "6",
                bank: "screw",
                available: canHold,
                unavailable: () => NEEDS_HELPER,
                run: () => pressHold("screw", { cents: -this.state.screwDepth * 100 }),
                release: () => releaseHold("screw"),
                miss: NEEDS_HELPER,
            },
            { id: "line", label: "Line", sub: "Run it back", key: "7", bank: "screw", run: () => runLineBack(), miss: tooEarly },
            {
                id: "trunk",
                label: "Trunk",
                sub: "Hold it shut",
                key: "8",
                bank: "screw",
                available: canHold,
                unavailable: () => NEEDS_HELPER,
                run: () => pressHold("trunk"),
                release: () => releaseHold("trunk"),
                miss: NEEDS_HELPER,
            },
            {
                id: "echo",
                label: "Echo",
                sub: "Hold it",
                key: "9",
                bank: "screw",
                available: canHold,
                unavailable: () => NEEDS_HELPER,
                run: () => pressHold("echo", { beatMs: this.beatMs() }),
                release: () => releaseHold("echo"),
                miss: NEEDS_HELPER,
            },
            { id: "spin", label: "Spin", sub: "Back a bar", key: "0", bank: "screw", run: () => spinBack(), miss: tooEarly },
        ];
        // The tape: what the record plays through, over any mood, on until turned off. No keys:
        // these are set and left, not played.
        const tapeLayer = (id: TapeLayer, label: string, sub: string): PadDef => ({
            id,
            label,
            sub,
            key: "",
            bank: "tape",
            available: canTape,
            unavailable: tapeMissing,
            run: () => {
                const next = { ...this.state.tape };
                next[id] = !next[id];
                this.setTape(next);
                this.flashActivity(`${label} ${next[id] ? "on" : "off"}`);
                return true;
            },
        });
        const tapeDefs: PadDef[] = [
            {
                id: "room",
                label: "Room",
                sub: roomName(this.state.tape.room),
                key: "",
                bank: "tape",
                available: processing,
                unavailable: () => NEEDS_HELPER,
                run: () => {
                    const room = nextRoom(this.state.tape.room);
                    this.setTape({ ...this.state.tape, room });
                    this.flashActivity(room ? `In the ${roomName(room).toLowerCase()}` : "Back in the mood's own room");
                    return true;
                },
            },
            tapeLayer("wow", "Wow", "Worn tape"),
            tapeLayer("hiss", "Hiss", "Cassette"),
            tapeLayer("crackle", "Crackle", "Vinyl"),
            tapeLayer("crush", "Crush", "Lo-fi"),
        ];
        const chopRow = this.padRow("chop", "Cuts", chopDefs);
        const screwRow = this.padRow("screw", "Holds, a line and a spin", screwDefs);
        const tapeRow = this.padRow("tape", "Tape", tapeDefs);

        const auto = h("div", { class: "slab-auto", "data-for": "chop" }, this.everyDown, this.switchEl, this.everyUp);
        const depth = h(
            "div",
            { class: "slab-auto", "data-for": "screw" },
            h("div", { class: "slab-stepper" }, this.depthDown, this.depthEl, this.depthUp),
        );
        this.cleanButton = h("button", {
            class: "slab-press slab-clean",
            type: "button",
            onclick: () => this.cleanTape(),
        }, h("span", {}, "Clean tape"));
        const tapeControl = h(
            "div",
            { class: "slab-auto", "data-for": "tape" },
            this.cleanButton,
            h("span", { class: "slab-every slab-tape-note" }, "On over every mood"),
        );
        // Which pads show: the cuts, the screw or the tape. The keys always play the first two.
        const banks = h(
            "div",
            { class: "slab-banks", role: "radiogroup", "aria-label": "Pads" },
            this.bankButton("chop", "Chop"),
            this.bankButton("screw", "Screw"),
            this.bankButton("tape", "Tape"),
        );
        const djRow = h("div", { class: "slab-auto slab-dj-row", "data-for": "chop" }, this.handDown, this.djStyleButton, this.handUp);
        const bankRow = h("div", { class: "slab-bankrow" }, banks, auto, djRow, depth, tapeControl);

        // The scuff plate: stainless, ribbed along its length, a Phillips head at
        // each end, and the status stamped into the smooth field between the ribs.
        this.sillEl = h(
            "div",
            { class: "slab-sill" },
            h("span", { class: "slab-screw-at slab-screw-left", html: SILL_SCREW_LEFT }),
            h("span", { class: "slab-screw-at slab-screw-right", html: SILL_SCREW_RIGHT }),
            h("div", { class: "slab-sill-plate" }, this.eqNote, this.helperEl, this.speedEl),
        );

        // The body line: one crease across the door, with the deeper coat under it.
        const lower = h("div", { class: "slab-lower" }, readout, chopRow, screwRow, tapeRow, bankRow);
        const body = h("div", { class: "slab-body" }, head, trim, doors, lower, this.sillEl);
        // In a short window the sill stays on the bottom edge and the car scrolls
        // behind it; a lip on the top edge says when something is hidden above.
        panel.append(h("div", { class: "slab-lip slab-lip-top" }), body, this.statusEl);
        panel.addEventListener("click", (event) => event.stopPropagation());
        panel.addEventListener("keydown", (event) => this.handleTab(event, "panel"));
        return panel;
    }

    /** A row of five pads, one bank: four, then the last a hand's width apart. */
    private padRow(bank: Bank, label: string, defs: PadDef[]): HTMLDivElement {
        const row = h("div", { class: "slab-pads", role: "group", "aria-label": label, "data-bank": bank });
        for (const def of defs) {
            const sub = h("small", {}, def.sub);
            const pad = h("button", {
                class: "slab-press slab-pad",
                type: "button",
                "data-pad": def.id,
                ...(def.key ? { "aria-keyshortcuts": def.key } : {}),
            }, h("i", { class: "slab-key", "aria-hidden": "true" }, def.key), h("b", {}, def.label), sub);
            if (def.id === "loop") this.loopSub = sub;
            if (def.id === "room") this.roomSub = sub;
            if (def.release) {
                setData(pad, "hold", "true");
                this.wireHold(pad, def);
            } else {
                this.press(pad, () => {
                    this.showBank(def.bank);
                    this.firePad(pad, def);
                });
            }
            this.padDefs.set(pad, def);
            if (def.key) this.padByKey.set(def.key, pad);
            this.pads.push(pad);
            row.append(pad);
        }
        return row;
    }

    /**
     * A held pad is down for as long as a finger, the pointer or its key is: it comes up on
     * the matching up, wherever the pointer has wandered by then.
     */
    private wireHold(pad: HTMLButtonElement, def: PadDef): void {
        pad.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            try {
                pad.setPointerCapture(event.pointerId);
            } catch {
                /* a synthetic pointer can't be captured; its up still lets the pad go */
            }
            this.holdDown(pad, def, `pointer:${event.pointerId}`);
        });
        const up = (event: PointerEvent) => this.holdUp(`pointer:${event.pointerId}`);
        pad.addEventListener("pointerup", up);
        pad.addEventListener("pointercancel", up);
        pad.addEventListener("lostpointercapture", up);
        pad.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat) return;
            this.holdDown(pad, def, `key:${event.code}`);
        });
        pad.addEventListener("keyup", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            this.holdUp(`key:${event.code}`);
        });
        // A click with no press behind it (a screen reader, voice control) can't hold anything
        // down: it latches the pad instead, and the next one lets it go.
        pad.addEventListener("click", (event) => {
            event.stopPropagation();
            if (event.detail !== 0) return;
            const by = `latch:${def.id}`;
            if (this.heldBy.has(by)) {
                this.holdUp(by);
                this.flashActivity(`${def.label} let go`);
                return;
            }
            this.holdDown(pad, def, by);
            if (this.heldBy.has(by)) this.flashActivity(`${def.label} held. Press again to let go.`);
        });
    }

    private holdDown(pad: HTMLButtonElement, def: PadDef, by: string): void {
        if (this.heldBy.has(by)) return;
        this.showBank(def.bank);
        if (isOff(pad)) {
            this.flashActivity(def.available ? (def.unavailable?.() ?? NEEDS_HELPER) : NO_GRID);
            return;
        }
        this.handPlayed(def);
        if (def.run() !== true) {
            if (def.miss) this.flashActivity(def.miss);
            return;
        }
        this.heldBy.set(by, pad);
    }

    private holdUp(by: string): void {
        const pad = this.heldBy.get(by);
        if (!pad) return;
        this.heldBy.delete(by);
        // Still down under another key or pointer: it stays down.
        for (const other of this.heldBy.values()) if (other === pad) return;
        this.padDefs.get(pad)?.release?.();
    }

    /** Every held pad up at once: the window lost the keys, or the panel is going. */
    private releaseHolds(): void {
        this.heldBy.clear();
        releaseAll();
    }

    private onKeyUp = (event: KeyboardEvent) => this.holdUp(`key:${event.code}`);
    private onBlur = () => this.releaseHolds();
    private onVisibility = () => {
        if (document.visibilityState === "hidden") this.releaseHolds();
    };

    private bankButton(bank: Bank, label: string): HTMLButtonElement {
        const button = h("button", {
            class: "slab-press slab-bank",
            type: "button",
            role: "radio",
            "data-bank": bank,
            "aria-checked": "false",
            tabindex: "-1",
            onclick: () => this.showBank(bank),
            onkeydown: (event: KeyboardEvent) => {
                if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                event.preventDefault();
                const order: Bank[] = ["chop", "screw", "tape"];
                const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
                const next = order[(order.indexOf(bank) + step + order.length) % order.length];
                this.showBank(next);
                this.bankButtons.get(next)?.focus();
            },
        }, h("span", {}, label));
        this.bankButtons.set(bank, button);
        return button;
    }

    /** Shows a bank's pads and its control. Playing a pad from the other bank's key shows that bank. */
    private showBank(bank: Bank): void {
        if (this.state.bank !== bank) {
            this.state.bank = bank;
            saveState(this.state);
        }
        this.renderBank();
    }

    private renderBank(): void {
        const bank = this.state.bank;
        setData(this.panel, "bank", bank);
        for (const [id, button] of this.bankButtons) {
            setAttr(button, "aria-checked", id === bank ? "true" : "false");
            setAttr(button, "tabindex", id === bank ? "0" : "-1");
        }
    }

    private setScrewDepth(depth: number): void {
        const next = Math.max(SCREW_MIN, Math.min(SCREW_MAX, Math.round(depth)));
        if (next === this.state.screwDepth) return;
        this.state.screwDepth = next;
        saveState(this.state);
        this.renderDepth();
        this.announceSettled(() => this.depthEl.textContent ?? "");
    }

    /**
     * DJ mode on: the sound you had is kept to go back to, the record goes on full screw, and the
     * DJ starts working it. Off: the DJ stops and your sound comes back as it was.
     */
    private toggleDj(): void {
        if (this.state.dj) {
            stopDj();
            const before = this.state.djBefore;
            this.state.dj = false;
            this.state.djBefore = null;
            if (before) {
                this.state.pitch = before.pitch;
                this.state.tape = { ...before.tape };
                this.renderTape();
                void this.applyMood(before.moodId === MINE_ID && !mineMood() ? "flat" : before.moodId, false);
            } else {
                saveState(this.state);
            }
            // An artist who came on while the DJ had the record gets their kept mood now.
            this.applyKept(false);
            this.renderDj();
            this.renderAutoState();
            this.flashActivity("DJ off: the record is yours");
            return;
        }
        this.state.djBefore = { moodId: this.state.moodId, pitch: this.state.pitch, tape: { ...this.state.tape } };
        this.state.dj = true;
        this.state.pitch = DJ_PITCH;
        this.state.tape = { ...this.state.tape, wow: true };
        this.renderTape();
        void this.applyMood(DJ_MOOD, false);
        startDj();
        this.renderDj();
        this.renderAutoState();
        this.flashActivity("DJ on: full screw");
    }

    /** The next kind of record for the DJ to play this as; kept for the artist. */
    private cycleDjStyle(): void {
        if (isOff(this.djStyleButton)) return;
        const next = nextDjStyle();
        if (!next) return;
        this.renderDj();
        const artist = currentArtist();
        this.flashActivity(artist?.name ? `Playing ${artist.name} as ${PLAYED_AS[next]} from now on` : `Playing it as ${PLAYED_AS[next]}`);
    }

    /** How hard the DJ plays, 1 to 4. */
    private setDjHandLevel(level: number): void {
        const next = Math.max(1, Math.min(HANDS.length, Math.round(level)));
        if (next === this.state.djHand) return;
        this.state.djHand = next;
        saveState(this.state);
        setDjHand(next);
        this.renderDj();
        this.announceSettled(() => `Plays ${HANDS[next - 1]}`);
    }

    /** The switch, in the tagline's place what the DJ makes of the record, and the DJ's row. */
    private renderDj(): void {
        setAttr(this.djButton, "aria-checked", this.state.dj ? "true" : "false");
        setData(this.panel, "dj", this.state.dj ? "on" : "off");
        const style = djStyleName();
        setText(this.tagEl, this.state.dj ? (style ? `DJ on: full screw, ${style}` : "DJ on: full screw") : TAGLINE);
        const name = style ? style[0].toUpperCase() + style.slice(1) : "Reading it";
        const hand = `plays ${HANDS[this.state.djHand - 1]}`;
        setText(this.djStyleNameEl, name);
        setText(this.djHandEl, hand);
        setAttr(this.djStyleButton, "aria-label", style ? `${name}, ${hand}: press to play it as another kind of record` : `${name}, ${hand}`);
        setOff(this.djStyleButton, !style);
        setOff(this.handDown, this.state.djHand <= 1);
        setOff(this.handUp, this.state.djHand >= HANDS.length);
    }

    /** What the helper plays: the mood, through the tape, at the slider's pitch. */
    private sound(mood = moodById(this.state.moodId)): DspParams {
        return { ...withTape(mood.dsp, this.state.tape), pitch: this.state.pitch };
    }

    private setTape(tape: SlabState["tape"]): void {
        this.state.tape = { ...tape };
        saveState(this.state);
        this.renderTape();
        void sendDsp(this.sound());
    }

    private cleanTape(): void {
        if (isClean(this.state.tape)) {
            this.flashActivity("The tape is already clean");
            return;
        }
        this.setTape({ ...CLEAN_TAPE });
        this.flashActivity("Clean tape: the mood as it comes");
    }

    /** The tape pads stay lit while they're on, and say so to a screen reader; Room says which room it is. */
    private renderTape(): void {
        const tape = this.state.tape;
        for (const pad of this.pads) {
            const id = pad.dataset.pad;
            if (id === "room") {
                setData(pad, "latched", tape.room ? "true" : "false");
            } else if (id === "wow" || id === "hiss" || id === "crackle" || id === "crush") {
                setData(pad, "latched", tape[id] ? "true" : "false");
                setAttr(pad, "aria-pressed", tape[id] ? "true" : "false");
            }
        }
        if (this.roomSub) setText(this.roomSub, roomName(tape.room));
        if (this.cleanButton) setOff(this.cleanButton, isClean(tape));
    }

    private renderDepth(): void {
        const depth = this.state.screwDepth;
        setText(this.depthEl, `Screws ${depth} semitone${depth === 1 ? "" : "s"} down`);
        setOff(this.depthDown, depth <= SCREW_MIN);
        setOff(this.depthUp, depth >= SCREW_MAX);
    }

    /** One beat of the song where the needle is, for the echo; a 90 BPM beat with no grid. */
    private beatMs(): number {
        const grid = gridFor();
        if (!grid) return 667;
        return beatLengthMs(grid, Math.max(0, beatIndexAt(grid, needlePosition())));
    }

    /**
     * Mine: a tap keeps the sound you hear when it's empty and brings it back when it isn't; a
     * hold keeps what you hear now over what was in it. Shift+Enter does the hold from the keys.
     */
    private wireMine(button: HTMLButtonElement): void {
        let timer: number | null = null;
        let kept = false;
        const cancel = () => {
            if (timer !== null) window.clearTimeout(timer);
            timer = null;
        };
        button.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            kept = false;
            cancel();
            if (!mineMood()) return;
            timer = window.setTimeout(() => {
                timer = null;
                kept = true;
                this.saveMine(true);
            }, MINE_HOLD_MS);
        });
        for (const type of ["pointerup", "pointerleave", "pointercancel"]) button.addEventListener(type, cancel);
        this.releases.push(cancel);
        button.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" || !event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            this.saveMine(true);
        });
        button.addEventListener("click", () => {
            // The hold already kept a new sound; the click it ends with isn't a second press.
            if (kept) {
                kept = false;
                return;
            }
            if (mineMood()) {
                this.bringBackMineTape();
                void this.applyMood(MINE_ID, true);
            } else {
                this.saveMine(false);
            }
        });
    }

    /** Mine was kept with a tape: picking it puts that tape back on. */
    private bringBackMineTape(): void {
        const tape = this.state.mine?.tape;
        if (!tape) return;
        this.state.tape = { ...tape };
        this.renderTape();
    }

    /** Keeps what you hear now in Mine: this mood's curve and room, the tape, and the pitch as the slider has it. */
    private saveMine(over: boolean): void {
        const current = moodById(this.state.moodId);
        const from = current.id === MINE_ID ? (this.state.mine?.from ?? "flat") : current.id;
        const saved = { from, gains: [...current.gains], dsp: { ...current.dsp, pitch: this.state.pitch }, tape: { ...this.state.tape } };
        this.state.mine = saved;
        setMine(saved);
        this.state.moodId = MINE_ID;
        saveState(this.state);
        this.renderMine();
        this.renderMoodState();
        this.keepFollows();
        this.flashActivity(over ? "Mine holds what you hear now" : "Kept what you hear as Mine");
    }

    private renderMine(): void {
        const button = this.mineButton;
        if (!button) return;
        const mine = mineMood();
        setData(button, "empty", mine ? "false" : "true");
        button.innerHTML = mine
            ? `${pinstripe(MINE_ID)}
        <span class="slab-mood-name">Mine</span>
        <span class="slab-mood-cents">${formatCents(mine.dsp.pitch)}<span class="slab-sr"> cents</span></span>
        ${doorCurve(mine.gains)}`
            : `${pinstripe(MINE_ID)}
        <span class="slab-mood-name">Mine</span>
        <span class="slab-mood-cents">Tap to keep this sound</span>`;
        setAttr(button, "title", mine
            ? "Your own mood. Hold to keep what you hear now in its place."
            : "Keeps the mood, pitch and room you hear now as your own.");
    }

    /** The Keep door, for whoever is playing: drawn again only when the artist or what's kept changes. */
    private renderKeep(): void {
        const artist = currentArtist();
        const kept = keptFor(artist);
        const shown = `${artist?.uri ?? ""}|${artist?.name ?? ""}|${kept ? `${kept.moodId}:${kept.pitch}` : ""}`;
        if (shown === this.keepShown) return;
        this.keepShown = shown;
        setAttr(this.keepButton, "aria-pressed", kept ? "true" : "false");
        if (!artist) {
            setText(this.keepNameEl, "Keep for an artist");
            setText(this.keepSubEl, "Nobody playing to keep it for");
            setOff(this.keepButton, true);
            setAttr(this.keepButton, "title", "");
            return;
        }
        const name = artist.name || "this artist";
        setOff(this.keepButton, false);
        setText(this.keepNameEl, `Keep for ${name}`);
        setText(this.keepSubEl, kept ? `Locked on ${moodById(kept.moodId).name}` : "Locks this mood to them");
        setAttr(this.keepButton, "title", kept
            ? `${name} comes on ${moodById(kept.moodId).name} every time. Press to let it go.`
            : `Every time ${name} comes on, so does the mood you have now.`);
    }

    private toggleKeep(): void {
        if (isOff(this.keepButton)) return;
        const artist = currentArtist();
        if (!artist) return;
        const name = artist.name || "This artist";
        if (keptFor(artist)) {
            forget(artist);
            this.flashActivity(`${name} plays on whatever's on`);
        } else {
            keep(artist, this.state.moodId, this.state.pitch);
            this.flashActivity(`${name} comes on ${moodById(this.state.moodId).name} from now on`);
        }
        this.renderKeep();
    }

    /** While a mood is kept for this artist, keeping follows what you pick for them. */
    private keepFollows(): void {
        const artist = currentArtist();
        if (artist && keptFor(artist)) keep(artist, this.state.moodId, this.state.pitch);
        this.renderKeep();
    }

    /**
     * A kept artist's track: their mood goes on. Quietly at boot, said out loud on a track change.
     * While DJ mode has the record it stays on full screw, and the kept mood waits for it to go off.
     */
    private applyKept(say: boolean): void {
        if (this.state.dj) return;
        const artist: Artist | null = currentArtist();
        const kept = keptFor(artist);
        if (!artist || !kept) return;
        const id = kept.moodId === MINE_ID && !mineMood() ? "flat" : kept.moodId;
        const pitch = clampPitch(kept.pitch);
        if (id === this.state.moodId && pitch === this.state.pitch) return;
        this.state.pitch = pitch;
        if (id === MINE_ID) this.bringBackMineTape();
        void this.applyMood(id, false);
        if (say) this.flashActivity(`${moodById(id).name}, kept for ${artist.name || "this artist"}`);
    }

    private handleOutside(event: MouseEvent): void {
        if (this.panel.hidden) return;
        const target = event.target as Node | null;
        if (!target) return;
        // A pointer click that began inside (a press slid off the panel) isn't outside. A keyboard
        // click (detail 0) had no press, so a flag left by a press that never clicked can't swallow it.
        if (event.type === "click" && event.detail > 0 && this.pressedInside) {
            this.pressedInside = false;
            return;
        }
        if (this.panel.contains(target) || this.chip.contains(target)) return;
        // Play, the seek bar and volume are part of playing the deck: after a tape
        // stop the next move is Spotify's play button, so those never close it.
        // Anything that opens a menu (a right-click, devices, the queue) does, so
        // the menu isn't hidden under the panel.
        if (event.type === "click" && target instanceof Element && target.closest(TRANSPORT)) return;
        this.close();
    }

    /** Everything Tab can land on in the panel, in order, skipping what is hidden or disabled. */
    private focusables(): HTMLElement[] {
        return [...this.panel.querySelectorAll<HTMLElement>("button, input, [tabindex]")].filter(
            (node) => node.tabIndex >= 0 && !(node as HTMLInputElement).disabled && node.getClientRects().length > 0,
        );
    }

    /**
     * The panel lives at the end of the page but belongs right after the chip in
     * the tab order: Tab on the open chip goes in, Shift+Tab from the first
     * control comes back out to it, and Tab off the last control carries on to
     * whatever follows the chip in the playbar.
     */
    private handleTab(event: KeyboardEvent, from: "chip" | "panel"): void {
        if (event.key !== "Tab" || this.panel.hidden) return;
        const stops = this.focusables();
        if (!stops.length) return;
        const active = document.activeElement;
        if (from === "chip") {
            if (event.shiftKey) return;
            event.preventDefault();
            stops[0].focus({ preventScroll: true });
            return;
        }
        if (event.shiftKey && active === stops[0]) {
            event.preventDefault();
            this.chip.focus({ preventScroll: true });
        } else if (!event.shiftKey && active === stops[stops.length - 1]) {
            const next = this.stopAfterChip();
            if (!next) return;
            event.preventDefault();
            next.focus({ preventScroll: true });
        }
    }

    /** The next thing Tab would reach after the chip in the page's own order, skipping the panel and anything disabled. */
    private stopAfterChip(): HTMLElement | null {
        const all = [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")].filter(
            (node) =>
                node.tabIndex >= 0 &&
                !node.hasAttribute("disabled") &&
                !this.panel.contains(node) &&
                node.getClientRects().length > 0,
        );
        const at = all.indexOf(this.chip);
        return at >= 0 ? (all[at + 1] ?? null) : null;
    }

    private handleKey(event: KeyboardEvent): void {
        if (this.panel.hidden || event.defaultPrevented) return;
        const target = event.target as Node | null;
        // Shift+Tab from whatever follows the chip comes back into the panel, the way it left.
        if (event.key === "Tab" && event.shiftKey && target instanceof HTMLElement && target === this.stopAfterChip()) {
            const stops = this.focusables();
            if (stops.length) {
                event.preventDefault();
                stops[stops.length - 1].focus({ preventScroll: true });
            }
            return;
        }
        const inPanel = Boolean(target && (this.panel.contains(target) || this.chip.contains(target)));
        if (event.key === "Escape") {
            // Esc in Spotify's search or one of its dialogs belongs to Spotify.
            if (inPanel || target === document.body || target === document.documentElement) this.close();
            return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
        const pad = this.padByKey.get(event.key);
        if (!pad) return;
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        // A held key is one hit, not a machine gun of seeks, and a held pad stays down until it's up.
        // A dead pad still answers, with why.
        if (event.repeat) return;
        const def = this.padDefs.get(pad);
        if (!def) return;
        if (def.release) {
            this.holdDown(pad, def, `key:${event.code}`);
            return;
        }
        this.showBank(def.bank);
        this.firePad(pad, def);
    }

    /**
     * Radiogroup keys: down and right go to the next mood, up and left to the one
     * before. Picking a mood moves live pitch, so a held key doesn't sweep through
     * them and the ends don't wrap from −560 straight to +400.
     */
    private handleMoodKey(event: KeyboardEvent): void {
        // Mine is the last door once something is kept in it; an empty one is only ever tapped.
        const order = MOODS_BY_PITCH.map((mood) => mood.id);
        if (mineMood()) order.push(MINE_ID);
        const from = order.indexOf(moodById(this.state.moodId).id);
        let to: number;
        switch (event.key) {
            case "ArrowRight":
            case "ArrowDown":
                to = Math.min(order.length - 1, from + 1);
                break;
            case "ArrowLeft":
            case "ArrowUp":
                to = Math.max(0, from - 1);
                break;
            case "Home":
                to = 0;
                break;
            case "End":
                to = order.length - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        if (event.repeat || to === from) return;
        void this.applyMood(order[to], true, false);
        this.moodButtons.get(order[to])?.focus();
    }

    toggle(fromKeyboard = false): void {
        if (this.panel.hidden) this.open(fromKeyboard);
        else this.close();
    }

    /** Boot restores an open panel without taking focus; only a key press moves it. */
    open(fromKeyboard = false): void {
        this.panel.hidden = false;
        this.state.open = true;
        saveState(this.state);
        this.chip.setAttribute("aria-expanded", "true");
        // The chip's tooltip explains a closed panel; over an open one it only covers the readout.
        this.chip.removeAttribute("title");
        this.position();
        this.renderMoodState();
        this.refresh();
        // The helper may have started since the last look; don't make the user wait out the backoff.
        void probeDsp(true);
        if (fromKeyboard) {
            if (!this.pitchInput.disabled) this.pitchInput.focus({ preventScroll: true });
            else this.moodButtons.get(moodById(this.state.moodId).id)?.focus({ preventScroll: true });
        }
    }

    close(): void {
        // Focus inside the panel would otherwise fall to the document. Spotify's
        // body doesn't scroll, so focusing must never scroll it either.
        if (this.panel.contains(document.activeElement) && this.chip.isConnected) this.chip.focus({ preventScroll: true });
        // A pad held down when the panel shuts would never see its finger come up.
        this.releaseHolds();
        this.panel.hidden = true;
        this.state.open = false;
        saveState(this.state);
        this.chip.setAttribute("aria-expanded", "false");
        this.chip.setAttribute("title", CHIP_TITLE);
        this.updateSpin();
    }

    /**
     * Above the chip, then below it, then beside it, so a short window never opens
     * the panel over the button that closes it. The CSS caps height to the window.
     */
    private position(): void {
        if (this.panel.hidden) return;
        const rect = this.chip.getBoundingClientRect();
        const bar = document.querySelector('[data-testid="now-playing-bar"]')?.getBoundingClientRect();
        // The top of the playbar, or of the chip when there is no playbar to find.
        const ceiling = Math.min(rect.top, bar && bar.height > 0 && bar.top > 0 ? bar.top : rect.top) - 8;
        const room = ceiling - 8;

        // Scaled down whole, never cut: at a narrow width the right-hand pads,
        // Stop and the close button would otherwise sit off the screen.
        const fit = Math.min(1, Math.max(0.5, (window.innerWidth - 16) / PANEL_WIDTH_PX));
        if (fit < 1) this.panel.style.setProperty("scale", String(Math.floor(fit * 1000) / 1000));
        else this.panel.style.removeProperty("scale");
        // Heights below are the panel's own, before the scale; the room is the window's.
        const layoutRoom = room / fit;

        // A window with less room than the whole car gets the compact sign and
        // scrolls behind the pinned sill. The saving is added back before
        // comparing, so the choice can't flip-flop between the two layouts.
        const wasShort = this.panel.dataset.short === "true";
        const natural = this.panel.scrollHeight + (wasShort ? SHORT_SAVING_PX : 0);
        const short = layoutRoom < Math.min(PANEL_MAX_PX, natural);
        if (short !== wasShort) {
            setData(this.panel, "short", String(short));
            this.renderSign();
        }

        const width = (this.panel.offsetWidth || PANEL_WIDTH_PX) * fit;
        const maxLeft = Math.max(8, window.innerWidth - width - 8);
        let left = Math.max(8, Math.min(maxLeft, rect.right - width));
        let top: number;
        if (room >= MIN_ROOM_PX) {
            // Above the playbar, never over it: after a tape stop the next move is Spotify's play button.
            this.panel.style.maxHeight = `${Math.min(PANEL_MAX_PX, layoutRoom)}px`;
            top = ceiling - this.panel.offsetHeight * fit;
        } else {
            // No real room above: below the chip, then beside it, so it never covers the chip.
            this.panel.style.maxHeight = "";
            const height = (this.panel.offsetHeight || PANEL_MAX_PX) * fit;
            const maxTop = Math.max(8, window.innerHeight - height - 8);
            top = rect.bottom + 10;
            if (top > maxTop) {
                top = Math.max(8, Math.min(maxTop, rect.bottom - height));
                if (rect.left - width - 10 >= 8) left = rect.left - width - 10;
                else if (rect.right + 10 <= maxLeft) left = rect.right + 10;
            }
        }
        this.panel.style.left = `${Math.round(left)}px`;
        this.panel.style.top = `${Math.round(Math.max(8, top))}px`;
        this.placeBigWheel();
        this.renderScrollCue();
    }

    /** The big wheel's hub sits on Normal, the middle of the slider, wherever the layout puts it. */
    private placeBigWheel(): void {
        const rail = this.railEl;
        if (!rail.offsetParent) return;
        const x = rail.offsetLeft + railX(0);
        const y = rail.offsetTop + rail.offsetHeight / 2;
        this.bigWheelEl.style.left = `${Math.round(x - BIG_WHEEL_BOX / 2)}px`;
        this.bigWheelEl.style.top = `${Math.round(y - BIG_WHEEL_BOX / 2)}px`;
    }

    /**
     * The big wheel turns once a bar and its ring kicks on every beat. Both run
     * as compositor animations, so a busy page can't make them stutter, and the
     * beat clock only steers them: it reads the playhead, works out where the
     * wheel should be, and nudges its speed a few percent to close any gap, the
     * way a DJ rides a turntable's pitch to hold a mix. Only a real jump (a seek,
     * a new track) snaps it. Chops and loops jump whole bars, so the phase they
     * land on is the phase the wheel already has.
     */
    private turnBigWheel(grid: Grid, raw: number): void {
        if (reducedMotion()) {
            this.stopBigWheel();
            return;
        }
        const t = performance.now();
        // Follow the playhead through its steps and jitter; a jump of more than a
        // third of a second is the record actually moving.
        const clock = this.wheelClock;
        if (!clock || Math.abs(raw - (clock.pos + (t - clock.at))) > 320) {
            this.wheelClock = { pos: raw, at: t, raw };
        } else if (raw !== clock.raw) {
            const predicted = clock.pos + (t - clock.at);
            this.wheelClock = { pos: predicted + (raw - predicted) * 0.2, at: t, raw };
        }
        const steering = this.wheelTurn?.playState === "running" && this.ringKick?.playState === "running";
        if (steering && t - this.lastWheelSteer < 180) return;
        this.lastWheelSteer = t;

        const pos = (this.wheelClock as { pos: number; at: number }).pos + (t - (this.wheelClock as { at: number }).at);
        const bar = barIndexAt(grid, pos);
        if (bar < 0) return;
        const barLength = barLengthMs(grid, bar);
        if (!(barLength > 0)) return;
        this.wheelTurn ??= this.bigTurnEl.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
            duration: 1000,
            iterations: Infinity,
            easing: "linear",
        });
        this.ringKick ??= this.ringTube.gas.animate(
            [
                { opacity: 0.9, easing: "cubic-bezier(0.15, 0.7, 0.3, 1)" },
                { opacity: 0.28, offset: 0.8 },
                { opacity: 0.28 },
            ],
            { duration: 1000, iterations: Infinity },
        );
        const settling = t - this.wheelStartedAt < 1200;
        if (steer(this.wheelTurn, (pos - barStartMs(grid, bar)) / barLength, barLength, settling)) this.wheelStartedAt = t;
        const beat = beatIndexAt(grid, pos);
        const beatStart = grid.beats[beat];
        if (beatStart === undefined) return;
        const beatLength = (grid.beats[beat + 1] ?? beatStart + barLength / Math.max(1, grid.timeSignature || 4)) - beatStart;
        if (beatLength > 0) steer(this.ringKick, (pos - beatStart) / beatLength, beatLength, settling);
    }

    /** Paused, closed or no beat: the wheel stops where it is, and picks the beat up again on play. */
    private stopBigWheel(): void {
        this.wheelTurn?.pause();
        this.ringKick?.pause();
        this.wheelClock = null;
    }

    /** Only when a short window has hidden part of the panel. Writes only on change. */
    private renderScrollCue(): void {
        const hidden = this.panel.scrollHeight - this.panel.clientHeight;
        setData(this.panel, "more", hidden - this.panel.scrollTop > 2 ? "true" : "false");
        setData(this.panel, "above", this.panel.scrollTop > 2 ? "true" : "false");
    }

    private async applyMood(id: string, announce: boolean, speak = true): Promise<void> {
        this.state.moodId = id;
        const mood = moodById(id);
        // Moods are presets for the pitch slider, not a separate concept: pick
        // a mood and the slider lands on that mood's cents. Boot re-applies the
        // saved mood without announcing it, and keeps the saved slider position.
        if (announce) this.state.pitch = mood.dsp.pitch;
        saveState(this.state);
        // Picked by hand while this artist's mood is kept: the kept mood is this one now.
        if (announce) this.keepFollows();
        this.renderMoodState();
        this.renderPitch(announce);
        this.renderDsp();
        if (announce) this.strikeSign();

        // The six native filters have exactly one owner. If ModernEQ is
        // installed and the user hasn't claimed them back, SLAB leaves them be.
        if (this.slabOwnsEq()) {
            if (id === "flat") await restoreBaseline();
            else await applyCurve(mood.gains);
        }

        // The helper applies real pitch / reverb / delay. If it is not running
        // this resolves false and the mood stays EQ-only.
        void sendDsp(this.sound(mood));

        if (announce) this.flashActivity(mood.name, speak);
    }

    /** The one flourish: a neon sign catching as the gas strikes. */
    private strikeSign(): void {
        if (reducedMotion() || this.panel.hidden || this.panel.dataset.gas !== "on") return;
        this.strikeAnimation?.cancel();
        this.strikeAnimation = this.signTube.gas.animate(
            [
                { opacity: 0.1, offset: 0 },
                { opacity: 1, offset: 0.16 },
                { opacity: 0.28, offset: 0.3 },
                { opacity: 1, offset: 0.46 },
                { opacity: 1, offset: 1 },
            ],
            { duration: 420, easing: "linear" },
        );
    }

    /**
     * Pitch is the one control people actually want, so it gets a real slider.
     * Dragging fires every frame; the helper is throttled to ~90 ms of updates
     * and the last value always wins on release.
     */
    private onPitchInput(commit: boolean): void {
        const cents = Number.parseInt(this.pitchInput.value, 10);
        if (!Number.isFinite(cents)) return;
        this.state.pitch = clampPitch(cents);
        this.renderPitch();
        this.renderLit();
        this.pendingPitch = this.state.pitch;

        if (commit) {
            this.flushPitch(true);
            return;
        }
        if (this.pitchTimer !== null) return;
        this.pitchTimer = window.setTimeout(() => this.flushPitch(false), 90);
    }

    /**
     * The range's own big steps are a tenth of its travel, 240 cents, which lands
     * on no semitone. PageUp/PageDown and Shift+arrows move one semitone instead.
     */
    private onPitchKey(event: KeyboardEvent): void {
        let step = 0;
        if (event.key === "PageUp") step = 100;
        else if (event.key === "PageDown") step = -100;
        else if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowRight")) step = 100;
        else if (event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowLeft")) step = -100;
        if (!step) return;
        event.preventDefault();
        if (!this.pitchInput.disabled) this.setPitch(this.state.pitch + step, false);
    }

    private stopRoll(): void {
        if (this.rollTimer !== null) window.clearTimeout(this.rollTimer);
        this.rollTimer = null;
        delete this.railEl.dataset.rolling;
    }

    /** Nudges and Normal, which arrive as one committed value; the new pitch is said once the presses stop. */
    private setPitch(cents: number, roll: boolean): void {
        this.state.pitch = clampPitch(cents);
        this.announceSettled(() => this.pitchInput.getAttribute("aria-valuetext") ?? "");
        this.renderPitch(roll);
        this.renderLit();
        this.pendingPitch = this.state.pitch;
        this.flushPitch(true);
    }

    private flushPitch(persist: boolean): void {
        if (this.pitchTimer !== null) {
            window.clearTimeout(this.pitchTimer);
            this.pitchTimer = null;
        }
        const value = this.pendingPitch;
        this.pendingPitch = null;
        if (value === null) return;
        void sendDsp({ pitch: value });
        if (persist) {
            saveState(this.state);
            this.keepFollows();
        }
    }

    /**
     * The wheel's rotation is a function of where it sits, so it always rolls the
     * exact distance it travels, whether dragged or sent there by a mood. With
     * `roll` both moves and the bright tube ride the same CSS transition.
     */
    private renderPitch(roll = false): void {
        const cents = this.state.pitch;
        const status = dspStatus();
        const linked = status.linked;
        const applied = this.hearing().processing;

        if (this.pitchInput.value !== String(cents)) this.pitchInput.value = String(cents);
        // A native disable would drop the focus to the document.
        if (!linked && document.activeElement === this.pitchInput) this.normalButton.focus();
        if (this.pitchInput.disabled === linked) this.pitchInput.disabled = !linked;
        setOff(this.nudgeDown, !linked || cents <= -PITCH_LIMIT);
        setOff(this.nudgeUp, !linked || cents >= PITCH_LIMIT);
        setOff(this.normalButton, !linked);
        setAttr(
            this.railEl,
            "title",
            linked
                ? "Pitch shift applied to Spotify’s audio by the SLAB helper."
                : "Pitch needs the SLAB helper running. The browser cannot repitch a DRM-protected stream.",
        );

        setText(
            this.semiEl,
            !status.checked
                ? "Looking for the helper"
                : !linked
                ? "Pitch needs the helper"
                : cents === 0
                  ? "Original key"
                  : `${applied ? "" : "Set to "}${formatSemitones(cents)} ${cents < 0 ? "down" : "up"}`,
        );

        if (this.renderedCents === cents) return;
        const first = this.renderedCents === null;
        this.renderedCents = cents;

        setAttr(
            this.pitchInput,
            "aria-valuetext",
            cents === 0
                ? "Normal pitch, 0 cents"
                : `${Math.abs(cents)} cents ${cents < 0 ? "down" : "up"}, ${formatSemitones(cents)}`,
        );
        this.numberTube.set(numberLayout(cents));

        if (roll && !first && !reducedMotion()) {
            this.railEl.dataset.rolling = "true";
            if (this.rollTimer !== null) window.clearTimeout(this.rollTimer);
            this.rollTimer = window.setTimeout(() => {
                delete this.railEl.dataset.rolling;
                this.rollTimer = null;
            }, ROLL_MS + 60);
        } else if (this.rollTimer === null) {
            delete this.railEl.dataset.rolling;
        }

        const x = railX(cents) - WHEEL_SIZE / 2;
        const turned = `rotate(${((x / TYRE_RADIUS) * (180 / Math.PI)).toFixed(1)}deg)`;
        this.wheelEl.style.transform = `translateX(${x}px)`;
        this.rollEl.style.transform = turned;
        this.knockRollEl.style.transform = turned;
        const reach = Math.abs(cents) / PITCH_LIMIT;
        this.hotUp.style.transform = `scaleX(${cents > 0 ? reach : 0})`;
        this.hotDown.style.transform = `scaleX(${cents < 0 ? reach : 0})`;
        this.runUp.style.transform = this.hotUp.style.transform;
        this.runDown.style.transform = this.hotDown.style.transform;

        for (const animation of this.spinAnimations) animation.playbackRate = 2 ** (cents / 1200);
    }

    /**
     * The spokes turn only while this computer is making the sound being shifted.
     * A long-lived animation with a playback rate, so a pitch change speeds the
     * wheel up in place instead of snapping it back to the start of a turn.
     */
    private updateSpin(): void {
        if (this.disposed) return;
        const should = !this.panel.hidden && this.hearing().shifting && !reducedMotion();
        if (should === this.spinning) return;
        this.spinning = should;
        // Thirty spokes on a 12° pitch strobe backwards at speed, so they fade
        // while turning and the knock-off's ears carry the motion.
        setData(this.wheelEl, "spin", should ? "on" : "off");
        if (!should) {
            for (const animation of this.spinAnimations) animation.pause();
            return;
        }
        if (!this.spinAnimations.length) {
            const turn = [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }];
            const timing = { duration: SPIN_MS, iterations: Infinity, easing: "linear" };
            this.spinAnimations = [this.spinEl.animate(turn, timing), this.knockSpinEl.animate(turn, timing)];
            for (const animation of this.spinAnimations) animation.playbackRate = 2 ** (this.state.pitch / 1200);
        }
        for (const animation of this.spinAnimations) animation.play();
    }

    /** True when SLAB is allowed to write the six native EQ bands. */
    private slabOwnsEq(): boolean {
        if (this.state.eqOwner === "slab") return true;
        if (this.state.eqOwner === "modern") return false;
        return !this.modernEq;
    }

    private toggleEqOwner(): void {
        this.state.eqOwner = this.slabOwnsEq() ? "modern" : "slab";
        saveState(this.state);
        this.renderEqNote();
        this.renderDsp();
        if (this.slabOwnsEq()) void applyCurve(moodById(this.state.moodId).gains);
        else void this.restoreModernEqCurve();
        this.flashActivity(this.slabOwnsEq() ? "SLAB has the EQ" : "ModernEQ has the EQ");
    }

    /** Places the panel again if it's open; its height changes with the ModernEQ row. */
    private reposition(): void {
        if (!this.panel.hidden) this.position();
    }

    /** With no ModernEQ the row goes and the sill's fixed height re-centres the rest. */
    private renderEqNote(): void {
        // A user who handed the EQ to ModernEQ and then removed it still needs a way to take it back.
        if (!this.modernEq && this.state.eqOwner !== "modern") {
            // Hiding the row under a focused key would drop focus to the page; keep it on the mood.
            if (!this.eqNote.hidden && this.eqNote.contains(document.activeElement)) {
                this.moodButtons.get(moodById(this.state.moodId).id)?.focus({ preventScroll: true });
            }
            this.eqNote.hidden = true;
            if (this.sillEl) setData(this.sillEl, "eq", "off");
            this.reposition();
            return;
        }
        this.eqNote.hidden = false;
        if (this.sillEl) setData(this.sillEl, "eq", "on");
        this.reposition();
        const label = this.eqNoteButton.firstElementChild as Element;
        if (this.slabOwnsEq()) {
            setText(this.eqNoteText, "SLAB has the EQ.");
            setText(label, "Use ModernEQ");
        } else {
            setText(this.eqNoteText, "ModernEQ has the EQ.");
            setText(label, "Use SLAB EQ");
        }
    }

    /**
     * Hand the bands back with the curve ModernEQ last saved. With no saved
     * curve, put back the user's own, so SLAB's mood isn't left on the filters
     * while the sill says SLAB isn't changing the sound.
     */
    private async restoreModernEqCurve(): Promise<void> {
        const bands = modernEqBands();
        if (bands) await applyCurveAtFrequencies(bands);
        else await restoreBaseline();
    }

    /** ModernEQ can appear after SLAB does; re-check slowly, not every tick. */
    private refreshEqOwner(): void {
        const now = Date.now();
        if (now - this.lastEqCheck < 2_000) return;
        this.lastEqCheck = now;

        const present = modernEqPresent();
        if (present === this.modernEq) return;
        this.modernEq = present;
        this.renderEqNote();
        this.renderDsp();
        if (this.slabOwnsEq()) void applyCurve(moodById(this.state.moodId).gains);
        else void this.restoreModernEqCurve();
    }

    /**
     * The parameters the helper is running: what it has confirmed, by answering
     * a POST or in its own status, so a POST that didn't land never shows as
     * playing. Fields a helper doesn't report fall back to what SLAB sent;
     * syncDspParams() gets the panel's values through when they drift.
     */
    private helperParams(): { pitch: number; reverb: number; delayMix: number; lowpass: number } {
        const sent = this.sound();
        const got = dspStatus().params ?? {};
        const pick = (key: "pitch" | "reverb" | "delayMix" | "lowpass"): number => {
            const value = got[key];
            return typeof value === "number" && Number.isFinite(value) ? value : sent[key];
        };
        return { pitch: pick("pitch"), reverb: pick("reverb"), delayMix: pick("delayMix"), lowpass: pick("lowpass") };
    }

    private helperEffects(): string[] {
        const running = this.helperParams();
        return [
            ...(Math.abs(running.pitch) >= 1 ? ["pitch"] : []),
            ...(running.reverb > 0 ? ["reverb"] : []),
            ...(running.delayMix > 0 ? ["delay"] : []),
            ...(running.lowpass < 20_000 ? ["low-pass"] : []),
            ...(this.helperTape() ? ["tape"] : []),
        ];
    }

    /** The tape is running: a helper that plays it has a layer on, by what it confirmed or was sent. */
    private helperTape(): boolean {
        const status = dspStatus();
        if (status.tape !== true) return false;
        const sent = this.sound();
        const got = status.params ?? {};
        return (["wow", "hiss", "crackle", "crush"] as const).some((key) => {
            const value = got[key];
            return (typeof value === "number" && Number.isFinite(value) ? value : sent[key]) > 0;
        });
    }

    /**
     * What can be heard right now, decided in one place so the sign, the chip,
     * the tube, the wheel and the sill can never tell different stories. The EQ
     * and the tap both only reach audio on this computer. The EQ half counts when
     * there is an EQ, SLAB owns it and the mood isn't Flat; the helper half counts
     * while audio is flowing through it and it is changing something.
     */
    private hearing(): { remote: string | null; processing: boolean; shifting: boolean; audible: boolean } {
        const status = dspStatus();
        const remote = remoteDeviceName();
        const processing =
            !remote && status.linked && status.tapping === true && status.audio === true && isPlaying();
        const eq = !remote && eqAvailable() && this.slabOwnsEq() && this.state.moodId !== "flat";
        const helper = processing && this.helperEffects().length > 0;
        // Paused, nothing is heard, whatever the EQ is set to.
        const shifting = processing && Math.abs(this.helperParams().pitch) >= 1;
        return { remote, processing, shifting, audible: isPlaying() && (eq || helper) };
    }

    /**
     * The sign and the chip are lit only while the mood can be heard. The pitch
     * tube, its number and the wheel's spin say the same about pitch: lit and
     * turning only while the helper is actually shifting it, warm idle glass
     * while the helper is ready with nothing to shift. The paint only goes when
     * the sound has left the room.
     */
    private renderLit(): void {
        const { remote, shifting, audible } = this.hearing();
        const mood = moodById(this.state.moodId);
        setData(this.panel, "primer", remote ? "true" : "false");
        setData(this.panel, "gas", audible ? "on" : "off");
        setData(this.panel, "tube", remote || !dspStatus().linked ? "off" : shifting ? "on" : "idle");
        setData(this.chip, "remote", remote ? "true" : "false");
        setData(this.chip, "on", audible ? "true" : "false");
        // A curve SLAB isn't allowed to apply is drawn as a dashed sketch, not as the real thing.
        setData(this.panel, "eq", eqAvailable() && this.slabOwnsEq() ? "slab" : "other");
        setAttr(
            this.chip,
            "aria-label",
            remote
                ? `SLAB playback moods. Spotify is playing on ${remote}, so SLAB isn’t heard.`
                : audible
                  ? `SLAB playback moods, ${mood.name}${this.state.pitch !== 0 ? `, ${formatSemitones(this.state.pitch)} ${this.state.pitch < 0 ? "down" : "up"}` : ""} on`
                  : mood.id === "flat"
                    ? "SLAB playback moods, Flat"
                    : `SLAB playback moods, ${mood.name} picked but not heard right now`,
        );
    }

    /** The panel states what is true now, including the cases where SLAB is doing nothing audible. */
    private renderDsp(): void {
        const remote = remoteDeviceName();
        this.renderLit();

        this.deadRemote = remote;
        if (remote) {
            setText(this.deadWhereEl, `Playing on ${deviceSentence(remote)}`);
            setAttr(this.deadEl, "title", `Playing on ${remote}. Moods, pitch and effects apply when Spotify plays here.`);
            this.deadEl.hidden = false;
        } else {
            this.deadEl.hidden = true;
            setText(this.deadWhereEl, "");
            this.deadEl.removeAttribute("title");
        }
        this.renderSign();
        this.renderHelperLine();
        this.renderPitch();
        this.updateSpin();
    }

    /** What the helper is doing, built from what it reports and what was sent to it. */
    private helperLine(): { state: string; text: string; title: string } {
        const status = dspStatus();
        if (remoteDeviceName()) {
            return {
                state: "remote",
                text: status.linked ? "Helper has nothing to process until this computer plays." : "Helper isn’t running.",
                title: "The EQ and the helper only touch audio on this computer.",
            };
        }
        if (!status.checked) {
            return {
                state: "checking",
                text: "Looking for the helper.",
                title: "Checking whether the SLAB helper is running on this computer.",
            };
        }
        if (!status.linked) {
            const shaping = eqAvailable() && this.slabOwnsEq() && this.state.moodId !== "flat";
            return {
                state: "offline",
                text: shaping
                    ? "Helper isn’t running, so SLAB only shapes the EQ."
                    : !eqAvailable()
                      ? "No helper and no EQ here, so SLAB can’t change the sound."
                      : this.state.moodId === "flat" && this.slabOwnsEq()
                        ? "Helper isn’t running. Flat leaves your EQ as it was."
                        : "Helper isn’t running, so SLAB isn’t changing the sound.",
                title: "Run the SLAB helper to get real pitch, reverb and delay. Without it SLAB only shapes the native EQ.",
            };
        }
        if (!status.tapping) {
            return {
                state: "waiting",
                text: "Helper is waiting for Spotify to open an audio stream.",
                title: "The SLAB helper is running and will attach as soon as Spotify opens an audio stream.",
            };
        }
        if (!status.audio || !isPlaying()) {
            const paused = !isPlaying();
            return {
                state: paused ? "paused" : "silent",
                text: paused ? "Helper is attached. Spotify is paused." : "Helper is attached. No audio coming through yet.",
                title: "The SLAB helper is attached to Spotify and nothing is playing here.",
            };
        }
        const behind = typeof status.latencyMs === "number" ? `, ${Math.round(status.latencyMs)} ms behind` : "";
        const effects = this.helperEffects();
        const doing =
            effects.length === 0
                ? "live and dry"
                : effects.length === 1 && effects[0] === "pitch"
                  ? "shifting pitch"
                  : `running ${listWords(effects)}`;
        return {
            state: "live",
            text: `Helper is ${doing}${behind}.`,
            title: "The SLAB helper is running and processing Spotify’s audio.",
        };
    }

    /** Runs from the refresh loop so the latency and the mood can't go stale. */
    private renderHelperLine(): void {
        const { state, text, title } = this.helperLine();
        setText(this.helperEl, text);
        setAttr(this.helperEl, "title", title);
        // The first answer after boot is not news; changes after that are.
        const quiet = (name: string | null) => name === "live" || name === "paused" || name === "silent";
        if (this.lastHelperState !== null && this.lastHelperState !== "checking" && this.lastHelperState !== state && !(quiet(this.lastHelperState) && quiet(state))) {
            this.announce(text);
        }
        this.lastHelperState = state;
    }

    /** For values a held button steps through: speak only the one it stops on, read when it stops. */
    private announceSettled(text: () => string): void {
        if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
        this.settleTimer = window.setTimeout(() => {
            this.settleTimer = null;
            this.announce(text());
        }, 500);
    }

    /** Emptied first, so the same words twice (two chops in a row) are still spoken twice. */
    private announce(text: string): void {
        this.statusEl.textContent = "";
        if (this.announceTimer !== null) window.clearTimeout(this.announceTimer);
        this.announceTimer = window.setTimeout(() => {
            this.announceTimer = null;
            this.statusEl.textContent = text;
        }, 40);
    }

    /** Playback can move to another device at any moment, and a screen reader hears it go and come back. */
    private refreshConnect(): void {
        const remote = remoteDeviceName();
        if (remote === this.lastRemote) return;
        const before = this.lastRemote;
        this.lastRemote = remote;
        this.renderDsp();
        if (remote) this.announce(`Playing on ${deviceSentence(remote)} SLAB only reaches this computer.`);
        else if (before) this.announce("Spotify is playing on this computer again.");
    }

    private renderMoodState(): void {
        const mood = moodById(this.state.moodId);
        for (const [id, button] of this.moodButtons) {
            const selected = id === mood.id;
            setAttr(button, "aria-checked", selected ? "true" : "false");
            // Roving tabindex: the group is one tab stop, on the selected radio.
            setAttr(button, "tabindex", selected ? "0" : "-1");
        }
        for (const [cents, clip] of this.moodClips) {
            setData(clip, "lit", cents === mood.dsp.pitch ? "true" : "false");
        }
        for (const [cents, foot] of this.moodFeet) {
            setData(foot, "lit", cents === mood.dsp.pitch ? "true" : "false");
        }
        this.renderSign();
        setAttr(this.signEl, "aria-label", `Mood: ${mood.name}`);
        setText(this.subEl, capitalise(mood.sub));
        this.renderLit();
    }

    /**
     * "Playing on …" keeps to its one line: a long device name is cut back a word
     * at a time until it fits, so the line under it is never the one pushed out,
     * at any text spacing. The full name stays in the title and the chip's name.
     * A hidden panel measures nothing; opening it renders again.
     */
    private fitDeadLine(): void {
        const remote = this.deadRemote;
        if (!remote || this.deadEl.hidden) return;
        const where = this.deadWhereEl;
        let max = DEVICE_NAME_MAX;
        setText(where, `Playing on ${deviceSentence(remote, max)}`);
        while (max > 8 && where.offsetHeight > DEAD_LINE_PX * 1.5) {
            max -= 4;
            setText(where, `Playing on ${deviceSentence(remote, max)}`);
        }
    }

    /**
     * The tube keeps its gauge at any size; a message that wraps to two lines gets
     * the sign's lower part. Measured, not counted, so a fallback font or a narrow
     * name can't fool it. A hidden panel measures nothing, and opening it renders again.
     */
    private renderSign(): void {
        this.fitDeadLine();
        const mood = moodById(this.state.moodId);
        const compact =
            this.panel.dataset.short === "true" ||
            (!this.deadEl.hidden && this.deadEl.scrollHeight > DEAD_LINE_PX * 1.5);
        setData(this.panel, "compact", compact ? "true" : "false");
        this.signTube.set(signLayout(mood.id, mood.name, compact ? COMPACT_SIGN_HEIGHT : SIGN_HEIGHT));
        // A compact sign moves the slider up, and the wheel's hub with it.
        this.placeBigWheel();
    }

    private toggleAuto(): void {
        // It can always be switched off; with no beat grid it has nothing to count, so it won't go on.
        if (!this.state.auto && !gridFor()) {
            this.flashActivity("Auto chop needs a beat grid, and this track has none.");
            return;
        }
        this.state.auto = !this.state.auto;
        saveState(this.state);
        this.renderAutoState();
        this.flashActivity(this.state.auto ? "Auto chop on" : "Auto chop off");
    }

    private setEvery(every: number): void {
        const next = Math.max(EVERY_MIN, Math.min(EVERY_MAX, every));
        if (next === this.state.every) return;
        this.state.every = next;
        saveState(this.state);
        this.renderAutoState();
        this.announceSettled(() => `Every ${next} bar${next === 1 ? "" : "s"}`);
    }

    private renderAutoState(): void {
        const every = this.state.every;
        setAttr(this.switchEl, "aria-checked", String(this.state.auto));
        setData(this.panel, "auto", this.state.auto ? "on" : "off");
        this.renderEvery();
        setOff(this.everyDown, every <= EVERY_MIN);
        setOff(this.everyUp, every >= EVERY_MAX);
        setAuto(this.state.auto && !this.state.dj, every);
    }

    /** "Every 4 bars", and while auto chop runs, how far off the next cut is, so it can be played to. */
    private renderEvery(): void {
        const every = this.state.every;
        const base = `Every ${every} bar${every === 1 ? "" : "s"}`;
        const grid = gridFor();
        const ahead = this.state.auto && grid && isPlaying() ? autoBarsAhead(barIndexAt(grid, progressMs())) : null;
        setText(this.everyEl, ahead === null ? base.toLowerCase() : `every ${every}, ${ahead === 1 ? "next bar" : `next in ${ahead}`}`);
    }

    /**
     * What a press just did, said right above the pads in the ruler's place for
     * a moment, so the answer lands where the hand is. Nothing else moves. What
     * plays on its own (the DJ, auto chop) waits behind the answer to a press for
     * a moment, so the answer is read.
     */
    private flashActivity(text: string, speak = true, onItsOwn = false): void {
        if (onItsOwn && Date.now() - this.answeredAt < ANSWER_HOLD_MS) return;
        if (!onItsOwn) this.answeredAt = Date.now();
        this.flashEl.textContent = text;
        setData(this.panel, "flash", "true");
        if (speak) this.announce(text);
        if (this.activityTimer !== null) window.clearTimeout(this.activityTimer);
        this.activityTimer = window.setTimeout(() => {
            this.activityTimer = null;
            this.flashEl.textContent = "";
            setData(this.panel, "flash", "false");
        }, 1800);
    }

    /**
     * Pads and nudges act on the way down, like hardware: pointerdown for the
     * mouse, keydown for Enter and Space. A click with no pointer behind it, from
     * a screen reader or the number keys, still works. With `repeat`, holding
     * keeps it going, after a pause long enough that a tap stays a tap.
     */
    private press(button: HTMLButtonElement, action: (event: Event) => void, repeat = false): void {
        let downAt = 0;
        let holdTimer: number | null = null;
        const release = () => {
            if (holdTimer !== null) window.clearTimeout(holdTimer);
            holdTimer = null;
        };
        const hold = (event: Event, delay: number) => {
            holdTimer = window.setTimeout(() => {
                if (isOff(button)) return release();
                action(event);
                hold(event, 70);
            }, delay);
        };
        button.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            // A pad is hit, not selected: focus and the caret stay where they were.
            event.preventDefault();
            downAt = Date.now();
            action(event);
            if (repeat) {
                release();
                hold(event, 420);
            }
        });
        for (const type of ["pointerup", "pointerleave", "pointercancel"]) button.addEventListener(type, release);
        button.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat && !repeat) return;
            action(event);
        });
        button.addEventListener("keyup", (event) => {
            if (event.key === " ") event.preventDefault();
        });
        button.addEventListener("click", (event) => {
            event.stopPropagation();
            if (event.detail === 0 && Date.now() - downAt > 400) action(event);
        });
        this.releases.push(release);
    }

    /** A pad played by hand: DJ mode steps back for eight bars, and learns where you play. */
    private handPlayed(def: PadDef): void {
        this.lastManualAt = Date.now();
        // The tape is set and left, not played: it leaves the record with the DJ.
        if (def.bank !== "tape") djYield(isMove(def.id) ? def.id : undefined);
    }

    /** Lights the pad only when the edit actually happened, and says why when it couldn't. */
    private firePad(pad: HTMLButtonElement, def: PadDef): void {
        if (isOff(pad)) {
            this.flashActivity(def.available ? (def.unavailable?.() ?? NEEDS_HELPER) : NO_GRID);
            return;
        }
        this.handPlayed(def);
        void Promise.resolve(def.run()).then((ran) => {
            if (this.disposed) return;
            if (ran) this.hitPad(pad);
            else if (def.miss) this.flashActivity(def.miss);
        });
    }

    /** A hit lights the pad with the sign's gas for a moment. */
    private hitPad(pad: HTMLButtonElement | undefined): void {
        if (!pad) return;
        pad.dataset.hit = "true";
        const running = this.padTimers.get(pad);
        if (running !== undefined) window.clearTimeout(running);
        this.padTimers.set(pad, window.setTimeout(() => {
            delete pad.dataset.hit;
            this.padTimers.delete(pad);
        }, 180));
    }

    /**
     * The helper can restart with neutral parameters, and a linked/unlinked
     * transition is not guaranteed to be observed. Compare what it reports
     * against the selected mood and correct it, throttled.
     */
    private syncDspParams(): void {
        const status = dspStatus();
        if (!status.linked) return;
        const now = Date.now();
        if (now - this.lastDspSync < 3_000) return;

        // The slider is authoritative; the mood and the tape supply the other params.
        const want = this.sound();
        const have = status.params ?? {};
        // A helper from before tape doesn't report it; asking again wouldn't change that.
        const tapeDrift = status.tape === true && (["wow", "hiss", "crackle", "crush"] as const).some(
            (key) => Math.abs((have[key] ?? 0) - want[key]) > 0.01,
        );
        const drifted =
            Math.abs((have.pitch ?? 0) - want.pitch) > 1 ||
            Math.abs((have.reverb ?? 0) - want.reverb) > 1 ||
            Math.abs((have.lowpass ?? 20_000) - want.lowpass) > 50 ||
            tapeDrift;
        if (!drifted) return;

        this.lastDspSync = now;
        void sendDsp(want);
    }

    private async syncGrid(force = false): Promise<void> {
        const uri = Spicetify.Player.data?.item?.uri;
        if (!uri) return;
        // A failed analysis fetch must not poison the track: if there is still
        // no grid for this URI, try again instead of trusting lastGridUri.
        if (!force && uri === this.lastGridUri && gridFor(uri)) return;
        if (uri !== this.lastGridUri) this.gridMisses = 0;
        this.lastGridUri = uri;
        this.lastGridAttempt = Date.now();
        const grid = await loadGrid(uri);
        if (this.disposed) return;
        if (uri === this.lastGridUri) this.gridMisses = grid ? 0 : this.gridMisses + 1;
        this.refresh();
    }

    /**
     * Analysis can fail on the first try (player not hydrated, network hiccup),
     * so a missing grid is fetched again: after 5 s, 30 s and 2 min, then left
     * alone until the track changes. A track that changed without a songchange
     * event is picked up here too.
     */
    private retryGrid(): void {
        const uri = Spicetify.Player.data?.item?.uri;
        if (!uri || gridFor(uri)) return;
        if (uri !== this.lastGridUri) {
            void this.syncGrid();
            return;
        }
        const wait = GRID_RETRY_MS[this.gridMisses - 1];
        if (wait !== undefined && Date.now() - this.lastGridAttempt > wait) void this.syncGrid(true);
    }

    /**
     * One tick per real bar at its real time, a taller one on every phrase line
     * (every N bars, the count auto chop cuts on), closing on the track's end. A track too long for that at two pixels a tick draws every
     * fourth bar instead, or every sixteenth, and the title says so.
     */
    private buildRuler(grid: Grid): void {
        const phrase = Math.max(1, this.state.every);
        const key = `${grid.uri}:${grid.bars.length}:${phrase}`;
        if (key === this.rulerKey) return;
        this.rulerKey = key;
        this.rulerBar = -2;
        const span = grid.durationMs || grid.bars[grid.bars.length - 1] || 1;
        let every = 1;
        while ((RULER_WIDTH / grid.bars.length) * every < 2) every *= 4;
        let d = "";
        grid.bars.forEach((start, index) => {
            if (index % every !== 0) return;
            const x = Math.min(RULER_WIDTH - 0.5, Math.round((start / span) * (RULER_WIDTH - 1)) + 0.5);
            d += `M${x} ${index % phrase === 0 ? 1 : 7}V14`;
        });
        d += `M${RULER_WIDTH - 0.5} 1V14`;
        setAttr(this.rulerEl, "title", every > 1 ? `One tick for every ${every} bars on a track this long.` : "");
        this.rulerDim.setAttribute("d", d);
        this.rulerLit.setAttribute("d", d);
    }

    private setLampCount(count: number): void {
        if (this.lamps.length === count) return;
        this.lamps = [];
        this.lampsEl.textContent = "";
        for (let i = 0; i < count; i++) {
            const lamp = h("i");
            this.lamps.push(lamp);
            this.lampsEl.append(lamp);
        }
    }

    private renderLamps(active: number): void {
        this.lamps.forEach((lamp, index) => setData(lamp, "on", index === active ? "true" : "false"));
    }

    private refresh(): void {
        if (this.disposed) return;
        // How much record has played unbroken, for the helper's chops, is watched open or closed.
        watchNeedle();
        // Probe even when the panel is closed: if the helper starts or restarts,
        // the selected mood needs to reach it without waiting for a click.
        void probeDsp(false, !this.panel.hidden);

        this.retryGrid();
        this.syncDspParams();
        this.refreshEqOwner();
        this.refreshConnect();
        // Pausing changes what can be heard, so it relights the sign, tube and wheel.
        const playingNow = isPlaying();
        if (playingNow !== this.lastPlaying) {
            this.lastPlaying = playingNow;
            this.renderDsp();
        }
        // Cheap and write-on-change, so nothing lit can outlive what is heard by more than a tick.
        this.renderLit();
        this.updateSpin();
        if (!playingNow || this.panel.hidden) this.stopBigWheel();

        if (this.panel.hidden) return;

        this.renderHelperLine();
        const playing = isPlaying();
        setData(this.panel, "playing", playing ? "true" : "false");
        setText(this.playEl, playing ? "Playing" : "Paused");

        const grid = gridFor();
        setData(this.panel, "grid", grid ? "true" : "false");
        if (!grid) {
            setText(this.bpmEl, "–");
            setText(this.barEl, "Bar –");
            setText(this.noGridEl, NO_GRID);
            setAttr(this.lampsEl, "aria-label", "No beat");
            this.setLampCount(4);
            this.renderLamps(-1);
        } else {
            setText(this.bpmEl, grid.tempo > 0 ? grid.tempo.toFixed(1) : "–");
            setText(this.noGridEl, "");
            this.renderBeat(grid);
        }

        const speed = this.speedInfo();
        setText(this.speedEl, speed.text);
        setAttr(this.speedEl, "title", speed.hint);

        for (const pad of this.pads) {
            const def = this.padDefs.get(pad);
            // The holds and the tape need the helper and nothing else; everything else but Stop needs the grid.
            const off = def?.available ? !def.available() : pad.dataset.pad !== "stop" && !grid;
            setOff(pad, off);
            if (off && !def?.available) setAttr(pad, "aria-describedby", "slab-nogrid");
            else if (pad.hasAttribute("aria-describedby")) pad.removeAttribute("aria-describedby");
            setAttr(pad, "title", off && def?.available ? (def.unavailable?.() ?? NEEDS_HELPER) : "");
        }
        this.renderKeep();
        this.renderDj();
        this.renderEvery();
        // A running loop keeps its pad lit and counts down on it, through the last pass.
        const left = loopRemaining();
        const looping = isLooping();
        const loopPad = this.pads.find((pad) => pad.dataset.pad === "loop");
        if (loopPad) setData(loopPad, "latched", looping ? "true" : "false");
        if (this.loopSub) setText(this.loopSub, !looping ? LOOP_SUB : left > 0 ? `${left} to go` : "Last pass");
        // Off with nothing to count; it can still be switched off if it was on.
        const autoOff = (!grid && !this.state.auto) || this.state.dj;
        setOff(this.switchEl, autoOff);
        if (autoOff) setAttr(this.switchEl, "aria-describedby", "slab-nogrid");
        else if (this.switchEl.hasAttribute("aria-describedby")) this.switchEl.removeAttribute("aria-describedby");

        if (playing && grid && this.lampFrame === null) this.lampFrame = window.requestAnimationFrame(() => this.tickBeat());
    }

    /** Bar, beat lamps and ruler, from where the record actually is. */
    private renderBeat(grid: Grid): void {
        const progress = progressMs();
        const bar = barIndexAt(grid, progress);
        const beat = beatIndexAt(grid, progress);
        const beatsPerBar = Math.max(1, grid.timeSignature || 4);
        // Counted from this bar's own first beat, so a pickup or a dropped beat
        // earlier in the track can't push every later downbeat onto lamp two.
        const firstBeat = beatIndexAt(grid, (grid.bars[Math.max(0, bar)] ?? 0) + 30);
        const beatInBar = Math.max(0, Math.min(beatsPerBar - 1, beat - firstBeat));

        setText(this.barEl, `Bar ${Math.max(1, bar + 1)} of ${barCount(grid)}`);
        this.setLampCount(Math.min(7, beatsPerBar));
        this.renderLamps(beatInBar);
        setAttr(this.lampsEl, "aria-label", `Beat ${beatInBar + 1} of ${beatsPerBar}`);

        this.turnBigWheel(grid, progress);
        this.buildRuler(grid);
        if (bar !== this.rulerBar) {
            this.rulerBar = bar;
            const span = grid.durationMs || 1;
            const start = grid.bars[Math.max(0, bar)] ?? 0;
            const lit = bar < 0 ? 0 : Math.min(RULER_WIDTH, Math.round((start / span) * (RULER_WIDTH - 1)) + 1);
            this.rulerClip.style.clipPath = `inset(0 ${RULER_WIDTH - lit}px 0 0)`;
        }
    }

    /**
     * While the panel is open and the record is playing, the lamps follow the
     * beat every frame instead of every tenth of a second, so a lamp is never a
     * hundred milliseconds late. Writes still only happen when a lamp changes.
     */
    private tickBeat(): void {
        this.lampFrame = null;
        if (this.disposed || this.panel.hidden || !isPlaying()) {
            this.stopBigWheel();
            return;
        }
        const grid = gridFor();
        if (!grid) {
            this.stopBigWheel();
            return;
        }
        this.renderBeat(grid);
        this.renderEvery();
        this.lampFrame = window.requestAnimationFrame(() => this.tickBeat());
    }

    /**
     * The speed lock only explains anything while the helper is absent. With the
     * helper live, tempo staying put is the README's business, not a line that
     * sits on the sill all day.
     */
    private speedInfo(): SpeedInfo {
        const dsp = dspStatus();
        const remote = remoteDeviceName();
        if (!dsp.checked || dsp.linked || remote) return { text: "", hint: "" };

        const api = Spicetify.Platform.PlayerAPI;
        const capabilities = typeof api.getCapabilities === "function" ? api.getCapabilities() : null;
        const state = api.getState();
        const reasons = state?.restrictions?.disallowSettingPlaybackSpeedReasons ?? [];

        if (capabilities && !capabilities.canChangeSpeed) {
            return {
                text: "This client has no playback speed control.",
                hint: "This client does not expose playback speed.",
            };
        }
        if (reasons.length > 0) {
            const reason = String(reasons[0]);
            return {
                text: reason === "unknown" ? "Spotify locks playback speed for music." : `Speed is locked: ${reason.replace(/_/g, " ")}.`,
                hint: "Spotify blocks playback speed for music on this build. SLAB shapes tone and edits instead.",
            };
        }
        if (!capabilities) return { text: "", hint: "" };
        return {
            text: "This build allows playback speed.",
            hint: "This build allows playback speed.",
        };
    }
}
