#!/usr/bin/env bash
# Build, bundle, install and (re)launch the LatticeBar menu-bar widget.
#
#   ./build.sh              # compile + refresh ~/Applications/LatticeBar.app + restart the agent
#   ./build.sh --render     # compile + write /tmp/latticebar-{light,dark}.png for visual QA
#   ./build.sh --no-launch  # build + install, but don't (re)start the launchd agent
#
# One source of truth: LatticeBar only renders the JSON that Lattice writes to
#   ~/Library/Application Support/Lattice/stats.json
# so there is nothing to configure — open Lattice once and the widget lights up.
set -euo pipefail

cd "$(dirname "$0")"
SRC="LatticeBar/main.swift"
BIN="LatticeBar/LatticeBar"
APP="$HOME/Applications/LatticeBar.app"
LABEL="com.dylan.latticebar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "→ compiling…"
swiftc -O -parse-as-library -o "$BIN" "$SRC"

if [[ "${1:-}" == "--render" ]]; then
  "$BIN" --render /tmp/latticebar-light.png
  "$BIN" --render /tmp/latticebar-dark.png --dark
  "$BIN" --renderlabel /tmp/latticebar-label.png
  echo "→ wrote /tmp/latticebar-{light,dark,label}.png"
  exit 0
fi

echo "→ bundling $APP…"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
# Keep a timestamped backup of the previous binary, like OmniRouteBar.
if [[ -f "$APP/Contents/MacOS/LatticeBar" ]]; then
  cp "$APP/Contents/MacOS/LatticeBar" "$APP/Contents/MacOS/LatticeBar.bak-$(date +%Y%m%d-%H%M%S)"
fi
cp "$BIN" "$APP/Contents/MacOS/LatticeBar"
codesign --force --deep -s - "$APP" 2>/dev/null || echo "  (ad-hoc codesign skipped)"

if [[ "${1:-}" == "--no-launch" ]]; then
  echo "→ installed (agent not started). Open with: open '$APP'"
  exit 0
fi

echo "→ installing launchd agent $LABEL…"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$APP/Contents/MacOS/LatticeBar</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
echo "✓ LatticeBar running. Health: cat /tmp/latticebar.status"
