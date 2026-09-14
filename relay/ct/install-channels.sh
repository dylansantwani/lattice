#!/bin/sh
# Runs as root INSIDE the relay container (CT 149), driven by scripts/channels-to-relay.sh on the Mac,
# which unpacks the bundle to $BUNDLE first. Installs the text gateway (Telegram / iMessage / voice) as
# a systemd unit that talks to the edge with --remote, so texts keep being answered while the Mac sleeps.
#
#   $BUNDLE/lattice.cjs               the Lattice CLI bundle (scripts/build-cli.mjs) — `channels serve` lives in it
#   $BUNDLE/channels/                 the Mac's <dataDir>/channels tree: config.json, state.json (owners, pairing)
#   $BUNDLE/channels.env              LATTICE_PASSWORD (or LATTICE_TOKEN) for the edge, 0600 in the bundle
#   $BUNDLE/lattice-channels.service  the unit
set -eu
BUNDLE=${1:-/tmp/lattice-channels-bundle}
say() { printf '[ct] %s\n' "$*"; }
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[ -f /opt/lattice-cloud/index.cjs ] || { echo "the relay runtime is not installed here (run relay/install.sh first)" >&2; exit 1; }
id lattice >/dev/null 2>&1 || { echo "no lattice user — run relay/install.sh first" >&2; exit 1; }

say "code"
install -m 0644 "$BUNDLE/lattice.cjs" /opt/lattice-cloud/lattice.cjs
install -m 0644 "$BUNDLE/lattice-channels.service" /etc/systemd/system/lattice-channels.service

say "state"
mkdir -p /var/lib/lattice-channels/channels
systemctl stop lattice-channels 2>/dev/null || true
# The gateway's own runtime files (socket, log) are Mac-specific; config + state are what matter.
for f in config.json state.json; do
  [ -f "$BUNDLE/channels/$f" ] && install -m 0600 "$BUNDLE/channels/$f" "/var/lib/lattice-channels/channels/$f"
done
chown -R lattice:lattice /var/lib/lattice-channels

say "secrets"
install -m 0640 -o root -g lattice "$BUNDLE/channels.env" /etc/lattice/channels.env

say "start"
systemctl daemon-reload
systemctl enable --now lattice-channels
sleep 3
if systemctl is-active --quiet lattice-channels; then
  say "lattice-channels is running"
  journalctl -u lattice-channels -n 5 --no-pager || true
else
  journalctl -u lattice-channels -n 40 --no-pager || true
  echo "lattice-channels did not stay up" >&2
  exit 1
fi
