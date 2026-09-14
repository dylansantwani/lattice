#!/bin/sh
# Runs as root INSIDE the relay container (Proxmox CT 149), driven by relay/install.sh on the Mac, which
# unpacks the bundle to $BUNDLE first. Idempotent: re-running upgrades code, units and data in place.
#
#   $BUNDLE/index.cjs                      headless Lattice runtime (scripts/build-headless.mjs)
#   $BUNDLE/sync/lattice_relay_sync.py     replication server (relay/sync)
#   $BUNDLE/edge/lattice-edge.mjs          front door (relay/edge)
#   $BUNDLE/ct/...                         forced command, sshd drop-in, systemd units
#   $BUNDLE/relay_ed25519.pub              the Mac agent's key (forced command, reverse forward only)
#   $BUNDLE/cloud.db.gz                    seed: the Mac database, prepared for the cloud (optional on upgrade)
#   $BUNDLE/omniroute/                     storage.sqlite.gz, env, patches, version (optional on upgrade)
#   $BUNDLE/omni.env, $BUNDLE/tunnel.env   secrets (0600 in the bundle; installed 0640 root:lattice)
set -eu
BUNDLE=${1:-/tmp/lattice-relay-bundle}
say() { printf '[ct] %s\n' "$*"; }
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

say "packages"
if ! command -v sqlite3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sqlite3 curl ca-certificates >/dev/null
fi

say "user + directories"
id lattice >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/lattice --shell /bin/sh lattice
mkdir -p /opt/lattice-cloud /opt/lattice-relay/sync /opt/lattice-relay/edge /var/lib/lattice-cloud/data \
  /var/lib/lattice-cloud/workspace /var/lib/lattice-cloud/relay-trash /etc/lattice /home/lattice/.ssh
chown root:lattice /etc/lattice && chmod 0750 /etc/lattice

say "code"
install -m 0644 "$BUNDLE/index.cjs" /opt/lattice-cloud/index.cjs
if [ ! -d /opt/lattice-cloud/node_modules/better-sqlite3 ]; then
  if [ -d /opt/lattice/node_modules/better-sqlite3 ]; then
    cp -a /opt/lattice/node_modules /opt/lattice/package.json /opt/lattice-cloud/
  else
    printf '{"name":"lattice-cloud","private":true,"dependencies":{"better-sqlite3":"^13.0.3","node-pty":"^1.1.0","ws":"^8.18.0"}}\n' > /opt/lattice-cloud/package.json
    (cd /opt/lattice-cloud && npm install --omit=dev --no-audit --no-fund)
  fi
