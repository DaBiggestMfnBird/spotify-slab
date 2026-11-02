import { chopBars, loopBars, onChop, resetForTrack, setAuto, tapeStop } from "../core/chops";
import { dspStatus, dspTapeStop, onDspChange, probeDsp, sendDsp } from "../core/dsp";
import { applyCurve, restoreBaseline } from "../core/eq";
import {
    barCount,
    barIndexAt,
    beatIndexAt,
    gridFor,
    loadGrid,
} from "../core/grid";
import { MOODS, curvePath, moodById } from "../core/moods";
import { saveState } from "../core/state";
import type { SlabState } from "../types";
import { CSS, STYLE_ID } from "./styles";

type Props = Record<string, unknown>;

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

const CASSETTE = `
<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.4" stroke="currentColor" stroke-width="1.6"/>
  <rect x="6.2" y="8.2" width="11.6" height="4.6" rx="1.2" stroke="currentColor" stroke-width="1.3" opacity=".75"/>
  <circle cx="8.6" cy="10.5" r="1.15" fill="currentColor"/>
  <circle cx="15.4" cy="10.5" r="1.15" fill="currentColor"/>
  <path d="M7.6 16.9l1.1-2.2h6.6l1.1 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

const REEL = `
<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <circle cx="24" cy="24" r="20.5" stroke="rgba(255,255,255,.16)" stroke-width="1.8"/>
  <circle cx="24" cy="24" r="11.5" stroke="rgba(255,255,255,.20)" stroke-width="1.3"/>
  <circle cx="24" cy="24" r="3.6" fill="rgba(255,255,255,.38)"/>
  <g stroke="rgba(255,255,255,.32)" stroke-width="1.5" stroke-linecap="round">
    <path d="M24 20.4V13.2"/><path d="M24 27.6v7.2"/>
    <path d="M27.1 25.8l6.2 3.6"/><path d="M20.9 22.2l-6.2-3.6"/>
    <path d="M27.1 22.2l6.2-3.6"/><path d="M20.9 25.8l-6.2 3.6"/>
  </g>
