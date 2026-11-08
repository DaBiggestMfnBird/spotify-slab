#!/bin/bash
# Installs the already-built "SLAB DSP.app" into ~/Applications and launches it.
# Launching through LaunchServices matters: macOS attributes the audio-capture
# permission to the responsible process, and a binary started from a shell
# inherits the shell's identity (and taps silence).
set -euo pipefail

cd "$(dirname "$0")/.."

APP="build/SLAB DSP.app"
DEST="$HOME/Applications/SLAB DSP.app"

if [ ! -d "$APP" ]; then
    echo "SLAB DSP: $APP not found — run ./scripts/build-dsp.sh release first" >&2
    exit 1
fi

# Stop any running helper first. `open` on an app that is already running only
# brings the old process forward, so it keeps serving the old version on the
# control port.
PATTERN="SLAB DSP.app/Contents/MacOS/SLABDSP"
if pgrep -f "$PATTERN" >/dev/null; then
    echo "SLAB DSP: stopping running helper ($(pgrep -f "$PATTERN" | tr '\n' ' '))"
    pkill -TERM -f "$PATTERN" || true
    for _ in $(seq 1 20); do
        pgrep -f "$PATTERN" >/dev/null || break
        sleep 0.25
    done
    if pgrep -f "$PATTERN" >/dev/null; then
        echo "SLAB DSP: helper did not exit, forcing it"
        pkill -KILL -f "$PATTERN" || true
        sleep 0.5
    fi
fi

mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$APP" "$DEST"

# Re-sign in place so the bundle path change cannot break the signature.
codesign --force --deep --options runtime \
    --entitlements build/slab.entitlements --sign - "$DEST" >/dev/null 2>&1 || true

open "$DEST"

echo "SLAB DSP: installed to $DEST"
echo "SLAB DSP: first launch asks for Audio Recording permission — allow it."
echo "SLAB DSP: control API on http://127.0.0.1:47832/status"
