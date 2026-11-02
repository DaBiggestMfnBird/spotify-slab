# SLAB

**Third Coast playback moods for Spicetify.**

SLAB is a playback deck for the Houston lineage — the sound DJ Screw built with two turntables, a pause button, and a trunk full of bass. It gives you the tonal fingerprints of that lineage, plus a row of pads that cut on the bar.

Named for **Slow, Loud And Bangin'**. No samples, no lean imagery, no costume. Just the mix moves.

![SLAB panel](preview.png)

---

## What it actually does

Spotify does not hand over the audio stream to extensions. There is no Web Audio node to insert, no buffer to stretch, and the player refuses `playbackSpeed` for music with `not_supported_by_content_type`. Any extension claiming real time-stretch inside the page on the current desktop client is either lying or shipping a broken button.

SLAB does the things the client can actually do, and pairs with a small companion app for the rest:

- **Six EQ moods** written against the client's native six-band equalizer.
- **A real pitch slider** — ±1200 cents, live, with the mood cards acting as presets that move it.
- **Real pitch shift, reverb, delay and low-pass** through [SLAB DSP](#slab-dsp-macos) — a menu-bar helper that taps Spotify's output at the OS level on macOS 14.2+. No page sandbox involved.
- **Beat-synced chop pads** that seek to the top of a bar, using Spotify's own audio analysis for the grid.
- **Tape stop** — a real pitch-and-speed spin-down when SLAB DSP is running, a fader pull into pause when it is not.
- **Auto chop** — cuts a bar every N bars, locked to the grid, on a worker clock that survives a backgrounded window.
- **An honest readout** — the sign is only lit while the mood can be heard, the sill says what the helper and Spotify are doing right now, and when Spotify plays on another device the paint goes to grey primer and the panel names that device.

Tempo is the one thing SLAB does not change. See [why](#tempo-is-locked-on-purpose).

The slider's position is saved. A relaunch restores the mood and the slider where you left it, so a mood you nudged off its landing point stays nudged. Picking a mood moves the slider to that mood's cents.

### The moods

| Mood | What it is |
|---|---|
| **Slowed + Reverb** | The shape a record takes when it's dragged: low-mids swell, presence drops, the top turns to air. |
| **Houston Screwed** | Screw's tonal signature — sub and low-mid forward, everything above 2k pulled back. Slowed, not chopped. |
| **Houston Chopped** | Dry and forward, presence up. The cut has to land, so the top stays alive. |
| **Memphis Tape** | 400–1k pushed until it honks, top rolled off, bottom loose. Cassette dub. |
| **Sped Up** | The other direction: lean low end, bright presence and air. |
| **Flat** | Restores the curve your equalizer had when SLAB first loaded. |

These are EQ curves, not presets with names slapped on. The sparkline on each card is the actual curve.

### The pads

| Pad | Move |
|---|---|
| **CHOP** | Jump to the top of the current bar. Press late and you replay the bar; press right after the downbeat and it sends you one bar further. |
| **SCREW** | Jump back two bars, on the downbeat. |
| **SPIN** | Jump back four bars. |
| **LOOP** | Repeat the current bar four times, then let the record run. |
| **STOP** | Tape stop — fade, pause, restore the fader. |

Keyboard `1`–`5` triggers the pads while the panel is open. `Esc` closes it.

Auto chop counts bars played, not absolute bar numbers, so replaying a bar can't retrigger it in a loop. It has a 900 ms cooldown.

---

## SLAB DSP (macOS)

The companion app is what makes the moods real. It taps Spotify's audio with `AudioHardwareCreateProcessTap`, runs it through an `AVAudioEngine` chain — pitch, low-pass, reverb, delay — and plays the result back. Spotify's own output is muted while it is attached, so what you hear is the processed copy.

| Control | Range |
|---|---|
| Pitch | ±2400 cents (two octaves), in cents |
| Reverb | 0–100 wet, with room/hall/plate/chamber characters |
| Delay | 10 ms–2 s, feedback 0–95, wet 0–100 |
| Low-pass | 200 Hz–20 kHz |
| Tape stop | Real rate ramp: 380 ms down, 70 ms hold, 240 ms back up |

**Requirements:** macOS 14.2 or newer. Apple Silicon or Intel. Spotify desktop.

### Install

```bash
bun run dsp:install
```

That builds `SLAB DSP.app`, copies it to `~/Applications`, and launches it. It lives in the menu bar as a small waveform: the menu shows what it is doing right now, and has **Reconnect to Spotify**, **Start at Login**, **Open Log** and **Quit**. The icon is dimmed whenever no audio is coming through. On first run macOS asks for **Audio Recording** permission — that is the process tap. Nothing is recorded, stored, or sent anywhere; the app has no network client beyond a loopback control port.

If the permission prompt was dismissed, re-enable it in **System Settings → Privacy & Security → Screen & System Audio Recording** (macOS 15) or **Audio Recording** (macOS 14), then relaunch the app.

Quit Spotify, reopen it, and the helper picks it up on its own with the same settings. It can be started before Spotify and will wait. A rebuilt copy is a new binary as far as macOS is concerned, so a build from source asks for the permission again.

The helper must be launched as an app (LaunchServices), not from a shell. TCC attributes the audio-capture grant to the responsible process, so a binary started from Terminal inherits Terminal's identity and taps silence.

### Linking

The helper listens on `http://127.0.0.1:47832`:

| Route | Purpose |
|---|---|
| `GET /status` | version, link state (`tapping`, `audio`), sample rate, level, latency, current params |
| `POST /params` | `{"pitch": -320, "reverb": 34, "lowpass": 11000}` |
| `POST /tapstop` | `{"downMs": 380, "holdMs": 70, "upMs": 240}` |
| `POST /reset` | back to neutral |
| `POST /reconnect` | drop the tap and attach again |
| `POST /quit` | shut the helper down |

The panel probes `/status` every few seconds. The sill's status line says which it found: not running (SLAB is EQ-only), waiting for Spotify, attached with no audio yet, or live along with what it is actually running. Until audio is flowing the pitch tube sits unlit and the panel says "Set to", because nothing is being shifted yet. Moods push their DSP parameters on selection, so picking **Houston Screwed** sets pitch, reverb and low-pass in one move. The pitch slider then moves from that point, and the helper is told to keep the rest of the mood intact.

The control port only answers to Spotify. Requests carrying an `Origin` other than `https://xpui.app.spotify.com` or `https://open.spotify.com` get `403` and never reach the audio graph, so a page you happen to have open cannot repitch your music or shut the helper down. The `Access-Control-Allow-Private-Network` grant is only sent back to those origins, on request. Requests with no `Origin` at all — `curl`, native clients — are still allowed, as long as their `Host` is loopback, which is what stops DNS rebinding from turning a page into a same-origin caller.

The extension degrades cleanly: no helper, no errors, no dead buttons. And it says when it can't be heard: the EQ and the tap only reach audio on this computer, so while Spotify Connect is playing on a console or a speaker the row reads *Playing on XBOX — SLAB only reaches this computer*.

### Dev flags

```bash
./dsp/.build/release/SLABDSP --help
./dsp/.build/release/SLABDSP --set pitch=-560,reverb=16 --seconds 10
./dsp/.build/release/SLABDSP --record out.wav --seconds 6 --set pitch=-1200
```

`--record` writes the processed chain to a WAV and exits — that is how the pitch shift was verified (spectral centroid 2992 Hz → 1400 Hz at −1200 cents on the same passage).

---

## Tempo is locked on purpose

Slowed-and-reverbed records are slower. SLAB's pitch shift is not a tempo change, and this is deliberate:

- The player refuses `playbackSpeed` for music (`not_supported_by_content_type`), so there is no native slow-down to hook.
- A live tap cannot be slowed without unbounded drift. Spotify renders at 1×, so a ring buffer that consumes slower than it fills grows forever. You can drop samples to catch up — that is a stutter, not a screw tape.
- Offline time-stretch would need the whole decoded track, which DRM does not provide.

So SLAB shifts pitch, which is the audible half of a screw record, and leaves tempo honest. If a future client build exposes a real rate control, SLAB will use it.

---

## What it does not do

- **It does not change playback tempo.** See above.
- **It does not modify the Spotify binary.** No patching, no injected native code, no DRM circumvention. The helper taps the system audio device, the same API every screen recorder uses.
- **It does not record.** `--record` exists for verification and writes a local file only when you ask for it.

---

## Install

### Marketplace

Search for **SLAB** in the Spicetify Marketplace and install it there.

The extension itself is cross-platform. **SLAB DSP** — the part that adds real pitch, reverb and delay — is macOS 14.2+ only, because it depends on Core Audio process taps. On Windows and Linux the extension runs EQ-only and says so in the panel.

### Manual

```bash
git clone https://github.com/DaBiggestMfnBird/spotify-slab.git
cd spotify-slab
bun install
bun run build
mkdir -p ~/.config/spicetify/Extensions
cp dist/slab.js ~/.config/spicetify/Extensions/slab.js
```

Add `slab.js` to the `extensions` line in `~/.config/spicetify/config-xpui.ini`:

```ini
extensions            = slab.js
```

Then:

```bash
spicetify apply
```

Restart Spotify if the chip does not appear. The chip sits in the playbar next to the lyrics button.

---

## Conflicts

- **ModernEQ.** Both extensions write the same six native filters, so only one can own them. SLAB detects ModernEQ and steps back: the panel says *ModernEQ is driving the EQ* and the moods move pitch, reverb and low-pass instead. One button in that row hands the bands back to SLAB (and writes ModernEQ's saved curve when you hand them back the other way). No uninstalling required.
- **Local and Marketplace copies.** Spicetify loads both if both are installed. The newer one wins from 0.3.0 on, but anything older than that always takes over, so remove the old one or update it.
- **Other equalizer extensions.** cat-jam and anything else built on `EqualizerAPI` have no handshake with SLAB. Run one at a time.
- **The baseline curve.** SLAB snapshots your equalizer the first time it loads and stores it in `localStorage`. **Flat** restores that snapshot, not whatever you changed the EQ to afterward. Clear `slab:baseline:v1` from local storage if you want a fresh snapshot.
- **Speed extensions.** Dial and similar tools will report their own speed state. On builds where speed is locked, they cannot work either.

---

## How it works

```
src/
  main.ts          boot, songchange wiring, window.SLAB debug handle
  core/
    dsp.ts         loopback bridge to SLAB DSP (probe / params / tapstop)
    eq.ts          EqualizerAPI bridge, baseline snapshot/restore
    moderneq.ts    ModernEQ detection + its saved curve, for handing the bands back
    moods.ts       six curves + sparkline geometry + DSP params
    grid.ts        audio-analysis cache, bar/beat lookup
    chops.ts       chop / screw / spin / loop / tape stop / auto
    clock.ts       worker ticker (main-thread timers get clamped when hidden)
    state.ts       localStorage persistence
  ui/
    deck.ts        chip, panel, pads, readout
    styles.ts      candy paint, chrome, tuck and roll, kick plate
    art.ts         the swanga wheel, chip icon, badge and plate screws, as SVG
    neon.ts        lays text out as bent tube, for the sign and the pitch number
    neon-glyphs.ts generated tube alphabet (scripts/gen-neon.ts)
    fonts.generated.ts generated subset fonts (scripts/gen-fonts.ts)
dsp/
  Sources/SLABDSP/
    TapCapture.swift   Core Audio process tap → ring buffer
    DSPGraph.swift     pitch / low-pass / reverb / delay / tape stop
    ControlServer.swift loopback HTTP control surface
    main.swift         CLI, lifecycle, recording mode
```

- **The grid** comes from `Spicetify.getAudioData(uri)` — Spotify's own beats and bars, in seconds. Cached per track.
- **A chop is a seek** to a bar start. No audio processing, no glitch: the cut lands where a DJ would drop it.
- **The worker clock** exists because Chrome clamps main-thread timers to roughly one second when the Spotify window is occluded. A 40 ms worker tick keeps auto chop and loop on time even when the app is behind another window.
- **The EQ bridge** matches filters by frequency, so a client with a different six-band layout still gets a sane mapping. One dead filter doesn't stop the curve.
- **The tap** uses a private aggregate device with a tap list of dictionaries (`kAudioSubTapUIDKey`). A list of plain UID strings is accepted by the API and silently attaches nothing — that cost an afternoon.

### Dev

```bash
bun install
bun run build        # dist/slab.js
bun run typecheck
bun run inject       # hot-load into a running Spotify over CDP :9222
bun run deploy       # copy into Spicetify's Extensions folder + register
bun run dsp          # build SLAB DSP.app (release)
bun run dsp:install  # build, install to ~/Applications, launch
```

`bun run inject` expects Spotify started with `--remote-debugging-port=9222`.

`window.SLAB` exposes `open()`, `close()`, `toggle()`, `state`, and `destroy()` for poking at it from the console.

---

## Lineage

Chopped and screwed is Houston's. DJ Screw, the Screwed Up Click, and the slabs that carried those tapes. The aesthetic here — candy paint, chrome, cassette shells — is a nod, not a claim.

SLAB is not affiliated with Spotify, Spicetify, or any artist. It ships no recordings.

MIT licensed.

### Fonts and lettering

The panel embeds subsetted cuts of [Barlow Semi Condensed](https://github.com/jpt/barlow) (500, 600, 700) and Barlow Condensed (700) by Jeremy Tribby, under the SIL Open Font License 1.1. `scripts/gen-fonts.ts` builds them into `src/ui/fonts.generated.ts` from the `@fontsource` packages.

The neon lettering is not a font. `scripts/gen-neon.ts` holds hand-drawn single-stroke tube centrelines, written for SLAB and covered by this repository's MIT licence, and writes `src/ui/neon-glyphs.ts`.