</svg>`;

interface SpeedInfo {
    ok: boolean;
    text: string;
    hint: string;
}

export class Deck {
    private state: SlabState;
    private chip: HTMLButtonElement;
    private panel: HTMLDivElement;
    private moodButtons = new Map<string, HTMLButtonElement>();
    private bpmEl: HTMLSpanElement;
    private posEl: HTMLDivElement;
    private barFill: HTMLSpanElement;
    private switchEl: HTMLButtonElement;
    private activityEl: HTMLSpanElement;
    private dotEl: HTMLSpanElement;
    private speedEl: HTMLSpanElement;
    private dspEl: HTMLDivElement;
    private dspDot: HTMLSpanElement;
    private dspText: HTMLSpanElement;
    private disposeDsp: (() => void) | null = null;
    private pads: HTMLButtonElement[] = [];
    private refreshTimer: number | null = null;
    private chipTimer: number | null = null;
    private activityTimer: number | null = null;
    private lastGridUri: string | null = null;
    private lastGridAttempt = 0;
    private onDocumentClick = (event: MouseEvent) => this.handleOutside(event);
    private onKey = (event: KeyboardEvent) => this.handleKey(event);
    private onResize = () => this.position();

    constructor(state: SlabState) {
        this.state = state;
        this.chip = this.buildChip();
        this.bpmEl = h("span", { class: "slab-bpm" }, "--.-", h("small", {}, "BPM"));
        this.posEl = h("div", { class: "slab-pos" }, "NO GRID FOR THIS TRACK");
        this.barFill = h("span");
        this.activityEl = h("span", { class: "slab-activity" });
        this.switchEl = h("button", {
            class: "slab-switch",
            role: "switch",
            "aria-checked": String(state.auto),
            "aria-label": "Automatic chop",
            onclick: () => this.toggleAuto(),
        });
        this.dotEl = h("span", { class: "slab-dot" });
        this.speedEl = h("span", { class: "slab-speed" }, "…");
        this.dspDot = h("span", { class: "slab-dsp-dot" });
        this.dspText = h("span", { class: "slab-dsp-text" }, "checking DSP helper…");
        this.dspEl = h("div", { class: "slab-dsp", "data-linked": "false" }, this.dspDot, this.dspText);
        this.panel = this.buildPanel();

        onChop((event) => this.flashActivity(event.label));
    }

    mount(): void {
        this.injectStyles();
        this.mountChip();
        document.body.append(this.panel);
        document.addEventListener("click", this.onDocumentClick, true);
        document.addEventListener("keydown", this.onKey);
        window.addEventListener("resize", this.onResize);

        if (this.state.open) this.open();
        else this.panel.hidden = true;

        this.renderMoodState();
        this.renderAutoState();
        let wasLinked = false;
        this.disposeDsp = onDspChange((status) => {
            this.renderDsp(status.linked, status.latencyMs);
            // The helper can start (or restart) after the extension does. When
            // it comes back, re-push the current mood so the panel and the audio
            // agree without the user having to reselect anything.
            if (status.linked && !wasLinked) void sendDsp(moodById(this.state.moodId).dsp);
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
        if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
        if (this.chipTimer !== null) window.clearInterval(this.chipTimer);
        if (this.activityTimer !== null) window.clearTimeout(this.activityTimer);
        document.removeEventListener("click", this.onDocumentClick, true);
        document.removeEventListener("keydown", this.onKey);
        window.removeEventListener("resize", this.onResize);
        this.chip.remove();
        this.panel.remove();
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

    private injectStyles(): void {
        if (document.getElementById(STYLE_ID)) return;
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

    /** Spotify rebuilds the playbar on some navigation — put the chip back. */
    private ensureChip(): void {
        if (this.chip.isConnected) return;
        this.mountChip();
    }

    private buildChip(): HTMLButtonElement {
        const chip = h("button", {
            class: "slab-chip",
            "aria-label": "SLAB — playback moods",
            title: "SLAB — Third Coast playback moods",
            onclick: (event: Event) => {
                event.stopPropagation();
                this.toggle();
            },
        });
        chip.innerHTML = CASSETTE;
        return chip;
    }

    private buildPanel(): HTMLDivElement {
        const panel = h("div", {
            class: "slab-panel",
            role: "dialog",
            "aria-label": "SLAB playback moods",
        });
        panel.hidden = true;

        const close = h("button", {
            class: "slab-close",
            "aria-label": "Close SLAB",
            onclick: () => this.close(),
        }, "×");

        const head = h(
            "div",
            { class: "slab-head" },
            h(
                "div",
                {},
                h("div", { class: "slab-mark" }, "SLAB"),
                h("div", { class: "slab-kicker" }, "Third Coast playback"),
            ),
            close,
        );

        const moodGrid = h("div", { class: "slab-moods" });
        for (const mood of MOODS) {
            const button = h("button", {
                class: "slab-mood",
                "data-mood": mood.id,
                "aria-pressed": "false",
                onclick: () => void this.applyMood(mood.id, true),
            });
            button.innerHTML = `
        <span class="slab-mood-name">${mood.name}</span>
        <svg viewBox="0 0 62 18" preserveAspectRatio="none" aria-hidden="true">
          <path d="${curvePath(mood.gains, 62, 18)}" />
        </svg>
        <span class="slab-mood-sub">${mood.sub}</span>`;
            this.moodButtons.set(mood.id, button);
            moodGrid.append(button);
        }

        const tape = h(
            "div",
            { class: "slab-tape" },
            h("div", { class: "slab-reel", html: REEL }),
            h(
                "div",
                { class: "slab-read" },
                this.bpmEl,
                this.posEl,
                h("div", { class: "slab-bars" }, this.barFill),
            ),
        );

        const padRow = h("div", { class: "slab-pads" });
        const padDefs: { id: string; label: string; sub: string; run: () => void }[] = [
            { id: "chop", label: "Chop", sub: "1 bar", run: () => void chopBars(1) },
            { id: "screw", label: "Screw", sub: "2 bars", run: () => void chopBars(2) },
            { id: "spin", label: "Spin", sub: "4 bars", run: () => void chopBars(4) },
            { id: "loop", label: "Loop", sub: "4× bar", run: () => void loopBars(4) },
            {
                id: "stop",
                label: "Stop",
                sub: "fader",
                run: () => {
                    void dspTapeStop();
                    void tapeStop();
                },
            },
        ];
        for (const def of padDefs) {
            const pad = h("button", {
                class: "slab-pad",
                "data-pad": def.id,
                onclick: (event: Event) => {
                    event.stopPropagation();
                    def.run();
                },
            });
            pad.innerHTML = `${def.label}<small>${def.sub}</small>`;
            this.pads.push(pad);
            padRow.append(pad);
        }

        const auto = h(
            "div",
            { class: "slab-auto" },
            h(
                "div",
                { class: "slab-auto-text" },
                h("span", { class: "slab-auto-title" }, "Auto chop"),
                h("span", { class: "slab-auto-sub" }, "cuts a bar every 4, in time"),
            ),
            this.switchEl,
        );

        const foot = h(
            "div",
            { class: "slab-foot" },
            this.activityEl,
            h("div", { class: "slab-foot-right" }, this.dotEl, this.speedEl),
        );

        panel.append(
            head,
            h("div", { class: "slab-label" }, "Moods"),
            moodGrid,
            h("div", { class: "slab-label" }, "Tape"),
            tape,
            h("div", { class: "slab-label" }, "Pads"),
            padRow,
            auto,
            this.dspEl,
            foot,
        );

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
        this.pads[index - 1].click();
    }

    toggle(): void {
        if (this.panel.hidden) this.open();
        else this.close();
    }

    open(): void {
        this.panel.hidden = false;
        this.state.open = true;
        saveState(this.state);
        this.chip.dataset.on = "true";
        this.position();
        this.renderMoodState();
        this.refresh();
    }

    close(): void {
        this.panel.hidden = true;
        this.state.open = false;
        saveState(this.state);
        this.chip.dataset.on = this.state.moodId !== "flat" ? "true" : "false";
    }

    private position(): void {
        if (this.panel.hidden) return;
        const rect = this.chip.getBoundingClientRect();
        const width = this.panel.offsetWidth || 372;
        const height = this.panel.offsetHeight || 420;
        const maxLeft = Math.max(8, window.innerWidth - width - 8);
        const left = Math.max(8, Math.min(maxLeft, rect.right - width));
        let top = rect.top - height - 10;
        if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 10);
        this.panel.style.left = `${Math.round(left)}px`;
        this.panel.style.top = `${Math.round(Math.max(8, top))}px`;
    }

    private async applyMood(id: string, announce: boolean): Promise<void> {
        this.state.moodId = id;
        saveState(this.state);
        this.renderMoodState();
        this.chip.dataset.on = id !== "flat" ? "true" : "false";

        if (id === "flat") await restoreBaseline();
        else await applyCurve(moodById(id).gains);

        // The helper applies real pitch / reverb / delay. If it is not running
        // this resolves false and the mood stays EQ-only.
        void sendDsp(moodById(id).dsp);

        if (announce) {
            const mood = moodById(id);
            this.flashActivity(`${mood.name} — ${mood.sub}`);
        }
    }

    private renderDsp(linked: boolean, latencyMs?: number): void {
        this.dspEl.dataset.linked = linked ? "true" : "false";
        if (linked) {
            const latency = typeof latencyMs === "number" ? ` · ${Math.round(latencyMs)} ms` : "";
            this.dspText.textContent = `DSP linked — pitch, reverb, delay live${latency}`;
            this.dspEl.title = "SLAB DSP is running and processing Spotify's audio.";
        } else {
            this.dspText.textContent = "DSP helper offline — EQ only";
            this.dspEl.title =
                "Run SLAB DSP to get real pitch, reverb and delay. Without it SLAB only shapes the native EQ.";
        }
    }

    private renderMoodState(): void {
        for (const [id, button] of this.moodButtons) {
            button.setAttribute("aria-pressed", id === this.state.moodId ? "true" : "false");
        }
    }

    private toggleAuto(): void {
        this.state.auto = !this.state.auto;
        saveState(this.state);
        setAuto(this.state.auto, this.state.every);
        this.renderAutoState();
        this.flashActivity(this.state.auto ? "auto chop on" : "auto chop off");
    }

    private renderAutoState(): void {
        this.switchEl.setAttribute("aria-checked", String(this.state.auto));
        setAuto(this.state.auto, this.state.every);
    }

    private flashActivity(text: string): void {
        this.activityEl.textContent = text;
        if (this.activityTimer !== null) window.clearTimeout(this.activityTimer);
        this.activityTimer = window.setTimeout(() => {
            this.activityEl.textContent = "";
        }, 1800);
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
        this.refresh();
    }

    private refresh(): void {
        // Probe even when the panel is closed: if the helper starts or restarts,
        // the selected mood needs to reach it without waiting for a click.
        void probeDsp();

        // Analysis can fail on the first try (player not hydrated, network hiccup).
        // Retry at a slow cadence rather than leaving the deck blank forever.
        if (!gridFor() && Date.now() - this.lastGridAttempt > 5_000) {
            void this.syncGrid(true);
        }

        if (this.panel.hidden) return;

        const playing = isPlaying();
        this.panel.dataset.playing = playing ? "true" : "false";

        const grid = gridFor();
        if (!grid) {
            this.bpmEl.innerHTML = `--.-<small>BPM</small>`;
            this.posEl.textContent = "NO GRID FOR THIS TRACK";
            this.barFill.style.width = "0%";
        } else {
            const progress = progressMs();
            const bar = barIndexAt(grid, progress);
            const beat = beatIndexAt(grid, progress);
            const total = barCount(grid);
            const beatsPerBar = Math.max(1, grid.timeSignature || 4);
            const beatInBar = ((beat - Math.max(0, bar) * beatsPerBar) % beatsPerBar) + 1;
            const tempo = grid.tempo > 0 ? grid.tempo.toFixed(1) : "--.-";

            this.bpmEl.innerHTML = `${tempo}<small>BPM</small>`;
            this.posEl.textContent = `BAR ${Math.max(1, bar + 1)}/${total} · BEAT ${beatInBar}/${beatsPerBar}`;
            const ratio = total > 0 ? (Math.max(0, bar) + 1) / total : 0;
            this.barFill.style.width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
        }

        const speed = this.speedInfo();
        this.dotEl.dataset.state = speed.ok ? "ok" : "locked";
        this.speedEl.textContent = speed.text;
        this.speedEl.title = speed.hint;
        this.speedEl.className = speed.ok ? "slab-speed" : "slab-speed slab-lock";

        for (const pad of this.pads) {
            const needsGrid = pad.dataset.pad !== "stop";
            pad.disabled = needsGrid && !grid;
        }
    }

    private speedInfo(): SpeedInfo {
        if (dspStatus().linked) {
            return {
                ok: true,
                text: "pitch live",
                hint: "SLAB DSP is shifting pitch and adding effects outside the player. Tempo stays locked.",
            };
        }
        const api = Spicetify.Platform.PlayerAPI;
        const capabilities = api.getCapabilities?.();
        const state = api.getState();
        const reasons = state?.restrictions?.disallowSettingPlaybackSpeedReasons ?? [];

        if (!capabilities?.canChangeSpeed) {
            return {
                ok: false,
                text: "speed unsupported",
                hint: "This client does not expose playback speed.",
            };
        }
        if (reasons.length > 0) {
            const reason = reasons[0];
            return {
                ok: false,
                text: reason === "unknown" ? "speed locked for music" : `speed locked · ${reason}`,
                hint: "Spotify blocks playback speed for music on this build. SLAB shapes tone and edits instead of pretending.",
            };
        }
        return {
            ok: true,
            text: "speed available",
            hint: "This build allows playback speed.",
        };
    }
}
