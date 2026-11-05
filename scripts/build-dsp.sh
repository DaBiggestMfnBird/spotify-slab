#!/bin/bash
# Builds "SLAB DSP.app" — a self-contained menu-bar helper that applies real
# pitch / reverb / delay to Spotify's audio on macOS 14.2+.
set -euo pipefail

cd "$(dirname "$0")/.."

CONFIG="${1:-release}"
APP="build/SLAB DSP.app"

swift build -c "$CONFIG" --package-path dsp

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "dsp/.build/$CONFIG/SLABDSP" "$APP/Contents/MacOS/SLABDSP"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>SLAB DSP</string>
    <key>CFBundleDisplayName</key>
    <string>SLAB DSP</string>
    <key>CFBundleIdentifier</key>
    <string>com.slab.dsp</string>
    <key>CFBundleExecutable</key>
    <string>SLABDSP</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.6.1</string>
    <key>CFBundleVersion</key>
    <string>7</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.2</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSAudioCaptureUsageDescription</key>
    <string>SLAB listens to Spotify's audio output so it can apply pitch, reverb, and delay. Nothing is recorded or sent anywhere.</string>
</dict>
</plist>
PLIST

cat > build/slab.entitlements <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.device.audio-input</key>
    <true/>
</dict>
</plist>
EOF

codesign --force --deep --options runtime --entitlements build/slab.entitlements --sign - "$APP" >/dev/null 2>&1 || true

echo "built: $APP"
