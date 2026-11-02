import { chopBars, loopBars, onChop, resetForTrack, setAuto, tapeStop } from "../core/chops";
import { dspStatus, dspTapeStop, onDspChange, probeDsp, sendDsp } from "../core/dsp";
import { applyCurve, applyCurveAtFrequencies, restoreBaseline } from "../core/eq";
import {
    barCount,
    barIndexAt,
    beatIndexAt,
    gridFor,
    loadGrid,
} from "../core/grid";
import { modernEqBands, modernEqPresent } from "../core/moderneq";
import { MOODS, curvePath, moodById } from "../core/moods";
import { saveState } from "../core/state";
import type { Grid, SlabState } from "../types";
import { CHIP_ICON, CLOSE_ICON, EMBLEM, SILL_SCREWS, TYRE_RADIUS, WHEEL_SIZE, WHEEL_SPIN, WHEEL_STATIC } from "./art";
import { NUMBER_HEIGHT, NUMBER_WIDTH, SIGN_HEIGHT, SIGN_WIDTH, numberLayout, signLayout } from "./neon";
import type { TubeLayout } from "./neon";
import { CSS, STYLE_ID } from "./styles";

type Props = Record<string, unknown>;

const PITCH_LIMIT = 1200;
const EVERY_MIN = 1;
const EVERY_MAX = 16;
const DEVICE_NAME_MAX = 56;
/** Longer than this, the dead-sign message takes two lines and the sign makes room. */
const DEAD_LINE_CHARS = 58;
/** The sign's height when it shares its bay with two lines of message. */
const COMPACT_SIGN_HEIGHT = 50;

/** One rotation of the spokes at normal pitch. */
const SPIN_MS = 1600;
/** Keep in step with the transition in styles.ts. */
const ROLL_MS = 640;
const TAGLINE = "Slow, loud and bangin’";

