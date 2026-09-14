#!/bin/bash
# Move the text gateway (Telegram / iMessage / voice) from this Mac into the relay container, so the
# Mac can SLEEP and texts still get answered — the power-efficient always-on: no caffeinate, no
# clamshell tricks. Requires the relay to be installed first (relay/install.sh).
#
#   bash ~/lattice/scripts/channels-to-relay.sh            # move it
#   bash ~/lattice/scripts/channels-to-relay.sh --check    # preflight only
#   bash ~/lattice/scripts/channels-to-relay.sh --back     # bring the gateway back to the Mac
#
# What it does:
#   1. builds the CLI bundle (the gateway lives in it) and packs <dataDir>/channels (config, owners,
#      pairing) plus the bridge password for the edge;
#   2. installs `lattice-channels.service` in the container: `lattice --remote http://127.0.0.1:8973
#      channels serve` — the edge routes to the Mac while it is up and to the cloud replica while it
#      sleeps, and the relay keeps the conversation thread in sync both ways;
#   3. boots out the Mac's com.lattice.channels launch agent (two pollers on one bot token = 409) and
#      the caffeinate agent (com.pulsecore.lattice-awake) — the Mac no longer needs to stay awake.
#
# While the Mac sleeps the assistant runs on the cloud replica: API-key models only (its default is
# deepseek/deepseek-v4-flash); local models, Claude/Codex OAuth and the 5080 lane come back when the
# Mac wakes. Calls (Vapi) need the gateway reachable from the internet — unchanged, the edge is.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
CT=${LATTICE_RELAY_CT:-149}
JUMPS=(${LATTICE_RELAY_JUMPS:-pve pve-tunnel})
SUPPORT="$HOME/Library/Application Support/Lattice"
CHANNELS="$SUPPORT/channels"
DOMAIN="gui/$(id -u)"
CHANNELS_LABEL=com.lattice.channels
AWAKE_LABEL=com.pulsecore.lattice-awake
PY=/usr/bin/python3

MODE=install
case "${1:-}" in
  --check) MODE=check ;;
  --back) MODE=back ;;
