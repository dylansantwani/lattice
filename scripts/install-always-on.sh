#!/bin/zsh
#
# Make the iOS client's backend survive everything that normally kills it: quitting the app, a
# crash, a reboot, and — on AC power — closing the lid.
#
# Installs two user LaunchAgents alongside the existing `com.pulsecore.lattice-tunnel`:
#
#   com.pulsecore.lattice-bridge   scripts/lattice-bridge-keeper.sh — supervises Lattice.app, the
#                                  bridge on 127.0.0.1:8973, and the tunnel's public reachability.
#   com.pulsecore.lattice-awake    `caffeinate -s` — holds a PreventSystemSleep assertion so the
#                                  machine keeps serving with the lid shut. macOS only honours this
#                                  assertion on AC power; on battery it sleeps regardless, which is
#                                  the behaviour you want in a bag. See the note this prints at the
#                                  end for the one-line override that also covers battery.
#
# The keeper is *copied* to ~/Library/Application Support/Lattice/bin/ and the agent points at the
# copy, so switching git branches or moving the repo cannot leave launchd running a script that no
# longer exists.
#
# Idempotent — re-run it after editing the keeper to reinstall and restart both agents.
#
set -eu

REPO_DIR="${0:A:h:h}"
LABEL_BRIDGE=com.pulsecore.lattice-bridge
LABEL_AWAKE=com.pulsecore.lattice-awake
LABEL_TUNNEL=com.pulsecore.lattice-tunnel

AGENTS="$HOME/Library/LaunchAgents"
BIN="$HOME/Library/Application Support/Lattice/bin"
KEEPER="$BIN/lattice-bridge-keeper.sh"
DOMAIN="gui/$(id -u)"

CAFFEINATE=/usr/bin/caffeinate
APP_PATH=/Applications/Lattice.app

if [ ! -d "$APP_PATH" ]; then
  echo "error: $APP_PATH is missing — run \`pnpm package\` and copy the bundle to /Applications first" >&2
  exit 1
fi

mkdir -p "$AGENTS" "$BIN"
install -m 0755 "$REPO_DIR/scripts/lattice-bridge-keeper.sh" "$KEEPER"
echo "installed keeper → $KEEPER"

cat > "$AGENTS/$LABEL_BRIDGE.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL_BRIDGE</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>$KEEPER</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/tmp/lattice-bridge-keeper.out</string>
  <key>StandardErrorPath</key><string>/tmp/lattice-bridge-keeper.out</string>
</dict></plist>
PLIST
echo "wrote $AGENTS/$LABEL_BRIDGE.plist"

cat > "$AGENTS/$LABEL_AWAKE.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL_AWAKE</string>
  <key>ProgramArguments</key><array>
    <string>$CAFFEINATE</string><string>-s</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
PLIST
echo "wrote $AGENTS/$LABEL_AWAKE.plist"

for label in "$LABEL_BRIDGE" "$LABEL_AWAKE"; do
  launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$AGENTS/$label.plist"
  launchctl enable "$DOMAIN/$label" >/dev/null 2>&1 || true
  echo "loaded $label"
done

# The tunnel agent predates this script; make sure it is actually loaded rather than assuming it.
if ! launchctl print "$DOMAIN/$LABEL_TUNNEL" >/dev/null 2>&1; then
  if [ -f "$AGENTS/$LABEL_TUNNEL.plist" ]; then
    launchctl bootstrap "$DOMAIN" "$AGENTS/$LABEL_TUNNEL.plist" && echo "loaded $LABEL_TUNNEL"
  else
    echo "warning: $LABEL_TUNNEL is not loaded and its plist is missing — the phone has no public route" >&2
  fi
fi

echo
echo "--- status ---"
for label in "$LABEL_BRIDGE" "$LABEL_AWAKE" "$LABEL_TUNNEL"; do
  printf '%-34s %s\n' "$label" "$(launchctl list | awk -v l="$label" '$3==l {print "pid="$1" last_exit="$2}' || true)"
done

cat <<'NOTE'

--- lid-closed on battery ---
The awake agent uses caffeinate, which macOS honours only on AC power. To keep serving with the lid
shut on battery too, disable lid-close sleep outright (needs your password, survives reboot):

    sudo pmset -a disablesleep 1

Undo with `sudo pmset -a disablesleep 0`. Verify either way with `pmset -g | grep -i sleepdisabled`.
NOTE