/** Pixels per cent. The track is laid out so 100 cents is exactly 12 px. */
const PX_PER_CENT = 12 / 100;
const RAIL_WIDTH = WHEEL_SIZE + PX_PER_CENT * PITCH_LIMIT * 2;
const RULER_WIDTH = 360;
/** The native thumb is the tyre, so a click past the tyre lands where it was aimed. */
const THUMB_SIZE = TYRE_RADIUS * 2;

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
function deviceSentence(name: string): string {
    if (name.length <= DEVICE_NAME_MAX) return `${name}.`;
    const cut = name.slice(0, DEVICE_NAME_MAX);
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

function reducedMotion(): boolean {
    try {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
        return false;
    }
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

function progressMs(): number {
    try {
        return Spicetify.Player?.getProgress?.() ?? 0;
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

/** Display order only: highest landing pitch first, so position means something. */
const MOODS_BY_PITCH = [...MOODS].sort(
    (a, b) => b.dsp.pitch - a.dsp.pitch || Number(b.id === "flat") - Number(a.id === "flat"),
);

/**
 * One length of neon. Glass, paint-out and electrodes sit in one svg; the gas
 * sits in its own, so a strike only changes the opacity of a composited layer
 * and never repaints the glow.
 */
class Tube {
    readonly node: HTMLDivElement;
    readonly gas: SVGSVGElement;
    private layers: Record<"shadow" | "shadowWide" | "dark" | "boots" | "bootsHi" | "frost" | "frostHi" | "bloom" | "halo" | "glass" | "core", SVGPathElement>;
    private current = "";

    constructor(className: string, width: number, height: number) {
        const box = `viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true" focusable="false"`;
        this.node = h("div", {
            class: `slab-tube ${className}`,
            html: `
<svg class="slab-tube-glass" ${box}>
  <g class="slab-tube-cast"><path data-l="shadowWide"/><path data-l="shadow"/></g>
  <path data-l="dark"/><path data-l="boots"/><path data-l="bootsHi"/>
  <g class="slab-tube-frosted"><path data-l="frost"/><path data-l="frostHi"/></g>
</svg>
<svg class="slab-tube-gas" ${box}>
  <path data-l="bloom"/><path data-l="halo"/><path data-l="glass"/><path data-l="core"/>
</svg>`,
        });
        const find = (name: string) => this.node.querySelector(`[data-l="${name}"]`) as SVGPathElement;
        this.layers = {
            shadow: find("shadow"),
            shadowWide: find("shadowWide"),
            dark: find("dark"),
            boots: find("boots"),
            bootsHi: find("bootsHi"),
            frost: find("frost"),
            frostHi: find("frostHi"),
            bloom: find("bloom"),
            halo: find("halo"),
            glass: find("glass"),
            core: find("core"),
        };
        this.gas = this.node.querySelector(".slab-tube-gas") as SVGSVGElement;
    }

    set(layout: TubeLayout): void {
        if (layout.lit === this.current) return;
        this.current = layout.lit;
        const { shadow, shadowWide, dark, boots, bootsHi, frost, frostHi, bloom, halo, glass, core } = this.layers;
        const all = layout.lit + layout.dark;
        shadow.setAttribute("d", all);
        shadowWide.setAttribute("d", all);
        dark.setAttribute("d", layout.dark);
        boots.setAttribute("d", layout.boots);
        bootsHi.setAttribute("d", layout.boots);
        for (const path of [frost, frostHi, bloom, halo, glass, core]) path.setAttribute("d", layout.lit);
    }
}

interface SpeedInfo {
    text: string;
    hint: string;
}

export class Deck {
    private state: SlabState;
    private chip: HTMLButtonElement;
    private panel: HTMLDivElement;
    private moodButtons = new Map<string, HTMLButtonElement>();

    private tagEl: HTMLSpanElement;
    private signTube: Tube;
    private signEl: HTMLDivElement;
    private subEl: HTMLParagraphElement;
    private deadEl: HTMLParagraphElement;

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
    private lastHelperState: string | null = null;

    private disposed = false;
    private disposeDsp: (() => void) | null = null;
    private refreshTimer: number | null = null;
    private chipTimer: number | null = null;
    private activityTimer: number | null = null;
    private rollTimer: number | null = null;
    private lastGridUri: string | null = null;
    private lastGridAttempt = 0;
    private lastDspSync = 0;
    private pitchTimer: number | null = null;
    private pendingPitch: number | null = null;
    private renderedCents: number | null = null;
    private spinAnimation: Animation | null = null;
    private strikeAnimation: Animation | null = null;
    private spinning = false;
    private modernEq = false;
    private lastEqCheck = 0;
    private lastRemote: string | null = null;
    private onDocumentClick = (event: MouseEvent) => this.handleOutside(event);
    private onKey = (event: KeyboardEvent) => this.handleKey(event);
    private onResize = () => this.position();
    private onScroll = () => this.renderScrollCue();

    constructor(state: SlabState) {
        this.state = state;
        this.chip = this.buildChip();

        this.tagEl = h("span", { class: "slab-tag" }, TAGLINE);
        this.signTube = new Tube("slab-sign-tube", SIGN_WIDTH, SIGN_HEIGHT);
        this.signEl = h("div", { class: "slab-sign", role: "img" }, this.signTube.node);
        this.subEl = h("p", { class: "slab-sub" });
        this.deadEl = h("p", { class: "slab-dead", "aria-live": "polite" });

        this.numberTube = new Tube("slab-number-tube", NUMBER_WIDTH, NUMBER_HEIGHT);
        this.semiEl = h("span", { class: "slab-semi" });
        this.nudgeDown = h("button", {
            class: "slab-press slab-nudge",
            type: "button",
            "aria-label": "Down 10 cents",
            onclick: () => {
                if (!isOff(this.nudgeDown)) this.setPitch(this.state.pitch - 10, false);
            },
        }, h("span", {}, "−10"));
        this.nudgeUp = h("button", {
            class: "slab-press slab-nudge",
            type: "button",
            "aria-label": "Up 10 cents",
            onclick: () => {
                if (!isOff(this.nudgeUp)) this.setPitch(this.state.pitch + 10, false);
            },
        }, h("span", {}, "+10"));
        this.normalButton = h("button", {
            class: "slab-press slab-normal",
            type: "button",
            "aria-label": "Back to normal pitch",
            onclick: () => {
                if (!isOff(this.normalButton)) this.setPitch(0, true);
            },
        }, h("span", {}, "Normal"));

        this.pitchInput = h("input", {
            class: "slab-range",
            id: "slab-pitch",
            type: "range",
            min: String(-PITCH_LIMIT),
            max: String(PITCH_LIMIT),
            step: "10",
            oninput: () => this.onPitchInput(false),
            onchange: () => this.onPitchInput(true),
        });
        this.hotUp = h("span", { class: "slab-rail-hot slab-rail-hot-up" });
        this.hotDown = h("span", { class: "slab-rail-hot slab-rail-hot-down" });
        this.runUp = h("span", { class: "slab-rail-run slab-rail-hot-up" });
        this.runDown = h("span", { class: "slab-rail-run slab-rail-hot-down" });
        this.spinEl = h("span", { class: "slab-spin", html: WHEEL_SPIN });
        this.rollEl = h("span", { class: "slab-roll" }, this.spinEl);
        this.wheelEl = h("span", { class: "slab-wheel", html: WHEEL_STATIC }, this.rollEl);
        this.railEl = this.buildRail();

        this.bpmEl = h("b", {}, "–");
        this.barEl = h("span", { class: "slab-bar" }, "Bar –");
        this.lampsEl = h("span", { class: "slab-lamps", role: "img", "aria-label": "No beat" });
        this.setLampCount(4);
        this.playEl = h("span", { class: "slab-play" }, "Paused");

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

        this.switchEl = h("button", {
            class: "slab-switch",
            type: "button",
            role: "switch",
            "aria-checked": String(state.auto),
            onclick: () => this.toggleAuto(),
        }, h("span", { class: "slab-switch-track" }, h("i")), h("span", { class: "slab-auto-title" }, "Auto chop"));
        this.everyEl = h("span", { class: "slab-every", "aria-live": "polite" });
        this.everyDown = h("button", {
            class: "slab-press slab-step",
            type: "button",
            "aria-label": "Chop more often",
            onclick: () => {
                if (!isOff(this.everyDown)) this.setEvery(this.state.every - 1);
            },
        }, h("span", {}, "−"));
        this.everyUp = h("button", {
            class: "slab-press slab-step",
            type: "button",
            "aria-label": "Chop less often",
            onclick: () => {
                if (!isOff(this.everyUp)) this.setEvery(this.state.every + 1);
            },
        }, h("span", {}, "+"));

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

        this.panel = this.buildPanel();

        onChop((event) => {
            this.flashActivity(event.label);
            if (event.kind === "auto") this.hitPad(this.pads[0]);
        });
    }

    mount(): void {
        this.injectStyles();
        this.mountChip();
        document.body.append(this.panel);
        document.addEventListener("click", this.onDocumentClick, true);
        document.addEventListener("keydown", this.onKey);
        window.addEventListener("resize", this.onResize);
        this.panel.addEventListener("scroll", this.onScroll, { passive: true });

        if (this.state.open) this.open();
        else this.panel.hidden = true;

        this.renderMoodState();
        this.renderAutoState();
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
                void sendDsp({ ...moodById(this.state.moodId).dsp, pitch: this.state.pitch });
            }
            wasLinked = status.linked;
        });
        void probeDsp(true);
        void this.applyMood(this.state.moodId, false);
        void this.syncGrid();
        this.refresh();
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
        for (const timer of this.padTimers.values()) window.clearTimeout(timer);
        this.padTimers.clear();
        this.spinAnimation?.cancel();
        this.spinAnimation = null;
        this.spinning = false;
        this.strikeAnimation?.cancel();
        this.strikeAnimation = null;
        document.removeEventListener("click", this.onDocumentClick, true);
        document.removeEventListener("keydown", this.onKey);
        window.removeEventListener("resize", this.onResize);
        this.panel.removeEventListener("scroll", this.onScroll);
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
        void this.syncGrid();
        this.refresh();
    }

    /** An older copy that stood aside may have left its sheet behind; this one wins. */
    private injectStyles(): void {
        const existing = document.getElementById(STYLE_ID);
        if (existing) {
            if (existing.textContent !== CSS) existing.textContent = CSS;
            return;
        }
        const style = h("style", { id: STYLE_ID });
        style.textContent = CSS;
        document.head.append(style);
    }

    private mountChip(): void {
        const lyrics = document.querySelector('[data-testid="lyrics-button"]');
        const host = lyrics?.parentElement;
        if (host) {
            host.insertBefore(this.chip, lyrics);
            return;
        }
        const bar = document.querySelector('[data-testid="now-playing-bar"]');
        (bar ?? document.body).append(this.chip);
    }

    /** Spotify rebuilds the playbar on some navigation, so put the chip back. */
    private ensureChip(): void {
        if (this.chip.isConnected) return;
        this.mountChip();
    }

    private buildChip(): HTMLButtonElement {
        const chip = h("button", {
            class: "slab-chip",
            type: "button",
            "aria-label": "SLAB playback moods",
            "aria-expanded": "false",
            title: "SLAB, Third Coast playback moods",
            onclick: (event: MouseEvent) => {
                event.stopPropagation();
                // A keyboard press arrives as a click with no pointer detail.
                this.toggle(event.detail === 0);
            },
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

        const head = h("div", { class: "slab-head" }, h("span", { html: EMBLEM, class: "slab-badge" }), this.tagEl, close);

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

        const bay = h("div", { class: "slab-bay" }, stage, pitchHead, this.railEl, scale);
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
            button.innerHTML = `
        <span class="slab-mood-name">${mood.name}</span>
        <span class="slab-mood-cents">${formatCents(mood.dsp.pitch)}</span>
        <svg class="slab-mood-curve" viewBox="0 0 58 32" width="58" height="32" aria-hidden="true" focusable="false">
          <path class="slab-mood-zero" d="M0 16H58"/>
          <path class="slab-mood-line" d="${curvePath(mood.gains, 58, 32)}"/>
        </svg>`;
            this.moodButtons.set(mood.id, button);
            moodGrid.append(button);
        }

        const readout = h(
            "div",
            { class: "slab-read" },
            h("div", { class: "slab-read-top" },
                h("span", { class: "slab-bpm" }, this.bpmEl, h("small", {}, "BPM")),
                h("span", { class: "slab-count" }, this.barEl, this.lampsEl),
                this.playEl,
            ),
            h("div", { class: "slab-ruler-slot" }, this.rulerEl, this.noGridEl),
        );

        const padRow = h("div", { class: "slab-pads", role: "group", "aria-label": "Beat-synced edits" });
        const padDefs: { id: string; label: string; sub: string; run: () => void }[] = [
            { id: "chop", label: "Chop", sub: "1 bar", run: () => void chopBars(1) },
            { id: "screw", label: "Screw", sub: "2 bars", run: () => void chopBars(2) },
            { id: "spin", label: "Spin", sub: "4 bars", run: () => void chopBars(4) },
            { id: "loop", label: "Loop", sub: "4x bar", run: () => void loopBars(4) },
            {
                id: "stop",
                label: "Stop",
                sub: "Tape stop",
                run: () => {
                    const linked = dspStatus().linked;
                    if (linked) void dspTapeStop();
                    // 380 ms down + 70 ms hold in the helper; pause right after
                    // the ramp bottoms out so the effect is not clipped.
                    void tapeStop(linked ? { fade: false, pauseDelayMs: 470 } : undefined);
                },
            },
        ];
        for (const def of padDefs) {
            const pad = h("button", {
                class: "slab-press slab-pad",
                type: "button",
                "data-pad": def.id,
                onclick: (event: Event) => {
                    event.stopPropagation();
                    if (isOff(pad)) return;
                    this.hitPad(pad);
                    def.run();
                },
            }, h("b", {}, def.label), h("small", {}, def.sub));
            this.pads.push(pad);
            padRow.append(pad);
        }

        const auto = h(
            "div",
            { class: "slab-auto" },
            this.switchEl,
            h("div", { class: "slab-stepper" }, this.everyDown, this.everyEl, this.everyUp),
        );

        const sill = h(
            "div",
            { class: "slab-sill", html: SILL_SCREWS },
            h("div", { class: "slab-sill-plate" }, this.eqNote, this.helperEl, this.speedEl),
        );

        // The body line: one crease across the door, with the deeper coat under it.
        const lower = h("div", { class: "slab-lower" }, readout, padRow, auto);
        const body = h("div", { class: "slab-body" }, head, trim, moodGrid, lower, sill);
        // The lips sit on the scroll edges when a short window hides part of the car.
        panel.append(h("div", { class: "slab-lip slab-lip-top" }), body, h("div", { class: "slab-lip slab-lip-end" }), this.statusEl);
        panel.addEventListener("click", (event) => event.stopPropagation());
        return panel;
    }

    private handleOutside(event: MouseEvent): void {
        if (this.panel.hidden) return;
        const target = event.target as Node | null;
        if (!target) return;
        if (this.panel.contains(target) || this.chip.contains(target)) return;
        this.close();
    }

    private handleKey(event: KeyboardEvent): void {
        if (event.key === "Escape" && !this.panel.hidden) {
            this.close();
            return;
        }
        if (this.panel.hidden) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const index = Number.parseInt(event.key, 10);
        if (!Number.isFinite(index) || index < 1 || index > this.pads.length) return;
        const target = event.target as HTMLElement | null;
        if (target && /input|textarea/i.test(target.tagName)) return;
        event.preventDefault();
        if (!isOff(this.pads[index - 1])) this.pads[index - 1].click();
    }

    /** Radiogroup keys, matching the grid: sideways is one mood, up and down a whole row. */
    private handleMoodKey(event: KeyboardEvent): void {
        const order = MOODS_BY_PITCH.map((mood) => mood.id);
        const from = order.indexOf(moodById(this.state.moodId).id);
        let to: number;
        switch (event.key) {
            case "ArrowRight":
                to = (from + 1) % order.length;
                break;
            case "ArrowLeft":
                to = (from - 1 + order.length) % order.length;
                break;
            case "ArrowDown":
                to = (from + 2) % order.length;
                break;
            case "ArrowUp":
                to = (from - 2 + order.length) % order.length;
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
        void this.applyMood(order[to], true);
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
        this.position();
        this.renderMoodState();
        this.refresh();
        if (fromKeyboard) this.moodButtons.get(moodById(this.state.moodId).id)?.focus();
    }

    close(): void {
        // Focus inside the panel would otherwise fall to the document.
        if (this.panel.contains(document.activeElement) && this.chip.isConnected) this.chip.focus();
        this.panel.hidden = true;
        this.state.open = false;
        saveState(this.state);
        this.chip.setAttribute("aria-expanded", "false");
        this.updateSpin();
    }

    /**
     * Above the chip, then below it, then beside it, so a short window never opens
     * the panel over the button that closes it. The CSS caps height to the window.
     */
    private position(): void {
        if (this.panel.hidden) return;
        const rect = this.chip.getBoundingClientRect();
        const width = this.panel.offsetWidth || 400;
        const height = this.panel.offsetHeight || 680;
        const maxLeft = Math.max(8, window.innerWidth - width - 8);
        const maxTop = Math.max(8, window.innerHeight - height - 8);
        let left = Math.max(8, Math.min(maxLeft, rect.right - width));
        let top = rect.top - height - 10;
        if (top < 8) {
            top = rect.bottom + 10;
            if (top > maxTop) {
                top = Math.max(8, Math.min(maxTop, rect.bottom - height));
                if (rect.left - width - 10 >= 8) left = rect.left - width - 10;
                else if (rect.right + 10 <= maxLeft) left = rect.right + 10;
            }
        }
        this.panel.style.left = `${Math.round(left)}px`;
        this.panel.style.top = `${Math.round(top)}px`;
        this.renderScrollCue();
    }

    /** Only when a short window has hidden part of the panel. Writes only on change. */
    private renderScrollCue(): void {
        const hidden = this.panel.scrollHeight - this.panel.clientHeight;
        setData(this.panel, "more", hidden - this.panel.scrollTop > 2 ? "true" : "false");
        setData(this.panel, "above", this.panel.scrollTop > 2 ? "true" : "false");
    }

    private async applyMood(id: string, announce: boolean): Promise<void> {
        this.state.moodId = id;
        const mood = moodById(id);
        // Moods are presets for the pitch slider, not a separate concept: pick
        // a mood and the slider lands on that mood's cents. Boot re-applies the
        // saved mood without announcing it, and keeps the saved slider position.
        if (announce) this.state.pitch = mood.dsp.pitch;
        saveState(this.state);
        this.renderMoodState();
        this.renderPitch(announce);
        this.renderDsp();
        if (announce) this.strikeSign();
        this.chip.dataset.on = id !== "flat" ? "true" : "false";

        // The six native filters have exactly one owner. If ModernEQ is
        // installed and the user hasn't claimed them back, SLAB leaves them be.
        if (this.slabOwnsEq()) {
            if (id === "flat") await restoreBaseline();
            else await applyCurve(mood.gains);
        }

        // The helper applies real pitch / reverb / delay. If it is not running
        // this resolves false and the mood stays EQ-only.
        void sendDsp({ ...mood.dsp, pitch: this.state.pitch });

        if (announce) this.flashActivity(mood.name);
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
        this.state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.round(cents / 10) * 10));
        this.renderPitch();
        this.pendingPitch = this.state.pitch;

        if (commit) {
            this.flushPitch(true);
            return;
        }
        if (this.pitchTimer !== null) return;
        this.pitchTimer = window.setTimeout(() => this.flushPitch(false), 90);
    }

    /** Nudges and Normal, which arrive as one committed value. */
    private setPitch(cents: number, roll: boolean): void {
        this.state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, cents));
        this.renderPitch(roll);
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
        if (persist) saveState(this.state);
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
        const applied = linked && status.tapping === true && status.audio === true && !remoteDeviceName();

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
                ? "Pitch shift applied to Spotify's audio by the SLAB helper."
                : "Pitch needs the SLAB helper running. The browser cannot repitch a DRM-protected stream.",
        );

        setText(
            this.semiEl,
            !linked
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
        const turned = (x / TYRE_RADIUS) * (180 / Math.PI);
        this.wheelEl.style.transform = `translateX(${x}px)`;
        this.rollEl.style.transform = `rotate(${turned.toFixed(1)}deg)`;
        const reach = Math.abs(cents) / PITCH_LIMIT;
        this.hotUp.style.transform = `scaleX(${cents > 0 ? reach : 0})`;
        this.hotDown.style.transform = `scaleX(${cents < 0 ? reach : 0})`;
        this.runUp.style.transform = this.hotUp.style.transform;
        this.runDown.style.transform = this.hotDown.style.transform;

        if (this.spinAnimation) this.spinAnimation.playbackRate = 2 ** (cents / 1200);
    }

    /**
     * The spokes turn only while this computer is making the sound being shifted.
     * A long-lived animation with a playback rate, so a pitch change speeds the
     * wheel up in place instead of snapping it back to the start of a turn.
     */
    private updateSpin(): void {
        if (this.disposed) return;
        const status = dspStatus();
        const should =
            !this.panel.hidden &&
            isPlaying() &&
            status.linked === true &&
            status.tapping === true &&
            status.audio === true &&
            !remoteDeviceName() &&
            !reducedMotion();
        if (should === this.spinning) return;
        this.spinning = should;
        if (!should) {
            this.spinAnimation?.pause();
            return;
        }
        if (!this.spinAnimation) {
            this.spinAnimation = this.spinEl.animate(
                [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
                { duration: SPIN_MS, iterations: Infinity, easing: "linear" },
            );
            this.spinAnimation.playbackRate = 2 ** (this.state.pitch / 1200);
        }
        this.spinAnimation.play();
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

    /** With no ModernEQ the row goes and the sill's fixed height re-centres the rest. */
    private renderEqNote(): void {
        if (!this.modernEq) {
            this.eqNote.hidden = true;
            return;
        }
        this.eqNote.hidden = false;
        const label = this.eqNoteButton.firstElementChild as Element;
        if (this.slabOwnsEq()) {
            setText(this.eqNoteText, "SLAB has the EQ.");
            setText(label, "Use ModernEQ");
        } else {
            setText(this.eqNoteText, "ModernEQ has the EQ.");
            setText(label, "Use SLAB EQ");
        }
    }

    /** Hand the bands back with the curve ModernEQ last saved. */
    private async restoreModernEqCurve(): Promise<void> {
        const bands = modernEqBands();
        if (!bands) return;
        await applyCurveAtFrequencies(bands);
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
     * The panel states what is true now, including the cases where SLAB is doing
     * nothing audible: the EQ and the tap both only reach audio on this computer.
     * The sign is lit while the mood has a way into the sound, by the EQ or by a
     * helper with audio flowing. The pitch tube is lit only while the helper is
     * shifting audio, and sits idle while it is running with nothing to shift. The
     * paint only goes when the sound has left the room.
     */
    private renderDsp(): void {
        const status = dspStatus();
        const remote = remoteDeviceName();
        const processing = status.linked && status.tapping === true && status.audio === true && !remote;

        setData(this.panel, "primer", remote ? "true" : "false");
        setData(this.panel, "gas", !remote && (this.slabOwnsEq() || processing) ? "on" : "off");
        setData(this.panel, "tube", remote || !status.linked ? "off" : processing ? "on" : "idle");
        setData(this.chip, "remote", remote ? "true" : "false");

        if (remote) {
            setText(this.deadEl, `Playing on ${deviceSentence(remote)} SLAB only reaches this computer.`);
            setAttr(this.deadEl, "title", `Playing on ${remote}. Moods, pitch and effects apply when Spotify plays here.`);
        } else {
            setText(this.deadEl, "");
            this.deadEl.removeAttribute("title");
        }
        this.renderSign();
        this.renderHelperLine();
        this.renderPitch();
        this.updateSpin();
    }

    /** What the helper is doing, built from the parameters actually sent to it. */
    private helperLine(): { state: string; text: string; title: string } {
        const status = dspStatus();
        if (remoteDeviceName()) {
            return {
                state: "remote",
                text: status.linked ? "Helper has nothing to process until this computer plays." : "Helper isn't running.",
                title: "The EQ and the helper only touch audio on this computer.",
            };
        }
        if (!status.linked) {
            return {
                state: "offline",
                text: this.slabOwnsEq() ? "Helper isn't running, so SLAB only shapes the EQ." : "Helper isn't running, so SLAB isn't changing the sound.",
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
        if (!status.audio) {
            return {
                state: "silent",
                text: "Helper is attached. No audio coming through yet.",
                title: "The SLAB helper is attached to Spotify and nothing is playing here yet.",
            };
        }
        const dsp = moodById(this.state.moodId).dsp;
        const behind = typeof status.latencyMs === "number" ? `, ${Math.round(status.latencyMs)} ms behind` : "";
        const effects = [
            ...(this.state.pitch !== 0 ? ["pitch"] : []),
            ...(dsp.reverb > 0 ? ["reverb"] : []),
            ...(dsp.delayMix > 0 ? ["delay"] : []),
        ];
        const doing =
            effects.length === 0
                ? "live and dry"
                : effects.length === 1 && effects[0] === "pitch"
                  ? "shifting pitch"
                  : `running ${listWords(effects)}`;
        return {
            state: "live",
            text: `Helper is ${doing}${behind}.`,
            title: "The SLAB helper is running and processing Spotify's audio.",
        };
    }

    /** Runs from the refresh loop so the latency and the mood can't go stale. */
    private renderHelperLine(): void {
        const { state, text, title } = this.helperLine();
        setText(this.helperEl, text);
        setAttr(this.helperEl, "title", title);
        if (this.lastHelperState !== null && this.lastHelperState !== state) this.announce(text);
        this.lastHelperState = state;
    }

    private announce(text: string): void {
        setText(this.statusEl, text);
    }

    /** Playback can move to another device at any moment. */
    private refreshConnect(): void {
        const remote = remoteDeviceName();
        if (remote === this.lastRemote) return;
        this.lastRemote = remote;
        this.renderDsp();
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
        this.chip.dataset.on = mood.id !== "flat" ? "true" : "false";
        setAttr(this.chip, "aria-label", mood.id === "flat" ? "SLAB playback moods, no mood on" : `SLAB playback moods, ${mood.name} on`);
    }

    /** The tube keeps its gauge at any size; two lines of message get the sign's lower part. */
    private renderSign(): void {
        const mood = moodById(this.state.moodId);
        const compact = (this.deadEl.textContent ?? "").length > DEAD_LINE_CHARS;
        this.signTube.set(signLayout(mood.id, mood.name, compact ? COMPACT_SIGN_HEIGHT : SIGN_HEIGHT));
    }

    private toggleAuto(): void {
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
    }

    private renderAutoState(): void {
        const every = this.state.every;
        setAttr(this.switchEl, "aria-checked", String(this.state.auto));
        setText(this.everyEl, `Every ${every} bar${every === 1 ? "" : "s"}`);
        setOff(this.everyDown, every <= EVERY_MIN);
        setOff(this.everyUp, every >= EVERY_MAX);
        setAuto(this.state.auto, every);
    }

    /** Activity borrows the tagline's slot, so nothing else in the panel moves. */
    private flashActivity(text: string): void {
        this.tagEl.textContent = text;
        this.tagEl.dataset.flash = "true";
        this.announce(text);
        if (this.activityTimer !== null) window.clearTimeout(this.activityTimer);
        this.activityTimer = window.setTimeout(() => {
            this.tagEl.textContent = TAGLINE;
            delete this.tagEl.dataset.flash;
        }, 1800);
    }

    /** A press lights on the way down; a keyboard or auto hit lights for a moment. */
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

        // The slider is authoritative; the mood only supplies the other params.
        const want = { ...moodById(this.state.moodId).dsp, pitch: this.state.pitch };
        const have = status.params ?? {};
        const drifted =
            Math.abs((have.pitch ?? 0) - want.pitch) > 1 ||
            Math.abs((have.reverb ?? 0) - want.reverb) > 1 ||
            Math.abs((have.lowpass ?? 20_000) - want.lowpass) > 50;
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
        this.lastGridUri = uri;
        this.lastGridAttempt = Date.now();
        await loadGrid(uri);
        if (!this.disposed) this.refresh();
    }

    /**
     * One tick per real bar at its real time, every fourth taller, closing on the
     * track's end. A track too long for that at two pixels a tick draws every
     * fourth bar instead, or every sixteenth, and the title says so.
     */
    private buildRuler(grid: Grid): void {
        const key = `${grid.uri}:${grid.bars.length}`;
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
            d += `M${x} ${index % (every * 4) === 0 ? 1 : 7}V14`;
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
        // Probe even when the panel is closed: if the helper starts or restarts,
        // the selected mood needs to reach it without waiting for a click.
        void probeDsp();

        // Analysis can fail on the first try (player not hydrated, network hiccup).
        // Retry at a slow cadence rather than leaving the deck blank forever.
        if (!gridFor() && Date.now() - this.lastGridAttempt > 5_000) {
            void this.syncGrid(true);
        }

        this.syncDspParams();
        this.refreshEqOwner();
        this.refreshConnect();
        this.updateSpin();

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
            setText(this.noGridEl, "No beat grid for this track, so only Stop works.");
            setAttr(this.lampsEl, "aria-label", "No beat");
            this.setLampCount(4);
            this.renderLamps(-1);
        } else {
            const progress = progressMs();
            const bar = barIndexAt(grid, progress);
            const beat = beatIndexAt(grid, progress);
            const total = barCount(grid);
            const beatsPerBar = Math.max(1, grid.timeSignature || 4);
            const beatInBar = ((beat - Math.max(0, bar) * beatsPerBar) % beatsPerBar + beatsPerBar) % beatsPerBar;

            setText(this.bpmEl, grid.tempo > 0 ? grid.tempo.toFixed(1) : "–");
            setText(this.barEl, `Bar ${Math.max(1, bar + 1)} of ${total}`);
            setText(this.noGridEl, "");
            this.setLampCount(Math.min(7, beatsPerBar));
            this.renderLamps(beatInBar);
            setAttr(this.lampsEl, "aria-label", `Beat ${beatInBar + 1} of ${beatsPerBar}`);

            this.buildRuler(grid);
            if (bar !== this.rulerBar) {
                this.rulerBar = bar;
                const span = grid.durationMs || 1;
                const start = grid.bars[Math.max(0, bar)] ?? 0;
                const lit = bar < 0 ? 0 : Math.min(RULER_WIDTH, Math.round((start / span) * (RULER_WIDTH - 1)) + 1);
                this.rulerClip.style.clipPath = `inset(0 ${RULER_WIDTH - lit}px 0 0)`;
            }
        }

        const speed = this.speedInfo();
        setText(this.speedEl, speed.text);
        setAttr(this.speedEl, "title", speed.hint);

        for (const pad of this.pads) {
            const off = pad.dataset.pad !== "stop" && !grid;
            setOff(pad, off);
            if (off) setAttr(pad, "aria-describedby", "slab-nogrid");
            else if (pad.hasAttribute("aria-describedby")) pad.removeAttribute("aria-describedby");
        }
    }

    /** The speed lock only explains anything while the helper is absent; otherwise it's noise. */
    private speedInfo(): SpeedInfo {
        const dsp = dspStatus();
        const remote = remoteDeviceName();
        if (dsp.linked && dsp.tapping && dsp.audio && !remote) {
            return {
                text: this.state.pitch === 0 ? "Tempo is untouched." : "Tempo stays the same.",
                hint: "The SLAB helper works outside the player, so tempo is never changed.",
            };
        }
        if (dsp.linked || remote) return { text: "", hint: "" };

        const api = Spicetify.Platform.PlayerAPI;
        const capabilities = api.getCapabilities?.();
        const state = api.getState();
        const reasons = state?.restrictions?.disallowSettingPlaybackSpeedReasons ?? [];

        if (!capabilities?.canChangeSpeed) {
            return {
                text: "This client has no playback speed control.",
                hint: "This client does not expose playback speed.",
            };
        }
        if (reasons.length > 0) {
            const reason = reasons[0];
            return {
                text: reason === "unknown" ? "Spotify locks playback speed for music." : `Speed is locked: ${reason.replace(/_/g, " ")}.`,
                hint: "Spotify blocks playback speed for music on this build. SLAB shapes tone and edits instead.",
            };
        }
        return {
            text: "This build allows playback speed.",
            hint: "This build allows playback speed.",
        };
    }
}