fi
install -m 0644 "$BUNDLE/sync/lattice_relay_sync.py" /opt/lattice-relay/sync/lattice_relay_sync.py
install -m 0644 "$BUNDLE/edge/lattice-edge.mjs" /opt/lattice-relay/edge/lattice-edge.mjs
install -m 0755 "$BUNDLE/ct/lattice-relay-remote" /usr/local/bin/lattice-relay-remote
install -m 0644 "$BUNDLE/ct/sshd-lattice-relay.conf" /etc/ssh/sshd_config.d/lattice-relay.conf
for unit in "$BUNDLE"/ct/systemd/*.service; do install -m 0644 "$unit" /etc/systemd/system/; done
chown -R root:root /opt/lattice-cloud /opt/lattice-relay && chmod -R a+rX /opt/lattice-cloud /opt/lattice-relay
chown -R lattice:lattice /var/lib/lattice-cloud /home/lattice
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
systemctl daemon-reload

say "agent key (forced command, reverse forward to 127.0.0.1:18973 only)"
PUB=$(cat "$BUNDLE/relay_ed25519.pub")
printf 'command="/usr/local/bin/lattice-relay-remote",restrict,port-forwarding,permitlisten="127.0.0.1:18973" %s\n' "$PUB" > /home/lattice/.ssh/authorized_keys
chown -R lattice:lattice /home/lattice/.ssh && chmod 700 /home/lattice/.ssh && chmod 600 /home/lattice/.ssh/authorized_keys

say "secrets"
for f in omni.env tunnel.env; do
  if [ -f "$BUNDLE/$f" ]; then
    install -m 0640 -o root -g lattice "$BUNDLE/$f" "/etc/lattice/$f"
  fi
done

if [ -d "$BUNDLE/omniroute" ]; then
  say "omniroute (cloud instance, API-key providers only)"
  VER=$(cat "$BUNDLE/omniroute/version")
  PKG=$(npm root -g)/omniroute
  if [ ! -f "$PKG/package.json" ] || ! grep -q "\"version\": \"$VER\"" "$PKG/package.json"; then
    npm install -g "omniroute@$VER" --no-audit --no-fund
  fi
  mkdir -p /opt/omniroute-patches /home/lattice/.omniroute
  install -m 0644 "$BUNDLE"/omniroute/patches/*.mjs /opt/omniroute-patches/
  systemctl stop omniroute 2>/dev/null || true
  if [ -f "$BUNDLE/omniroute/storage.sqlite.gz" ]; then
    rm -f /home/lattice/.omniroute/storage.sqlite-wal /home/lattice/.omniroute/storage.sqlite-shm
    gunzip -c "$BUNDLE/omniroute/storage.sqlite.gz" > /home/lattice/.omniroute/storage.sqlite
  fi
  install -m 0600 "$BUNDLE/omniroute/env" /home/lattice/.omniroute/.env
  chown -R lattice:lattice /home/lattice/.omniroute
  # The patchers rewrite the installed package in place; run them as root so the package stays root-owned.
  cat > /etc/systemd/system/omniroute.service <<UNIT
[Unit]
Description=OmniRoute (cloud instance for the Lattice relay)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=lattice
Group=lattice
Environment=HOME=/home/lattice
Environment=DATA_DIR=/home/lattice/.omniroute
Environment=OMNIROUTE_PKG=$PKG
Environment=OMNIROUTE_STORAGE_DB=/home/lattice/.omniroute/storage.sqlite
Environment=NODE_OPTIONS=--max-old-space-size=1536
ExecStartPre=+-/usr/bin/node /opt/omniroute-patches/omniroute-catalog-user-pricing.patch.mjs
ExecStartPre=+-/usr/bin/node /opt/omniroute-patches/omniroute-deepseek-resilience.patch.mjs
ExecStart=/usr/bin/node $PKG/bin/omniroute.mjs serve --no-open --no-tray
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now omniroute
  for i in $(seq 1 60); do
    curl -sf -o /dev/null http://127.0.0.1:20128/ && break
    sleep 2
  done
  . /etc/lattice/omni.env
  MODELS=$(curl -s http://127.0.0.1:20128/v1/models -H "Authorization: Bearer $OMNI_KEY" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("data",[])))' 2>/dev/null || echo 0)
  say "omniroute serving $MODELS models"
fi

say "retire the pre-relay backend (kept on disk)"
for old in lattice-quicktunnel lattice-backend; do
  systemctl disable --now "$old" 2>/dev/null || true
done
if [ -d /var/lib/lattice ] && [ ! -e /var/lib/lattice.pre-relay ]; then
  mv /var/lib/lattice /var/lib/lattice.pre-relay
fi

if [ -f "$BUNDLE/cloud.db.gz" ]; then
  say "seed the cloud database"
  systemctl stop lattice-edge lattice-cloud 2>/dev/null || true
  DB=/var/lib/lattice-cloud/data/lattice.db
  if [ -f "$DB" ]; then
    mv "$DB" "$DB.replaced-$(date +%Y%m%d%H%M%S)"
    rm -f "$DB-wal" "$DB-shm"
  fi
  gunzip -c "$BUNDLE/cloud.db.gz" > "$DB"
  chown lattice:lattice "$DB"
fi

say "start runtime + edge"
systemctl enable --now lattice-cloud
for i in $(seq 1 45); do
  curl -sf -o /dev/null http://127.0.0.1:8975/health && break
  sleep 1
done
curl -sf http://127.0.0.1:8975/health >/dev/null || { journalctl -u lattice-cloud -n 40 --no-pager; echo "lattice-cloud did not come up" >&2; exit 1; }
systemctl enable --now lattice-edge
sleep 3
curl -sf http://127.0.0.1:8973/edge/status || { journalctl -u lattice-edge -n 40 --no-pager; exit 1; }
echo
say "done (tunnel connector is started separately by the Mac installer)"