esac

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '    ok  %s\n' "$*"; }
die() { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

JUMP=""
pick_jump() {
  for j in "${JUMPS[@]}"; do
    if ssh -o BatchMode=yes -o ConnectTimeout=8 "$j" "pct status $CT" 2>/dev/null | grep -q running; then JUMP=$j; return 0; fi
  done
  return 1
}
ct_sh() { ssh -o BatchMode=yes "$JUMP" "pct exec $CT -- sh -c $(printf '%q' "$1")"; }

if [ "$MODE" = back ]; then
  say "bring the gateway back to the Mac"
  pick_jump || die "cannot reach CT $CT"
  ct_sh "systemctl disable --now lattice-channels 2>/dev/null || true"
  ok "container gateway stopped"
  [ -f "$HOME/Library/LaunchAgents/disabled/$CHANNELS_LABEL.plist" ] && mv "$HOME/Library/LaunchAgents/disabled/$CHANNELS_LABEL.plist" "$HOME/Library/LaunchAgents/"
  launchctl bootstrap "$DOMAIN" "$HOME/Library/LaunchAgents/$CHANNELS_LABEL.plist" 2>/dev/null || true
  ok "Mac gateway agent restored"
  [ -f "$HOME/Library/LaunchAgents/disabled/$AWAKE_LABEL.plist" ] && mv "$HOME/Library/LaunchAgents/disabled/$AWAKE_LABEL.plist" "$HOME/Library/LaunchAgents/" && launchctl bootstrap "$DOMAIN" "$HOME/Library/LaunchAgents/$AWAKE_LABEL.plist" 2>/dev/null || true
  ok "caffeinate agent restored (the Mac stays awake on power again)"
  exit 0
fi

say "preflight"
for c in node ssh scp tar; do command -v "$c" >/dev/null || die "missing $c"; done
pick_jump || die "cannot reach CT $CT through ${JUMPS[*]} (or it is not running)"
ok "container $CT running (via $JUMP)"
ct_sh "test -f /opt/lattice-cloud/index.cjs && systemctl is-active --quiet lattice-edge" || die "the relay is not installed/running in the container — run relay/install.sh first"
ok "relay edge is up in the container"
[ -f "$CHANNELS/config.json" ] || die "no gateway config at $CHANNELS/config.json — run 'lattice channels setup …' first"
ok "gateway config present"
if [ -z "${LATTICE_PASSWORD:-}" ]; then
  printf '    the container gateway signs in to the edge with the bridge password (Settings → Remote access).\n'
  read -r -s -p '    bridge password: ' LATTICE_PASSWORD; echo
fi
[ -n "$LATTICE_PASSWORD" ] || die "a bridge password is required (export LATTICE_PASSWORD=… to skip the prompt)"
EDGE_OK=$(ct_sh "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8973/auth -H 'content-type: application/json' -d '{\"password\":\"$LATTICE_PASSWORD\",\"device\":\"channels-preflight\"}'" || echo 000)
[ "$EDGE_OK" = 200 ] || die "the edge rejected that password (HTTP $EDGE_OK); check Settings → Remote access"
ok "edge accepts the bridge password"
if [ "$MODE" = check ]; then say "preflight passed (no changes made)"; exit 0; fi

WORK=$(mktemp -d /tmp/lattice-channels-move.XXXXXX)
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
B="$WORK/bundle"
mkdir -p "$B/channels"

say "build the CLI bundle"
(cd "$REPO" && node scripts/build-cli.mjs >/dev/null)
cp "$REPO/out/cli/lattice.cjs" "$B/lattice.cjs"
cp "$REPO/relay/ct/systemd/lattice-channels.service" "$B/lattice-channels.service"
cp "$REPO/relay/ct/install-channels.sh" "$B/install-channels.sh"
for f in config.json state.json; do [ -f "$CHANNELS/$f" ] && cp "$CHANNELS/$f" "$B/channels/$f"; done
printf 'LATTICE_PASSWORD=%s\n' "$LATTICE_PASSWORD" > "$B/channels.env"
chmod 600 "$B/channels.env"
ok "bundle ready"

say "stop the Mac gateway (one poller per bot token)"
launchctl bootout "$DOMAIN/$CHANNELS_LABEL" 2>/dev/null || true
mkdir -p "$HOME/Library/LaunchAgents/disabled"
[ -f "$HOME/Library/LaunchAgents/$CHANNELS_LABEL.plist" ] && mv "$HOME/Library/LaunchAgents/$CHANNELS_LABEL.plist" "$HOME/Library/LaunchAgents/disabled/"
ok "Mac gateway agent retired (plist kept in ~/Library/LaunchAgents/disabled/)"

say "install into CT $CT"
tar -C "$B" -czf "$WORK/bundle.tgz" .
scp -q "$WORK/bundle.tgz" "$JUMP:/tmp/lattice-channels-bundle.tgz"
ssh -o BatchMode=yes "$JUMP" "pct push $CT /tmp/lattice-channels-bundle.tgz /tmp/lattice-channels-bundle.tgz && rm -f /tmp/lattice-channels-bundle.tgz"
ct_sh "rm -rf /tmp/lattice-channels-bundle && mkdir -m 700 /tmp/lattice-channels-bundle && tar -xzf /tmp/lattice-channels-bundle.tgz -C /tmp/lattice-channels-bundle && rm /tmp/lattice-channels-bundle.tgz && sh /tmp/lattice-channels-bundle/install-channels.sh /tmp/lattice-channels-bundle; rc=\$?; rm -rf /tmp/lattice-channels-bundle; exit \$rc"
ok "container gateway running"

say "let the Mac sleep"
launchctl bootout "$DOMAIN/$AWAKE_LABEL" 2>/dev/null || true
[ -f "$HOME/Library/LaunchAgents/$AWAKE_LABEL.plist" ] && mv "$HOME/Library/LaunchAgents/$AWAKE_LABEL.plist" "$HOME/Library/LaunchAgents/disabled/"
ok "caffeinate agent retired — the Mac sleeps normally; texts are answered by the container (cloud replica while asleep)"

say "done"
printf '    status:  ssh %s "pct exec %s -- journalctl -u lattice-channels -n 20 --no-pager"\n' "$JUMP" "$CT"
printf '    undo:    bash %s/scripts/channels-to-relay.sh --back\n' "$REPO"
