#!/bin/bash
# Always-on bridge for the Lattice iOS app. Run once on the Mac:
#
#   bash ~/lattice/relay/install.sh            # install / upgrade, then prove failover end to end
#   bash ~/lattice/relay/install.sh --check    # preflight only, changes nothing
#
# What it does (details in relay/README.md):
#   1. builds the headless runtime and runs the relay test suites;
#   2. snapshots this Mac's lattice.db and prepares it as the cloud replica (Mac-only config removed);
#   3. prepares a cloud OmniRoute: same version, API-key providers only (Claude/Codex OAuth are NOT
#      copied — a second instance refreshing them would sign the Mac's out);
#   4. installs everything into the relay container (Proxmox CT 149) and starts runtime + edge;
#   5. installs the Mac relay agent (launchd com.pulsecore.lattice-relay), baselined on the snapshot;
#   6. moves the lattice.pulse-core.com connector from the Mac into the container, then retires the
#      Mac's com.pulsecore.lattice-tunnel;
#   7. pauses the agent to force a failover to the cloud, checks the public URL, and fails back.
#
# This copies secrets to the container you own: the tunnel token, the OmniRoute storage + encryption key
# (API-key providers), the Lattice client key, and the bridge's password hash + device tokens (inside the
# database). Rollback steps: relay/README.md, "Operate".
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
CT=${LATTICE_RELAY_CT:-149}
JUMPS=(${LATTICE_RELAY_JUMPS:-pve pve-tunnel})
PUBLIC_URL=${LATTICE_PUBLIC_URL:-https://lattice.pulse-core.com}
SUPPORT="$HOME/Library/Application Support/Lattice"
RELAY="$SUPPORT/relay"
MAC_DB="$SUPPORT/data/lattice.db"
KEY="$HOME/.ssh/lattice_relay_ed25519"
TUNNEL_TOKEN="$HOME/.lattice-tunnel/token"
OMNI_DIR="$HOME/.omniroute"
OMNI_PKG="$HOME/.local/lib/node_modules/omniroute"
AGENT_LABEL=com.pulsecore.lattice-relay
TUNNEL_LABEL=com.pulsecore.lattice-tunnel
DOMAIN="gui/$(id -u)"
PY=/usr/bin/python3

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

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

# ------------------------------------------------------------------ preflight
say "preflight"
for c in node ssh scp ssh-keygen sqlite3 curl gzip; do command -v "$c" >/dev/null || die "missing $c"; done
[ -x "$PY" ] || die "missing $PY"
pick_jump || die "cannot reach CT $CT through ${JUMPS[*]} (or it is not running)"
ok "container $CT running (via $JUMP)"
curl -sf --max-time 4 http://127.0.0.1:8973/health >/dev/null || die "Lattice.app bridge is not answering on 127.0.0.1:8973 — open Lattice first"
ok "Mac bridge healthy"
[ -s "$MAC_DB" ] || die "no database at $MAC_DB"
[ -s "$TUNNEL_TOKEN" ] || die "no tunnel token at $TUNNEL_TOKEN"
ok "tunnel token present"
OMNI_KEY=$(sed -n 's/.*OMNI_KEY:-\([A-Za-z0-9._-]*\).*/\1/p' "$HOME/.local/bin/omni-cc" 2>/dev/null | head -1)
[ -n "$OMNI_KEY" ] || die "cannot discover the Lattice OmniRoute client key from ~/.local/bin/omni-cc"
ok "OmniRoute client key discovered"
[ -f "$OMNI_DIR/storage.sqlite" ] && [ -f "$OMNI_DIR/.env" ] && [ -f "$OMNI_PKG/package.json" ] || die "OmniRoute install/data not found"
OMNI_VER=$(node -p "require('$OMNI_PKG/package.json').version")
ok "OmniRoute $OMNI_VER"
FREE_KB=$(ct_sh "df -Pk / | awk 'NR==2{print \$4}'")
[ "$FREE_KB" -gt 6000000 ] || die "container has less than 6 GB free (${FREE_KB} KB)"
ok "container disk: $((FREE_KB / 1024 / 1024)) GB free"
if [ "$CHECK_ONLY" = 1 ]; then say "preflight passed (no changes made)"; exit 0; fi

WORK=$(mktemp -d /tmp/lattice-relay-install.XXXXXX)
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
B="$WORK/bundle"
mkdir -p "$B/sync" "$B/edge" "$B/ct/systemd" "$B/omniroute/patches"

# ------------------------------------------------------------------ build + test
say "build headless runtime + test relay"
(cd "$REPO" && node scripts/build-headless.mjs >/dev/null)
(cd "$REPO" && "$PY" -m unittest discover -s relay/sync/tests >/dev/null 2>&1) || die "relay sync tests failed (python3 -m unittest discover -s relay/sync/tests)"
(cd "$REPO" && node --test relay/edge/lattice-edge.test.mjs >/dev/null 2>&1) || die "edge tests failed (node --test relay/edge/lattice-edge.test.mjs)"
(cd "$REPO" && "$PY" -m unittest discover -s relay/mac/tests >/dev/null 2>&1) || die "agent tests failed (python3 -m unittest discover -s relay/mac/tests)"
ok "tests pass"
cp "$REPO/out/headless/index.cjs" "$B/index.cjs"
cp "$REPO/relay/sync/lattice_relay_sync.py" "$B/sync/"
cp "$REPO/relay/edge/lattice-edge.mjs" "$B/edge/"
cp "$REPO/relay/ct/lattice-relay-remote" "$REPO/relay/ct/sshd-lattice-relay.conf" "$REPO/relay/ct/install-ct.sh" "$B/ct/"
cp "$REPO"/relay/ct/systemd/*.service "$B/ct/systemd/"

# ------------------------------------------------------------------ agent key
say "relay agent key"
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "lattice-relay@$(hostname -s)" -f "$KEY"
cp "$KEY.pub" "$B/relay_ed25519.pub"
ok "$KEY"

# ------------------------------------------------------------------ database seed
say "snapshot + prepare the cloud database"
"$PY" "$REPO/relay/sync/lattice_relay_sync.py" backup --db "$MAC_DB" --out "$WORK/cloud.db" >/dev/null
"$PY" - "$REPO/relay/sync" "$WORK/cloud.db" "$WORK/marks.json" <<'PYEOF'
import json, sys
sys.path.insert(0, sys.argv[1])
import lattice_relay_sync as rs
marks = rs.Store(sys.argv[2], "mac").watermarks()
json.dump(marks, open(sys.argv[3], "w"))
print(f"    ok  snapshot marks: events<= {marks['events']}")
PYEOF
PROVIDERS='[{"id":"01M1Q3WKKVYHGK891Q8N8R4NDN","label":"OmniRoute","kind":"openai-compat","baseUrl":"http://127.0.0.1:20128","apiKey":"","enabled":true,"promptCaching":true}]'
"$PY" "$REPO/relay/sync/lattice_relay_sync.py" prepare-cloud --db "$WORK/cloud.db" --providers-json "$PROVIDERS" \
  --default-model deepseek/deepseek-v4-flash --port 8975 --cloud-root /var/lib/lattice-cloud/workspace >/dev/null
gzip -1 -c "$WORK/cloud.db" > "$B/cloud.db.gz"
rm -f "$WORK/cloud.db"
ok "cloud.db.gz $(du -h "$B/cloud.db.gz" | cut -f1)"

# ------------------------------------------------------------------ omniroute seed
say "prepare cloud OmniRoute (API-key providers only)"
sqlite3 "$OMNI_DIR/storage.sqlite" ".backup '$WORK/storage.sqlite'"
sqlite3 "$WORK/storage.sqlite" <<'SQL'
DELETE FROM provider_connections WHERE auth_type = 'oauth';
DELETE FROM provider_connections WHERE json_extract(provider_specific_data, '$.baseUrl') LIKE 'http://127.0.0.1:11435%'
   OR json_extract(provider_specific_data, '$.baseUrl') LIKE 'http://localhost:11434%'
   OR json_extract(provider_specific_data, '$.baseUrl') LIKE 'http://127.0.0.1:20129%'
   OR json_extract(provider_specific_data, '$.baseUrl') LIKE 'http://127.0.0.1:8091%';
-- the 5080 lane is only reachable through the Mac's SSH tunnel; keep its catalog, park the connection
UPDATE provider_connections SET is_active = 0 WHERE json_extract(provider_specific_data, '$.baseUrl') LIKE 'http://127.0.0.1:8092%';
DELETE FROM call_logs; DELETE FROM proxy_logs; DELETE FROM usage_history; DELETE FROM domain_cost_history;
DELETE FROM quota_snapshots; DELETE FROM compression_analytics; DELETE FROM xp_audit_log; DELETE FROM session_model_history;
DELETE FROM job_runs; DELETE FROM agentic_conversations; DELETE FROM conversation_turn_nodes; DELETE FROM native_usage_ledger;
DELETE FROM semantic_cache;
VACUUM;
SQL
gzip -1 -c "$WORK/storage.sqlite" > "$B/omniroute/storage.sqlite.gz"
rm -f "$WORK/storage.sqlite"
grep -v '^OMNIROUTE_SERVER_HOST=' "$OMNI_DIR/.env" > "$B/omniroute/env"
printf '\nOMNIROUTE_SERVER_HOST=127.0.0.1\n' >> "$B/omniroute/env"
cp "$OMNI_DIR"/patches/*.patch.mjs "$B/omniroute/patches/"
echo "$OMNI_VER" > "$B/omniroute/version"
printf 'OMNI_KEY=%s\n' "$OMNI_KEY" > "$B/omni.env"
printf 'TUNNEL_TOKEN=%s\n' "$(tr -d '\n' < "$TUNNEL_TOKEN")" > "$B/tunnel.env"
chmod 600 "$B/omni.env" "$B/tunnel.env" "$B/omniroute/env"
ok "omniroute bundle ready"

# ------------------------------------------------------------------ install in the container
say "install into CT $CT (this installs OmniRoute from npm the first time — several minutes)"
tar -C "$B" -czf "$WORK/bundle.tgz" .
scp -q "$WORK/bundle.tgz" "$JUMP:/tmp/lattice-relay-bundle.tgz"
ssh -o BatchMode=yes "$JUMP" "pct push $CT /tmp/lattice-relay-bundle.tgz /tmp/lattice-relay-bundle.tgz && rm -f /tmp/lattice-relay-bundle.tgz"
ct_sh "rm -rf /tmp/lattice-relay-bundle && mkdir -m 700 /tmp/lattice-relay-bundle && tar -xzf /tmp/lattice-relay-bundle.tgz -C /tmp/lattice-relay-bundle && rm /tmp/lattice-relay-bundle.tgz && sh /tmp/lattice-relay-bundle/ct/install-ct.sh /tmp/lattice-relay-bundle; rc=\$?; rm -rf /tmp/lattice-relay-bundle; exit \$rc"
CT_HOST=$(ct_sh "hostname -I" | tr ' ' '\n' | grep -m1 -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
[ -n "$CT_HOST" ] || die "could not read the container address"
ok "container address $CT_HOST"

# ------------------------------------------------------------------ mac agent
say "Mac relay agent"
mkdir -p "$RELAY/bin" "$RELAY/trash"
install -m 0644 "$REPO/relay/sync/lattice_relay_sync.py" "$RELAY/bin/lattice_relay_sync.py"
install -m 0755 "$REPO/relay/mac/lattice_relay_agent.py" "$RELAY/bin/lattice_relay_agent.py"
cat > "$RELAY/config.json" <<JSON
{"ct_id": $CT, "ct_host": "$CT_HOST", "jumps": ["pve", "pve-tunnel"]}
JSON
launchctl bootout "$DOMAIN/$AGENT_LABEL" 2>/dev/null || true
rm -f "$RELAY/state.json"
"$PY" "$RELAY/bin/lattice_relay_agent.py" baseline "$WORK/marks.json" | sed 's/^/    /'
cat > "$HOME/Library/LaunchAgents/$AGENT_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$PY</string><string>$RELAY/bin/lattice_relay_agent.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/tmp/lattice-relay-agent.out</string>
  <key>StandardErrorPath</key><string>/tmp/lattice-relay-agent.out</string>
</dict></plist>
PLIST
launchctl bootstrap "$DOMAIN" "$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
edge_backend() { ct_sh "curl -s http://127.0.0.1:8973/edge/status" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["backend"])' 2>/dev/null || echo unknown; }
for i in $(seq 1 60); do [ "$(edge_backend)" = mac ] && break; sleep 3; done
[ "$(edge_backend)" = mac ] || die "the edge never saw the Mac (see /tmp/lattice-relay-agent.log and $RELAY/status.json)"
ok "edge routes to the Mac through the agent's forward"

# keeper: relay-aware copy (it must not kick the retired Mac tunnel)
if [ -f "$SUPPORT/bin/lattice-bridge-keeper.sh" ]; then
  install -m 0755 "$REPO/scripts/lattice-bridge-keeper.sh" "$SUPPORT/bin/lattice-bridge-keeper.sh"
  launchctl kickstart -k "$DOMAIN/com.pulsecore.lattice-bridge" 2>/dev/null || true
  ok "keeper updated"
fi

# ------------------------------------------------------------------ tunnel cutover
say "move the lattice.pulse-core.com connector into the container"
ct_sh "systemctl enable --now lattice-tunnel"
for i in $(seq 1 30); do
  ct_sh "journalctl -u lattice-tunnel --since '-3 min' --no-pager 2>/dev/null | grep -c 'Registered tunnel connection'" 2>/dev/null | grep -qv '^0$' && break
  sleep 2
done
ct_sh "journalctl -u lattice-tunnel --since '-3 min' --no-pager | grep -q 'Registered tunnel connection'" || die "container connector did not register (journalctl -u lattice-tunnel)"
ok "container connector registered"
launchctl bootout "$DOMAIN/$TUNNEL_LABEL" 2>/dev/null || true
mkdir -p "$HOME/Library/LaunchAgents/disabled"
[ -f "$HOME/Library/LaunchAgents/$TUNNEL_LABEL.plist" ] && mv "$HOME/Library/LaunchAgents/$TUNNEL_LABEL.plist" "$HOME/Library/LaunchAgents/disabled/"
ok "Mac connector retired (plist kept in ~/Library/LaunchAgents/disabled/)"

public_backend() { curl -s -o /dev/null -D - --max-time 10 "$PUBLIC_URL/health" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-lattice-backend"{print $2}'; }
for i in $(seq 1 30); do [ "$(public_backend)" = mac ] && break; sleep 2; done
[ "$(public_backend)" = mac ] || die "$PUBLIC_URL is not answering through the edge"
ok "$PUBLIC_URL -> container edge -> Mac"

# ------------------------------------------------------------------ failover proof
say "failover test: pause the agent (Mac leaves), then resume (Mac returns)"
T0=$(date +%s)
touch "$HOME/.lattice-relay-pause"
for i in $(seq 1 40); do [ "$(public_backend)" = cloud ] && break; sleep 2; done
if [ "$(public_backend)" != cloud ]; then rm -f "$HOME/.lattice-relay-pause"; die "public URL never failed over to the cloud"; fi
ok "public URL served by the cloud after $(( $(date +%s) - T0 ))s"
curl -sf --max-time 10 "$PUBLIC_URL/health" >/dev/null && ok "health 200 while the Mac is away"
T1=$(date +%s)
rm -f "$HOME/.lattice-relay-pause"
for i in $(seq 1 60); do [ "$(public_backend)" = mac ] && break; sleep 2; done
[ "$(public_backend)" = mac ] || die "did not fail back to the Mac (see $RELAY/status.json)"
ok "failed back to the Mac after $(( $(date +%s) - T1 ))s"

say "installed"
cat <<EOF
  status (Mac):      cat "$RELAY/status.json"; tail -f /tmp/lattice-relay-agent.log
  status (public):   curl -s $PUBLIC_URL/edge/status
  status (cloud):    ssh $JUMP "pct exec $CT -- systemctl status lattice-edge lattice-cloud lattice-tunnel omniroute"
  pause the Mac:     touch ~/.lattice-relay-pause     (phone moves to the cloud; rm to return)
  rollback:          see $REPO/relay/README.md ("Operate")

  While the Mac is away the cloud runs chats on API-key models (DeepSeek, OpenRouter, OpenCode Zen,
  Fireworks, NVIDIA). Claude/Codex subscriptions and the 5080 models stay Mac-only.
EOF
