# Deploying the headless Lattice backend to a VM ("the cloud")

The headless backend runs the **full** Lattice runtime — event store, run manager, tools, MCP, memory,
providers — as a plain Node service, exposing it over the authenticated HTTP + WebSocket bridge that the
iOS app (and, if you point it here, the desktop app) talks to. Electron is replaced by a small shim at
bundle time (`src/headless/electron-shim.ts`); there is no GUI, no window, no embedded browser.

> This backend is host-agnostic. Point it at whatever VM you like. It does **not** touch, require, or
> assume `vmcontroller.pulse-core.com` — set the public hostname/tunnel however you administer that box.

## What runs where

- **On the VM:** the whole agent runtime. Tools (filesystem, shell, terminal, jobs) execute on the VM.
  Threads, runs, memory, and MCP state live in the VM's `LATTICE_DATA_DIR`.
- **Model access:** the runtime calls an OpenAI-compatible gateway (OmniRoute by default at
  `http://localhost:20128`, discovered key from `$OMNI_KEY` or `~/.local/bin/omni-cc`). On the VM you must
  make a gateway reachable — run OmniRoute there, tunnel to it, or set a provider (base URL + key) in the
  DB. Until then, `listModels` returns empty and runs error with an auth/route category.
- **Clients:** the iOS app and (optionally) the desktop app connect to the bridge with the shared password.

## Build

On a dev machine (or the VM):

```bash
pnpm install
pnpm build:headless        # → out/headless/index.cjs (single ~5.5MB CJS bundle)
```

`better-sqlite3`, `node-pty`, and `ws` are kept external (not bundled) — they must be installed where the
backend runs.

## Install on the VM (Linux, Node 22+)

```bash
# 1. Node 22+
node -v

# 2. Put the code on the VM
sudo mkdir -p /opt/lattice && sudo chown $USER /opt/lattice
# copy the repo (or at minimum: out/headless/index.cjs + package.json), then install the native deps
cd /opt/lattice
npm install better-sqlite3 node-pty ws     # built for the VM's Node ABI (NOT Electron's)

# 3. Data dir + user
sudo useradd -r -s /usr/sbin/nologin lattice || true
sudo mkdir -p /var/lib/lattice && sudo chown lattice:lattice /var/lib/lattice

# 4. Service
sudo cp docs/deploy/lattice-backend.service /etc/systemd/system/
sudoedit /etc/systemd/system/lattice-backend.service   # set LATTICE_PASSWORD, OMNI_KEY, paths
sudo systemctl daemon-reload
sudo systemctl enable --now lattice-backend
journalctl -u lattice-backend -f
```

> **Native ABI note:** the repo's `node_modules` on the Mac are built for Electron's ABI. On the VM,
> (re)install `better-sqlite3` / `node-pty` with plain `npm`/`pnpm` so they match the VM's Node — do not
> copy the Mac's compiled `.node` binaries.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `LATTICE_DATA_DIR` | `~/.lattice` | sqlite DB + state |
| `LATTICE_PORT` | `8973` | bridge port |
| `LATTICE_BIND` | `0.0.0.0` | bind interface (headless default; the desktop uses loopback) |
| `LATTICE_PASSWORD` | — | sets/replaces the remote password on boot (provision once, then remove) |
| `OMNI_KEY` | — | OmniRoute/provider key the runtime discovers |

## Verify

```bash
curl -s http://<vm>:8973/health
# {"ok":true,"protocol":1,"subscribers":0}

TOK=$(curl -s -X POST http://<vm>:8973/auth -H 'content-type: application/json' \
  -d '{"password":"<your-password>","device":"cli"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -s -X POST http://<vm>:8973/rpc/listThreads -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' -d '{"args":[]}'
```

The same auth → RPC → WebSocket flow was verified end-to-end on plain Node (see
`src/main/net/server.test.ts` and the live smoke in the build log): create a thread, list it back, stream
a live `thread.updated` over `wss://…/events`, and confirm provider reachability via `listModels`.

