"""SLAB DSP for Windows on a real Windows audio stack.

A stand-in for Spotify (Windows PowerShell looping a 1 kHz tone) plays to the default output. SLAB DSP
taps it by process name, as it taps Spotify.exe, and plays it through its engine to the same output.
What reaches the output is recorded through its loopback and measured:

- before SLAB DSP: the stand-in's tone, at its level;
- through SLAB DSP at -700 cents: the tone at 667 Hz, at that level, with the stand-in's own output
  turned down out of the way;
- through SLAB DSP at 0 cents: the tone as it was, at its level;
- a chop is taken;
- after SLAB DSP quits: the stand-in at its level again, its volume given back.

Recordings, the status SLAB DSP reported and its log go to live/ for the run's artifact.

    python scripts/windows-live-check.py --zip release/SLAB-DSP-Windows-x.y.z.zip
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import wave
import zipfile

import numpy as np
import soundcard as sc

RATE = 48_000
OUT = "live"
PORT = 47_832
TONE = 1_000.0
AMPLITUDE = 0.3
SCREWED = TONE * 2 ** (-700 / 1200)

results = []


def check(name, ok, detail):
    results.append({"check": name, "ok": bool(ok), "detail": detail})
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}", flush=True)


def db(value):
    return 20 * math.log10(max(value, 1e-12))


def write_wav(path, samples):
    """Mono float samples to a 16-bit WAV."""
    data = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data.tobytes())


def tone_wav(path, seconds=2.0):
    """A whole number of cycles, so it loops without a seam."""
    t = np.arange(int(RATE * seconds)) / RATE
    x = (AMPLITUDE * np.sin(2 * np.pi * TONE * t) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(np.repeat(x[:, None], 2, axis=1).tobytes())


def record(seconds, name):
    """What the default output plays, through its loopback: the left channel."""
    speaker = sc.default_speaker()
    loopback = sc.get_microphone(id=str(speaker.name), include_loopback=True)
    data = loopback.record(samplerate=RATE, numframes=int(RATE * seconds))
    left = np.asarray(data)[:, 0]
    write_wav(os.path.join(OUT, f"{name}.wav"), left)
    return left


def level(x, hz):
    """The amplitude of the part of `x` at `hz`, through a Hann window."""
    window = np.hanning(len(x))
    t = np.arange(len(x)) / RATE
    return float(2 * abs(np.sum(x * window * np.exp(-2j * np.pi * hz * t))) / np.sum(window))


def dominant(x):
    """The loudest frequency in `x`, between bins."""
    spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    k = int(np.argmax(spectrum[1:-1]) + 1)
    a, b, c = spectrum[k - 1], spectrum[k], spectrum[k + 1]
    shift = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0
    return (k + shift) * RATE / len(x)


def status():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/status", timeout=3) as r:
        return json.load(r)


def post(path, body):
    request = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", required=True)
    args = parser.parse_args()
    os.makedirs(OUT, exist_ok=True)

    app = os.path.abspath(os.path.join(OUT, "app"))
    with zipfile.ZipFile(args.zip) as z:
        z.extractall(app)
    exe = os.path.join(app, "SLAB DSP", "SLAB DSP.exe")
    speaker = sc.default_speaker()
    print(f"output: {speaker.name}", flush=True)

    tone = os.path.abspath(os.path.join(OUT, "tone.wav"))
    tone_wav(tone)
    others = subprocess.run(["tasklist", "/FI", "IMAGENAME eq powershell.exe"], capture_output=True, text=True).stdout
    print(f"powershell.exe before the stand-in starts:\n{others}", flush=True)
    # The stand-in: Windows PowerShell, so SLAB DSP can find it by name, looping the tone.
    player = subprocess.Popen(
        ["powershell.exe", "-NoProfile", "-Command",
         f"$p = New-Object System.Media.SoundPlayer '{tone}'; $p.PlayLooping(); Start-Sleep 600"]
    )
    time.sleep(3)

    before = record(1.5, "1-before")
    base = level(before, TONE)
    check("the stand-in is heard", base > 0.05, f"1 kHz at {db(base):.1f} dBFS")

    helper = subprocess.Popen([exe, "--process", "powershell.exe", "--port", str(PORT), "--seconds", "120"])
    tapping = None
    for _ in range(60):
        time.sleep(0.5)
        try:
            s = status()
        except Exception:
            continue
        if s.get("link") == "tapping" and s.get("audio"):
            tapping = s
            break
    check("SLAB DSP taps the stand-in", tapping is not None, json.dumps(tapping or status(), sort_keys=True)[:400])
    if tapping is None:
        return finish(helper, player)

    code, _ = post("/params", {"pitch": -700})
    check("a mood is taken", code == 200, f"/params answered {code}")
    time.sleep(2.5)
    through = record(2.0, "2-screwed")
    heard = dominant(through)
    # Its level where it is: a 2 s window resolves 0.5 Hz, so a tone a cent or two off its nominal
    # frequency would read several dB low there.
    screwed = level(through, heard)
    own = level(through, TONE)
    cents = 1200 * math.log2(heard / SCREWED)
    check("the tone comes out 700 cents down", abs(cents) < 10, f"loudest at {heard:.1f} Hz, {SCREWED:.1f} wanted ({cents:+.1f} cents)")
    check("at the stand-in's level", abs(db(screwed) - db(base)) < 3, f"{db(screwed):.1f} dBFS against {db(base):.1f}")
    check("the stand-in's own output is out of the way", db(own) - db(screwed) < -40, f"its 1 kHz {db(own) - db(screwed):.1f} dB under SLAB's")

    code, _ = post("/params", {"pitch": 0})
    time.sleep(2.0)
    neutral = record(1.5, "3-neutral")
    plain = dominant(neutral)
    check("at 0 cents the tone is as it was", abs(plain - TONE) < 3, f"loudest at {plain:.1f} Hz")
    check("SLAB plays it at the stand-in's own level", abs(db(level(neutral, plain)) - db(base)) < 2,
          f"{db(level(neutral, plain)):.1f} dBFS against {db(base):.1f}")

    code, answer = post("/jump", {"backMs": 500, "availableMs": 4000, "seekAheadMs": 300})
    time.sleep(1.0)
    jumps = status().get("chops", {}).get("jumps", 0)
    check("a chop is taken", code == 200 and jumps >= 1, f"/jump answered {code} {answer}, jumps {jumps}")

    s = status()
    with open(os.path.join(OUT, "status.json"), "w") as f:
        json.dump(s, f, indent=2, sort_keys=True)
    came = s.get("asItCame", 0)
    callbacks = s.get("callbacks", 0)
    print(f"capture: {callbacks} packets, {came} of them not turned down; latency {s.get('latencyMs')} ms, "
          f"{s.get('sampleRate')} Hz", flush=True)
    check("Windows hears the stand-in after its volume", came <= max(5, callbacks // 20),
          f"{came} of {callbacks} packets came in not turned down")

    code, _ = post("/quit", {})
    try:
        helper.wait(timeout=15)
        check("SLAB DSP quits when asked", True, f"exit code {helper.returncode}")
    except subprocess.TimeoutExpired:
        check("SLAB DSP quits when asked", False, "still running 15 s after /quit")
    time.sleep(2.0)
    after = record(1.5, "4-after")
    check("quitting gives the stand-in its volume back", abs(db(level(after, TONE)) - db(base)) < 2,
          f"1 kHz at {db(level(after, TONE)):.1f} dBFS against {db(base):.1f}")
    return finish(helper, player)


def finish(helper, player):
    for p in (helper, player):
        if p.poll() is None:
            p.kill()
    log = os.path.join(os.environ.get("LOCALAPPDATA", ""), "SLAB", "dsp.log")
    if os.path.exists(log):
        shutil.copy(log, os.path.join(OUT, "dsp.log"))
        print("--- dsp.log", flush=True)
        with open(log, encoding="utf-8", errors="replace") as f:
            print(f.read()[-4000:], flush=True)
    with open(os.path.join(OUT, "results.json"), "w") as f:
        json.dump(results, f, indent=2)
    failed = [r for r in results if not r["ok"]]
    print(f"{len(results) - len(failed)} of {len(results)} checks passed", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
