#!/bin/zsh
#
# Keep the iOS client's backend reachable, unattended.
#
# `lattice.pulse-core.com` is a Cloudflare tunnel whose ingress is `http://127.0.0.1:8973` — the
# desktop app's remote bridge, which lives *inside* the Electron main process (`syncBridge()` in
# `src/main/ipc.ts`). So the phone depends on three things at once, and the failure of any one of
# them surfaces on the phone as the same useless "tunnel is down" / HTTP 502:
#
#   1. the Mac is awake            → nothing runs at all when it sleeps
#   2. Lattice.app is running      → quit it, or reboot without relaunching, and the origin is gone
#   3. cloudflared is registered   → the app can be healthy while the tunnel is not
#
# Login Items covers only a slice of (2): it launches the app once, at login, and never looks again.
# This script closes the rest. It is the long-running program behind the
# `com.pulsecore.lattice-bridge` LaunchAgent, and it does three things forever:
#
#   - probes the bridge's unauthenticated `GET /health` every INTERVAL seconds, which is a real
#     liveness check of the Electron main process's event loop (not just "is the pid alive");
#   - relaunches the app when nothing is listening, and — only after the bridge has been dead for
#     RESTART_AFTER consecutive probes with the app *running*, which means the process is up but
#     wedged or the bridge failed to bind — quits and relaunches it, so `syncBridge()` runs again;
#   - re-probes the *public* URL every PUBLIC_EVERY iterations and kicks the tunnel agent when the
#     origin is healthy but Cloudflare cannot see it. That combination is invisible from the Mac
#     and is exactly what the phone reports as the tunnel being down.
#
# Sleep — (1) — is not solvable from here; it is a power assertion, held by the companion
# `com.pulsecore.lattice-awake` agent. See docs/desktop-app.md.
#
# Install with `scripts/install-always-on.sh`. Env overrides: LAT_PORT, LAT_PUBLIC_URL,
# LAT_KEEPER_INTERVAL, LAT_KEEPER_RESTART_AFTER, LAT_KEEPER_PUBLIC_EVERY.
#
# Touch ~/.lattice-keeper-pause to make the keeper stand down without unloading it — necessary
# before `pnpm dev`, since the packaged app and the dev instance fight over port 8973 and this
# script would otherwise relaunch the packaged app the moment you quit it.
#
set -u

PORT="${LAT_PORT:-8973}"
PUBLIC_URL="${LAT_PUBLIC_URL:-https://lattice.pulse-core.com}"
INTERVAL="${LAT_KEEPER_INTERVAL:-20}"
RESTART_AFTER="${LAT_KEEPER_RESTART_AFTER:-6}"
PUBLIC_EVERY="${LAT_KEEPER_PUBLIC_EVERY:-15}"
TUNNEL_LABEL="${LAT_TUNNEL_LABEL:-com.pulsecore.lattice-tunnel}"
APP_PATH="${LAT_APP_PATH:-/Applications/Lattice.app}"

SUPPORT="$HOME/Library/Application Support/Lattice"
STATUS="$SUPPORT/bridge-keeper.status"
PAUSE="$HOME/.lattice-keeper-pause"
# Relay mode (relay/install.sh): the public hostname is served by an always-on container that fails
# over to a cloud replica, and the Mac only offers itself through the relay agent's reverse forward.
# The Mac's own tunnel agent is retired there, so a public failure is never fixed by kicking it.
RELAY_CONFIG="$SUPPORT/relay/config.json"
LOG="/tmp/lattice-bridge-keeper.log"
LOG_MAX_BYTES=1048576

CURL=/usr/bin/curl
OPEN=/usr/bin/open
PGREP=/usr/bin/pgrep
DATE=/bin/date
OSASCRIPT=/usr/bin/osascript
LAUNCHCTL=/bin/launchctl
STAT=/usr/bin/stat

mkdir -p "$SUPPORT"

log() {
  # Rotate in place rather than growing without bound; this runs for weeks at a time.
  if [ -f "$LOG" ] && [ "$($STAT -f%z "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null
  fi
  printf '%s %s\n' "$($DATE -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"
}

# 200 from /health means the main process is answering, not merely that a pid exists.
local_healthy() { $CURL -sf --max-time 4 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }
public_healthy() { $CURL -sf --max-time 12 "$PUBLIC_URL/health" >/dev/null 2>&1; }
app_running() { $PGREP -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; }

# `open -g` activates the existing instance if there is one, so this is safe to call blind.
start_app() { $OPEN -g -a "$APP_PATH" >/dev/null 2>&1; }

# A wedged main process will not answer IPC either, so fall back to a signal after asking politely.
restart_app() {
  log "restart: app is running but the bridge has been dead for $RESTART_AFTER probes"
  $OSASCRIPT -e 'tell application "Lattice" to quit' >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    app_running || break
    sleep 1
  done
  if app_running; then
    log "restart: quit did not take, sending TERM"
    $PGREP -f "$APP_PATH/Contents/MacOS/" | while read -r pid; do kill "$pid" 2>/dev/null; done
    sleep 3
  fi
  start_app
}

write_status() {
  # One line, easy to read over ssh or from a shortcut on the phone.
  printf '%s state=%s local=%s public=%s app=%s fails=%s\n' \
    "$($DATE -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" "$5" > "$STATUS"
}

log "keeper start: port=$PORT public=$PUBLIC_URL interval=${INTERVAL}s restart_after=$RESTART_AFTER"

fails=0
tick=0
public_fails=0
last_public=unknown

while true; do
  if [ -f "$PAUSE" ]; then
    write_status paused - - - 0
    fails=0
    sleep "$INTERVAL"
    continue
  fi

  tick=$((tick + 1))

  if local_healthy; then
    [ "$fails" -gt 0 ] && log "recovered: bridge healthy again after $fails failed probes"
    fails=0

    # Only meaningful when the origin is up: a public failure here isolates the tunnel.
    if [ $((tick % PUBLIC_EVERY)) -eq 0 ]; then
      if public_healthy; then
        [ "$public_fails" -gt 0 ] && log "recovered: $PUBLIC_URL reachable again"
        public_fails=0
        last_public=ok
      else
        public_fails=$((public_fails + 1))
        last_public=down
        log "public probe failed ($public_fails) while the local bridge is healthy — tunnel side"
        if [ "$public_fails" -ge 2 ] && [ -f "$RELAY_CONFIG" ]; then
          log "public probe failing in relay mode — the container owns the hostname; see relay/README.md (not kicking a local tunnel)"
          public_fails=0
        elif [ "$public_fails" -ge 2 ]; then
          log "kicking $TUNNEL_LABEL"
          $LAUNCHCTL kickstart -k "gui/$(id -u)/$TUNNEL_LABEL" >/dev/null 2>&1 \
            || log "kickstart failed — is $TUNNEL_LABEL loaded?"
          public_fails=0
        fi
      fi
    fi

    write_status ok up "$last_public" up 0
  else
    fails=$((fails + 1))
    if app_running; then
      log "bridge not answering but the app is running (probe $fails/$RESTART_AFTER)"
      write_status degraded down "$last_public" up "$fails"
      if [ "$fails" -ge "$RESTART_AFTER" ]; then
        restart_app
        fails=0
      fi
    else
      log "app is not running — launching it"
      write_status down down "$last_public" down "$fails"
      start_app
      fails=0
    fi
  fi

  sleep "$INTERVAL"
done