## Exposing it (your call — no assumptions made)

Bind is `0.0.0.0` inside the VM; put it behind whatever you already use — a Cloudflare tunnel, a reverse
proxy with TLS, or a private network (Tailscale/WireGuard). The app password gates access regardless; add
Cloudflare Access or mTLS in front for defense-in-depth. **The choice of public hostname/tunnel is left to
you** — this backend makes no DNS or tunnel changes itself.

## Security recap

Password is scrypt-hashed in the DB (never in settings, never sent to a client); device tokens are opaque,
expiring, and revocable; `getSettings`/`listMcpServers` are secret-redacted before leaving the process
(`src/main/net/bridge.ts`); `/auth` is rate-limited. Run the service as an unprivileged user with
`NoNewPrivileges` and a writable-only data dir.

---

## Live deployment (provisioned 2026-09-03)

The backend was provisioned on the Proxmox estate and is running:

- **Host:** LXC container **CT 149** `lattice-backend` on `pve` (Debian 12, 4 cores / 4 GB / 16 GB disk,
  unprivileged, `onboot`). LAN IP **10.0.0.2**, bridge on `0.0.0.0:8973`.
- **Service:** `systemctl status lattice-backend` (Node 22, `/opt/lattice/index.cjs`, data in
  `/var/lib/lattice`). Native deps (`better-sqlite3`, `node-pty`, `ws`) installed for the container's Node.
- **Password:** self-provisioned on first boot — the hash is stored; the plaintext is in
  `/var/lib/lattice/initial-password.txt` (root, mode 600). Read it from the box, then delete it:
  ```bash
  ssh pve-tunnel 'pct exec 149 -- cat /var/lib/lattice/initial-password.txt'
  # then, once saved into the app:
  ssh pve-tunnel 'pct exec 149 -- rm /var/lib/lattice/initial-password.txt'
  ```
- **Public URL (immediate, ephemeral):** a `cloudflared` quick tunnel runs as
  `lattice-quicktunnel.service` on the CT → a `https://<name>.trycloudflare.com` URL (verified reachable
  from the internet, `/health` ok, unauth → 401). The URL **changes on restart** — read the current one:
  ```bash
  ssh pve-tunnel "pct exec 149 -- bash -c 'journalctl -u lattice-quicktunnel -o cat | grep -oE \"https://[a-z0-9-]+\\.trycloudflare\\.com\" | tail -1'"
  ```

### Make the public hostname permanent (your Cloudflare account)

The estate's `cloudflared` on `pve` is **token/dashboard-managed**, so ingress hostnames are configured in
the Cloudflare Zero Trust dashboard. To give the backend a stable name, add one Public Hostname to that
tunnel and disable the quick tunnel:

- **Dashboard:** Zero Trust → Networks → Tunnels → (the pve tunnel) → Public Hostnames → Add:
  `Subdomain=lattice`, `Domain=pulse-core.com`, `Type=HTTP`, `URL=10.0.0.2:8973`. Enable WebSockets (on by
  default). Then `ssh pve-tunnel 'pct exec 149 -- systemctl disable --now lattice-quicktunnel'`.
- **Or give me a scoped Cloudflare API token** (Account: Cloudflare Tunnel Edit + Zone: DNS Edit for
  pulse-core.com) and I'll create the hostname + DNS route via the API.

`vmcontroller.pulse-core.com` was intentionally **not touched**.

### Provider access (needed for model runs, not for chat plumbing)

Threads/auth/streaming work now. **Model runs** need an OpenAI-compatible gateway reachable *from the CT*
(the Mac's OmniRoute at `localhost:20128` is not reachable from 10.0.0.2). Either expose OmniRoute to the
container, run a gateway on the estate, or set a provider (base URL + key) in the backend — do it from the
desktop app pointed at this backend, or seed it in the DB. Until then `listModels` is empty and runs error
with an auth/route category.
