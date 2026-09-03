# Relay / cloud endpoint runbook — `vmcontroller.pulse-core.com`

How the Lattice bridge on the Mac is published to the phone. Written from a live access probe on
2026-09-03. Contains no secrets — credentials are referenced by location, not value.

## What was verified (access attempt, 2026-09-03)

- **`vmcontroller.pulse-core.com` already exists as a Cloudflare Tunnel route.** It resolves to Cloudflare
  proxy IPs (`172.67.214.77`, `104.21.45.128`) and returns **HTTP 502** — the tunnel ingress is configured
  but its origin is currently offline. `cf-ray` edge is `WAW` (Warsaw), matching the EU estate. This is
  the ideal starting point: **DNS + tunnel record already exist; we only need to point them at a running
  origin (our bridge).**
- **The estate is reachable and I have root.** `ssh pve-tunnel` (→ `root@pve`, the Proxmox host
  `10.0.0.172`) works from any network via `cloudflared access ssh --hostname ssh.pulse-core.com` with
  `~/.ssh/id_ed25519`. `qm list` enumerates the VMs; **`cf-router` is VM 142 and runs the cloudflared
  tunnel** (named `AIAGENTVMROUTER`).
- **`cloudflared` is installed on the Mac** at `~/.local/bin/cloudflared` (v-current, 38 MB).
- **cf-router's own SSH** did not accept `~/.ssh/id_ed25519` for `root@10.0.0.49` or `dylan@10.0.0.49` over
  the pve jump — its tunnel config was not read in this pass. Not required for the recommended path below.
- Cloudflare API token / tunnel credentials ("keys are somewhere"): **not located** (a broad secret scan
  was intentionally not run). They live either in the Cloudflare dashboard (account for `pulse-core.com`)
  or on `cf-router` under `/etc/cloudflared/`. One of these is needed to edit tunnel ingress or DNS.

## Recommended deployment — B-variant 1: `cloudflared` on the Mac (simplest)

Publish the bridge straight from the Mac; Cloudflare is the relay. No dependency on cf-router being
reachable by us.

1. **Turn the bridge on** in Lattice → Settings → **Remote access**: set a password, set the local port
   (default `8973`), enable. Confirm locally:
   ```bash
   curl -s http://127.0.0.1:8973/health        # → {"ok":true,"protocol":1,...}
   ```
2. **Authenticate cloudflared to the pulse-core Cloudflare account** (one-time, opens a browser — the
   product owner does this, it needs dashboard login):
   ```bash
   ~/.local/bin/cloudflared tunnel login
   ```
3. **Create a dedicated tunnel for the Mac** and route the hostname to it. If `vmcontroller` should keep
   its exact name, its DNS/ingress is repointed to this new tunnel; if any conflict, use a fresh hostname
   (e.g. `mac-lattice.pulse-core.com`) and set that as the app's Public URL.
   ```bash
   cloudflared tunnel create lattice-mac
   cloudflared tunnel route dns lattice-mac vmcontroller.pulse-core.com
   ```
4. **Run it against the bridge** (with WebSocket passthrough, which cloudflared does by default):
   ```bash
   cloudflared tunnel run --url http://127.0.0.1:8973 lattice-mac
   ```
   or a `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <lattice-mac-UUID>
   credentials-file: /Users/dylan/.cloudflared/<UUID>.json
   ingress:
     - hostname: vmcontroller.pulse-core.com
       service: http://127.0.0.1:8973
     - service: http_status:404
   ```
5. **Keep it running** with a launchd agent (mirrors the estate's launchd-managed tooling), so it survives
   reboots and the Mac serves whenever it is awake.
6. **(Recommended) Cloudflare Access** in front of the hostname (email OTP or a service token) as
   defense-in-depth over the app password. The iOS app's own password/token flow is unchanged underneath.
7. **Verify off-LAN:**
   ```bash
   curl -s https://vmcontroller.pulse-core.com/health
   # then in the app: log in, list threads, watch a run stream.
   ```

## Alternative — B-variant 2: relay service on a VM (literal "VM as relay")

Only if the VM must own the public endpoint independent of the Mac. Stand up a small service on a VM (or
reuse cf-router's tunnel by adding an ingress rule) that terminates the phone's HTTPS/WSS and forwards
frames over a persistent **outbound** WebSocket that the Mac's bridge dials to the VM. The Mac still runs
the full runtime; the VM only relays. More moving parts (reconnect, backpressure, a 503 "backend offline"
when the Mac is down) — defer unless needed. Editing cf-router's tunnel needs SSH access to VM 142 or the
Cloudflare API token.

## Operational notes

- **The Mac must be awake to serve** (relay model): the bridge and cloudflared run on the Mac. Consider
  `caffeinate -s` (or Energy Saver "prevent sleep") while you rely on remote access. A 502 at the
  hostname = tunnel up, Mac origin down.
- **Health/monitoring:** `GET /health` is unauthenticated; point an uptime check at it.
- **Security posture:** bridge binds loopback only; password is scrypt-hashed in `meta`; provider keys and
  secret MCP env are redacted before any RPC response leaves the Mac (`bridge.ts::redactForRemote`);
  tokens are opaque, expiring, and individually revocable; `/auth` is rate-limited.
