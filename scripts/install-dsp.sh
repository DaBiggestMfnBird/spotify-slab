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
