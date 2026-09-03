# Lattice for iOS — Build Plan

> **Status:** planning only. Nothing in here is executed yet. This document is the brief that
> the implementation subagents will work from. It defines the architecture, the wire protocol, the
> exact changes to Lattice, the relay on the VM, and the native iOS app — decomposed into
> assignable work packages with contracts, sequencing, and verification.

---

## Build status (updated 2026-09-03)

**Workstream D (headless full backend) — DONE, built, and verified live on plain Node.** The corrected
architecture: the whole runtime runs as a Node service (`node out/headless/index.cjs`), Electron replaced
by a shim.
- `src/headless/electron-shim.ts` — headless stand-in for the 5 electron symbols the runtime imports
  (`app` path/lifecycle, `ipcMain` no-op, `BrowserWindow.getAllWindows()=[]`, `Notification`/`shell`
  no-op, `WebContentsView` stub). Data dir from `$LATTICE_DATA_DIR`.
- `src/headless/index.ts` — entrypoint: sets password from `$LATTICE_PASSWORD`, forces the bridge on
  (`$LATTICE_BIND` default `0.0.0.0`, `$LATTICE_PORT` default 8973), calls `registerIpc()` to boot the
  full runtime, clean SIGINT/SIGTERM shutdown.
- `scripts/build-headless.mjs` (esbuild) → `out/headless/index.cjs` (~5.5MB, one file; `better-sqlite3`,
  `node-pty`, `ws` external). `pnpm build:headless` / `pnpm start:headless`.
- Deploy: `docs/deploy/lattice-backend.service` (systemd) + `docs/deploy/README.md`.
- **Live verification (plain Node, temp data dir):** booted → `/health` ok → bad/good `/auth` →
  `listThreads` empty → `createThread "From the cloud"` → `listThreads` shows it → `listModels` returned
  **1964 models** (provider reachable) → unauth RPC `401` → `getSettings` leaked **zero** `apiKey` (redaction)
  → WebSocket `hello` + `pong` keepalive + live `thread.updated` push after an RPC mutation.
- `vmcontroller.pulse-core.com` **left untouched** per owner instruction; the backend is host-agnostic.

**Workstream A (bridge) — DONE and tested.** Used by both the desktop app and the headless backend; the
bridge modules are shared (`src/main/net/*`). The desktop app is unchanged in behavior; the bridge is
additive and off by default.
- `src/main/net/auth.ts` — scrypt password (stored hashed in `meta`, never in settings), opaque expiring
  device tokens, `/auth` rate-limit, device list/revoke.
- `src/main/net/bridge.ts` — api registry + push fan-out + `dispatch(method,args)` (allow-listed to
  `API_METHODS`) + `redactForRemote` (strips provider `apiKey`, masks secret MCP `env`).
- `src/main/net/server.ts` — HTTP+WS server: `GET /health`, `POST /auth`, `POST /rpc/<method>`,
  `WS /events`, `POST /push-token`. Binds loopback only.
- Wiring: `ipc.ts` `push()` now also `bridge.broadcast(event)`; the built `api` is registered; renderer-only
  `lattice:remote:*` admin channels added (never on `LatticeApi`). `index.ts` stops the bridge on quit.
- `AppSettings.remoteAccess` added (`types.ts`); preload exposes `window.lattice.remote`; **Settings →
  Remote access** tab (`Settings.tsx`) toggles the bridge, sets the password, shows the public URL +
  connected/authorized devices.
- **Verification:** `src/main/net/{auth,bridge,server}.test.ts` — 26 tests including a real HTTP+WS+sqlite
  end-to-end (auth → RPC → secret-redaction → live push over a real WebSocket → unauthorized-upgrade
  refusal). Full suite **879 passing**; `pnpm typecheck` clean (node+web); `pnpm build` green with `ws`
  externalized.
- **Protocol spec:** `src/shared/net-protocol.md` (authoritative, §3 realized).

**Workstream B (hosting/exposure) — owner-administered.** The backend binds `0.0.0.0` on the VM; exposing
it (Cloudflare tunnel / reverse proxy / private net) is left to the owner and makes no assumptions about
`vmcontroller.pulse-core.com`. VM-estate access is proven (root via `ssh pve-tunnel`) should provisioning be
needed. Runbook context in `docs/relay-access.md`; deploy steps in `docs/deploy/README.md`.

**Workstream C (iOS app) — scaffold DONE and building** under `/Users/dylan/lattice-ios/` (native SwiftUI,
no deps). Ported Codable models (incl. the `RunEventBody`/`PushEvent` discriminated unions with `.unknown`
fallbacks), `LatticeClient` (RPC + `/auth` + `wss` push with reconnect), Keychain token storage, the
`AppStore` push reducer mirroring `store.ts`, the `buildTimeline` port, and login/thread-list/conversation/
approval/ask views. Builds a simulator `.app` (`xcodebuild -target Lattice -sdk iphonesimulator build` →
BUILD SUCCEEDED; `com.pulsecore.lattice`, iOS 17). Remaining: wrap the rest of the `LatticeApi` methods,
markdown rendering, a Settings view, and a live run against the backend (needs a simulator runtime
installed via `xcodebuild -downloadPlatform iOS`).

---

## 0. Locked decisions (from the product owner)

| Decision | Choice | Consequence |
|---|---|---|
| Backend model | **Full headless backend on a VM.** The entire Lattice runtime runs as a plain Node service on a VM ("the cloud"), exposed over the auth'd HTTP+WS bridge. Electron is replaced by a shim at bundle time. The Mac desktop and the iOS app are both clients. | Tools/threads/runs execute on the VM. Provider access (OmniRoute/OpenAI-compatible) must be reachable **from the VM**. No dependence on the Mac being awake. **Superseded the earlier "VM as relay" idea.** |
| Cloud host | **A VM the owner designates.** `vmcontroller.pulse-core.com` is explicitly **left untouched** — the backend is host-agnostic and makes no DNS/tunnel changes. Deploy via `docs/deploy/`. | The owner sets the public hostname/tunnel however they administer their box; the app password gates access regardless. |
| Auth | **Single shared password** (single user, for now). Password → bearer token; token gates every RPC and the WebSocket. Layered under Cloudflare Access where available. | Simple. Hardened later (per-device tokens, biometric unlock, key rotation). |
| iOS delivery | **Personal dev build** from Xcode to Dylan's own iPhone (Apple ID signing). Simulator used for subagent verification. | No App Store review. No paid-account dependency to start. |
| iOS stack | **Native Swift + SwiftUI**, `async/await`, `URLSession` (RPC) + `URLSessionWebSocketTask` (push). Min iOS 17. | No third-party networking deps required. |

**Design principle that makes this whole project cheap:** Lattice's renderer talks to its backend through
exactly one narrow, fully-typed seam — `window.lattice`, which is just `API_METHODS` mapped to
`ipcRenderer.invoke('lattice:<method>')` plus an `onPush` stream on channel `lattice:push`
(`src/preload/index.ts`). **The iOS app is a second, native implementation of that same seam, reached over
the network instead of over IPC.** We are not re-implementing the agent runtime; we are exposing the
existing one.

---

## 1. How Lattice works today (grounding for subagents)

```
React renderer (no Node, CSP, context isolation)
      │  window.lattice.<method>()  →  ipcRenderer.invoke('lattice:<method>', ...args)
      │  window.lattice.onPush(fn)  ←  ipcRenderer.on('lattice:push', event)
Electron main
  ├── src/main/ipc.ts        registerIpc(): builds ONE `api: LatticeApi` object + ONE push() fan-out
  ├── src/main/store/        better-sqlite3 (WAL); schema in db.ts; event-sourced
  ├── src/main/providers/    openaiCompat streaming adapter + dynamic model registry → OmniRoute :20128
  ├── src/main/runtime/      runManager.ts: run lifecycle, streaming, tools, telemetry, subagents
  ├── src/main/tools/        builtin tools (fs/shell/web/jobs/memory/todo) + policy
  ├── src/main/mcp/          MCP stdio/HTTP manager (servers seeded from ~/.claude.json)
  ├── src/main/ptyTerminal.ts / browserView.ts / files.ts   host inspectors
src/shared/types.ts          the entire domain model (single source of truth)
src/shared/ipc.ts            LatticeApi (≈60 methods) + PushEvent union + API_METHODS[]
```

Facts the subagents must rely on:

1. **The contract is `src/shared/ipc.ts`.** `LatticeApi` enumerates every backend method; `PushEvent`
   enumerates every server→client message; `API_METHODS` is a runtime array of the method names. The
   preload builds the client generically by iterating `API_METHODS`. We do the same on the wire.
2. **The domain model is `src/shared/types.ts`** (899 lines). Every payload that crosses the seam is
   defined there. These become Swift `Codable` structs 1:1.
3. **`registerIpc()` (`src/main/ipc.ts:79`) is the single wiring point.** It constructs one plain
   `const api: LatticeApi = { … }` object (lines 107–370) and one `function push(event: PushEvent)`
   (line 36) that currently fans out only to `BrowserWindow`s. Both are the injection points for the
   network bridge.
4. **Runs are event-sourced.** A turn emits a stream of `RunEvent`s (`RunEventBody` union in
   `types.ts:249`) — `run.started`, `text.delta`, `reasoning.delta`, `tool.proposed/started/result`,
   `ask.requested`, `usage`, `run.completed`, etc. They are persisted to the `events` table AND pushed
   live as `{ kind: 'run.event', event }`. The transcript is a *projection* of these events, computed by
   `src/renderer/src/components/runTimeline.ts::buildTimeline()`. Message bodies also arrive as
   `{ kind: 'message.updated', message }`.
5. **Client reconciliation semantics are defined by `src/renderer/src/state/store.ts` `onPush` reducer
   (lines 334–530).** The iOS store must reproduce this behavior (dedupe by event id, append-or-replace
   messages, ignore events for non-active threads except errors, etc.). This file is the reference spec
   for the iOS live-update logic.
6. **Host-bound surfaces** (won't map trivially to a phone, handled in later phases): `pty*` (interactive
   terminal streamed via `pty.data` push), `browser*` (an Electron `WebContentsView` — cannot render on
   iOS; only its `BrowserState` is portable), `fsTree/fsReadFile` (Mac filesystem), `browserAttach`
   bounds (window geometry, meaningless on iOS).

---

## 2. Target architecture (relay model)

```
 iPhone (SwiftUI app)                    Cloudflare edge                 Mac (Lattice.app)
┌─────────────────────┐   HTTPS/WSS   ┌───────────────────┐  tunnel   ┌────────────────────────┐
│ LatticeClient        │ ───────────▶ │ vmcontroller.      │ ◀──────── │ cloudflared (or WS       │
│  • RPC: POST /rpc/M   │              │ pulse-core.com     │           │  reverse-tunnel client)  │
│  • Push: WSS /events  │ ◀─────────── │ (Cloudflare Tunnel │           │                          │
│  • Bearer token       │              │  + optional Access)│           │ Lattice bridge server    │
│ SwiftUI views ◀ store │              └─────────┬─────────┘           │  (new: src/main/net/)    │
└─────────────────────┘                          │                     │   ├ dispatch → api[M]()   │
                                                  │  VM: relay service  │   └ subscribe → push()    │
                                       ┌──────────▼──────────┐          │ existing runtime:        │
                                       │ relay (Node/cloudflared)         │  runManager, tools,      │
                                       │  publishes hostname, │          │  providers→OmniRoute,    │
                                       │  forwards to the Mac │          │  MCP, sqlite, pty…       │
                                       └─────────────────────┘          └────────────────────────┘
```

**Two viable ways to terminate the tunnel — pick during Workstream B (both are Cloudflare-native):**

- **B-variant 1 (simplest, recommended to start):** run `cloudflared` **on the Mac**, publishing
  `vmcontroller.pulse-core.com` → `http://localhost:<BRIDGE_PORT>`. Cloudflare is the relay; the VM
  hosts the DNS/tunnel record and (optionally) Cloudflare Access policy. Zero custom relay code.
- **B-variant 2 (literal "VM as relay"):** run a tiny relay service **on the VM** that the Mac's bridge
  dials out to over an outbound WebSocket (reverse tunnel). The VM publishes the hostname and forwards
  RPC/WS frames to the connected Mac. More moving parts; use only if you want the VM to hold the public
  endpoint independently of the Mac's own cloudflared.

The app and protocol are identical for both — only the deployment/ops differ. **Start with B-variant 1**,
keep B-variant 2 as a documented upgrade.

---

## 3. The wire protocol (the new contract, implemented on both sides)

This is the single most important spec. Define it once (Workstream A produces it as
`src/shared/net-protocol.md` + a shared TS type module), the iOS app mirrors it.

### 3.1 Transport
- **RPC:** `POST https://<host>/rpc/<method>` where `<method>` ∈ `API_METHODS`. Body: `{ "args": [...] }`
  (positional, matching the `LatticeApi` signature). Response: `{ "ok": true, "result": <JSON> }` or
  `{ "ok": false, "error": { "message": string, "code"?: string } }`. `Content-Type: application/json`.
- **Push:** `WSS https://<host>/events`. Server→client frames are exactly the `PushEvent` JSON objects,
  one per WS message. Client→server frames: `{"type":"ping"}` keepalive only (all mutations go over RPC).
- **Versioning:** every response and the WS hello carry `{"protocol": 1}`. Client refuses mismatched major.

### 3.2 Auth
- `POST /auth` with `{ "password": string, "device": string }` → `{ "token": string, "expiresAt": number }`.
  Token is a random 256-bit opaque string stored server-side (in sqlite `meta` or a new `auth_tokens`
  table) with the device label and last-seen time.
- Every `/rpc/*` request and the `/events` upgrade must send `Authorization: Bearer <token>`. Missing/expired
  → `401`. The WS closes with code `4401` on bad token.
- Password is set on the Mac side in Settings (new field) and/or an env var; stored hashed (scrypt/argon2),
  never plaintext. Compare in constant time. Rate-limit `/auth` (e.g. 5/min) to blunt brute force even
  though Cloudflare Access sits in front.
- On iOS the token lives in the **Keychain**; password entry uses a SwiftUI login screen with optional
  Face ID gate on app resume.

### 3.3 Initial sync + reconnect (critical for correctness)
- On connect, the client does an **RPC snapshot** (e.g. `listWorkspaces`, `listThreads`, `getSettings`,
  `listModels`, `pendingApprovals`, `pendingAsks`) then opens the WS. For an open thread it calls
  `getThread(id)` → `{ meta, messages, events }` and builds the timeline with the ported `buildTimeline`.
- The WS may drop (phone sleeps, network changes). On reconnect the client **re-fetches `getThread` for the
  active thread** rather than trying to replay missed deltas — events are coalesced and idempotent by id,
  so a fresh snapshot is always correct and cheap. Dedupe live events by `RunEvent.id` (as store.ts does).
- **Missed-work while backgrounded:** `listThreads` returns `running` + `lastMessagePreview`; a badge/refresh
  covers "what happened while I was away." (Optional P2: a `sinceSeq` event backfill endpoint.)

### 3.4 Payload notes / redactions
- `getSettings()` returns `providers[]` including `apiKey` (plaintext today, `types.ts:717`). **The bridge
  MUST redact secrets** before sending to the phone: strip `apiKey`, and any MCP `env` that looks like a
  secret, replacing with a `hasKey: boolean`. Add a bridge-side allowlist so the phone can toggle
  non-secret settings without ever receiving keys. (Work package A4.)
- `fsReadFile`/image results can be large data URLs — fine over HTTPS, but the phone should lazy-load.

---

## 4. Workstream A — Lattice (Electron main) changes

All additive; no behavior change to the desktop app. New code under `src/main/net/`.

**A1 — Refactor the wiring seam (small, enabling).**
`src/main/ipc.ts`: extract the `const api: LatticeApi = {…}` construction into a `buildApi(push)` factory
that returns the object, and export both the built `api` and a `subscribe(fn)` hook alongside the existing
`push`. Change `push()` (line 36) to also call every network subscriber, not just `BrowserWindow`s. Net
effect: `registerIpc()` still works identically, but `api` + the push stream are now reachable by the
bridge. *Verify:* desktop app still builds, typechecks, and runs; existing tests green.

**A2 — The bridge HTTP server.** New `src/main/net/server.ts`. A Node `http` server (no Express needed):
- `POST /auth` (§3.2), `POST /rpc/:method` → `await (api as any)[method](...body.args)`, guarded by
  `API_METHODS.includes(method)` and bearer check. Serialize result as JSON; map thrown errors to the
  `{ok:false,error}` shape with the `ErrorCategory` when available.
- `GET /events` (WS upgrade, using the `ws` package or Node's built-in) → register the socket as a push
  subscriber via A1; unsubscribe on close; heartbeat ping/pong; drop on auth failure.
- Binds `127.0.0.1:<BRIDGE_PORT>` only (never `0.0.0.0`) — Cloudflare Tunnel connects locally. Port + enable
  flag come from Settings/env. *Verify:* unit-test dispatch (mock `api`), and a localhost curl smoke:
  `POST /auth` then `POST /rpc/listThreads` then a `wscat` on `/events` shows a live `run.event` during a run.

**A3 — Auth + token store.** New `src/main/net/auth.ts` + a `auth_tokens` table (or reuse `meta`). Hash the
password (argon2id via a small dep, or Node `crypto.scrypt`), constant-time compare, issue/verify/expire
tokens, rate-limit. Add `netBridge` settings to `AppSettings` (`types.ts`): `{ enabled, port,
passwordHash?, tokenTtlDays }`. Add setters through the existing `setSettings`. *Verify:* auth unit tests
(good/bad password, expired token, rate limit).

**A4 — Secret redaction layer.** A `redactForRemote(method, result)` pass in the bridge that strips
`providers[].apiKey`, MCP `env` secrets, and any other credential-bearing field before RPC responses leave
the process. Whitelist the settings fields the phone may write. *Verify:* test that `getSettings` over the
bridge contains no `apiKey`.

**A5 — Lifecycle + Settings UI.** Boot the bridge from `registerIpc()` (or `index.ts`) when enabled; shut it
down in `before-quit` (`index.ts:` add to the existing teardown list). Add a **"Remote access"** section to
`src/renderer/src/components/Settings.tsx`: enable toggle, port, "Set password", the public URL
(`vmcontroller.pulse-core.com`), connection status, and a list of authorized devices with revoke. *Verify:*
toggle on → curl works; toggle off → port closed; quit → clean shutdown.

**A6 — Push-notification hook (enables iOS background alerts, P1).** When `notify.ts` raises an
`attention`/`failure`/`done` notice, ALSO enqueue it to any registered device push tokens (APNs). Add
`registerPushToken(token)` to the bridge (not `LatticeApi` — a bridge-only endpoint) and a minimal APNs
sender (`src/main/net/apns.ts`) using an Apple auth key. *Verify:* deferred to P1; stub the interface in P0
so the iOS app can register early.

**A7 — Protocol as shared source of truth.** Add `src/shared/net-protocol.md` (this §3, authoritative) and,
optionally, generate a machine-readable method/param manifest from `API_METHODS` + the TS types so the iOS
Codable layer can be checked against it in CI. *Verify:* a script asserts every `API_METHODS` entry has a
documented signature.

> **Scope guard for A:** Do NOT try to make `ptyCreate`, `browserAttach/SetBounds/Detach`, or the
> window-geometry methods meaningful remotely in P0. Expose them (they'll error or no-op gracefully) but the
> iOS app won't call the geometry ones. PTY streaming and browser *state* are P2.

---

## 5. Workstream B — the relay / cloud endpoint on the VM

**B1 — Locate access + credentials.** Find how `vmcontroller.pulse-core.com` is administered. Known facts:
`pulse-core.com` is on **Cloudflare** (DNS → Cloudflare IPs), SSH to the estate uses
`cloudflared access ssh --hostname ssh.pulse-core.com` with `~/.ssh/id_ed25519` (see `~/.ssh/config`
hosts `pve-tunnel`/`pve-web`). Find the Cloudflare API token / tunnel credentials ("keys are somewhere" —
check `~/.cloudflared/`, `~/.config/cloudflared/`, 1Password/keychain, the pulse-core admin). *Deliverable:*
a short `docs/relay-access.md` (gitignored if it holds secrets) recording exactly how to manage the tunnel
and DNS for that hostname.

**B2 — Publish the bridge (B-variant 1, recommended).** Create a Cloudflare Tunnel config that maps
`vmcontroller.pulse-core.com` → `http://localhost:<BRIDGE_PORT>` and run `cloudflared` **on the Mac** as a
launchd service (mirrors the existing launchd-managed tooling pattern). Enable WebSocket passthrough (on by
default for cloudflared). Optionally put a **Cloudflare Access** policy in front (email OTP / service token)
as defense-in-depth over the app password. *Verify:* from off-LAN, `curl https://vmcontroller.pulse-core.com/health`
hits the Mac bridge; a WS client receives events.

**B3 — (Optional) VM-hosted relay (B-variant 2).** Only if the VM must own the public endpoint independent of
the Mac: a small Node service on the VM that accepts the phone's HTTPS/WSS and forwards frames over a
persistent outbound WS the Mac's bridge establishes to the VM. Document reconnect/heartbeat. *Verify:* Mac
offline → relay returns a clean 503 "backend offline"; Mac back → resumes.

**B4 — Health + ops.** `/health` endpoint on the bridge (no auth, returns `{ok, protocol, runningRuns}`);
launchd keepalive; a one-command "is the remote up?" check. Document in `docs/relay-access.md`.

---

## 6. Workstream C — the native iOS app (Swift + SwiftUI)

New Xcode project `ios/Lattice/` (or a sibling repo — decide in C0). Target iOS 17, SwiftUI lifecycle.

**C0 — Project scaffold.** Xcode project, folders `Networking/ Models/ Store/ Views/ Timeline/`, signing set
to Dylan's Apple ID, a `Config.swift` with the default host `vmcontroller.pulse-core.com`. Add a
`launch.json`/scheme so the iOS Simulator build can be driven for verification. *Verify:* empty app builds and
runs in Simulator.

**C1 — Domain models (Codable).** Port `src/shared/types.ts` → Swift structs/enums in `Models/`. Priority set
for P0: `ThreadMeta, ChatMessage, RunEvent + RunEventBody (as an enum with associated values via a `type`
discriminator), SendOptions, ModelInfo, ThreadGroup, ApprovalRequest/Decision, AskRequest/Response,
Todo, ContextBudget, AppSettings (redacted), WorkspaceMeta, TurnTelemetry`. Mirror the exact JSON field
names. The `RunEventBody` and `PushEvent` unions need custom `Codable` keyed on their `type`/`kind` string.
*Verify:* round-trip decode fixtures captured from the live bridge (record real JSON from a running Mac).

**C2 — LatticeClient (the networking core).** `Networking/LatticeClient.swift`:
- `func rpc<T: Decodable>(_ method: String, _ args: [Encodable]) async throws -> T` → `POST /rpc/<method>`.
- Typed wrappers for each P0 method (`listThreads()`, `getThread(id)`, `send(_:)`, `cancelRun(_:)`,
  `respondApproval(_:)`, `respondAsk(_:)`, `createThread(_:)`, `listModels()`, `getSettings()`, …).
- `AuthManager`: password → token, Keychain storage, 401 → re-auth, Face ID gate.
- `PushConnection`: `URLSessionWebSocketTask` to `/events`, decodes `PushEvent`, reconnect w/ backoff,
  heartbeat, `AsyncStream<PushEvent>` out. *Verify:* against a running Mac bridge, log in, list threads,
  open a thread, stream a live run.

**C3 — Store + reconciliation (the port of store.ts onPush).** `Store/AppStore.swift`, an `@Observable`
(Observation framework) that holds threads/messages/events/approvals/asks/budget and applies `PushEvent`s
using the **same rules as `src/renderer/src/state/store.ts:334-530`** — dedupe by event id, append-or-replace
`message.updated`, ignore non-active-thread run events except errors, clear/set running flags, unread badges,
etc. This file's behavior is the spec; port it faithfully. *Verify:* a scripted run on the Mac produces the
same final transcript on the phone as in the desktop app.

**C4 — Timeline projection.** `Timeline/RunTimeline.swift` — port `runTimeline.ts::buildTimeline()`: fold a
thread's `RunEvent[]` into ordered `think` / `output` / `tool` / `notice` blocks with live coalescing of
`text.delta`/`reasoning.delta`. This is the heart of the chat rendering. *Verify:* golden-file test using the
same fixtures as `runTimeline.test.ts` (reuse its cases).

**C5 — Views (P0 chat-first).**
- **Login** (host + password, Face ID).
- **Thread list** (sidebar equivalent): sections/pins/running indicators, search (`searchThreads`),
  new-thread, swipe to archive/delete, group filing (`setThreadGroup`).
- **Conversation**: streaming markdown transcript (reasoning receipts collapsible, tool rows with
  status/args/result, telemetry footer), the timeline from C4. Use a Swift markdown renderer
  (`swift-markdown` / `AttributedString`) with fenced-code + tables; KaTeX/mermaid are P2.
- **Composer**: text, send/steer/queue (`disposition`), model picker (`listModels`, capabilities → effort
  tiers), Plan/Act/Review mode, permission preset. Enter-while-running = steer (matches desktop).
- **Approvals & Asks**: the two interactive gates that MUST work for full functionality — sheets that render
  `ApprovalRequest`/`AskRequest` and call `respondApproval`/`respondAsk`. Without these the agent stalls on
  any gated tool. *Verify each view against the live Mac.*

**C6 — Inspectors & the rest (P1).** Context Orbit (`getContextBudget` + `budget.updated`), Tasks
(`listTodos`+`todos.updated`), Memory (`listMemory/upsertMemory/deleteMemory`), Usage (`listUsageRows`),
Background jobs (`listJobs/stopJob/jobs.updated`), Files diff (`fileChanges` + `fsReadFile` viewer),
Tools inventory (`listTools`), MCP status (`listMcpServers`), inter-session messaging
(`listSessions/sendSessionMessage/listInbox`), Settings (redacted subset), thread ops
(`fork/compact/clear/retry/dequeue/editQueued/steerQueued`).

**C7 — Background & notifications (P1).** Register for APNs, send the device token to the bridge (A6), handle
notice pushes → deep-link to the thread. Handle app-resume re-sync (C2/C3 reconnect). Background WS is not
allowed on iOS, so rely on APNs for "needs you" moments while backgrounded, and re-snapshot on foreground.

**C8 — Terminal & embedded browser (P2, optional).** A read/write terminal view over `pty*` + `pty.data`
(SwiftTerm). The embedded browser can only show `BrowserState` (url/title/nav) or, better, let the phone open
the URL in `SFSafariViewController` — it cannot mirror the Mac's `WebContentsView`. Clearly a stretch goal.

---

## 7. Cross-cutting concerns

- **Security:** password hashed at rest; tokens opaque + revocable; bind bridge to loopback only; secret
  redaction (A4); Cloudflare Access in front; constant-time compares; `/auth` rate-limit; Keychain on iOS;
  optional Face ID. Treat every RPC arg as untrusted on the Mac (it already validates via the runtime, but
  the bridge must not widen filesystem/shell scope beyond what the desktop grants — reuse the same permission
  broker path; the bridge does not bypass approvals).
- **Correctness of live state:** dedupe by `RunEvent.id`; snapshot-on-reconnect instead of delta-replay;
  authoritative `getThread`/`getContextBudget` pulls on `run.completed`.
- **Offline/awake:** Mac-asleep = backend offline; app shows a clear "backend offline" state (via `/health`),
  not a hang. (Optional: a `caffeinate`/power-management note in relay docs so the Mac can stay serving.)
- **Performance:** coalesced deltas keep the WS light; large tool results/images lazy-load; the phone paginates
  `listThreads` if the estate grows.

---

## 8. Feature-parity matrix (maps desktop → iOS, by phase)

| Capability | LatticeApi / Push | iOS phase |
|---|---|---|
| List/open/search/create/delete/clear threads | `listThreads,getThread,searchThreads,createThread,deleteThread,clearThread` | **P0** |
| Send / steer / queue, cancel, retry | `send(disposition),cancelRun,retryTurn,steerQueuedMessage,dequeueMessage,editQueuedMessage` | **P0** |
| Live streaming (text/reasoning/tools) | `run.event`, `message.updated` | **P0** |
| Model picker + modes + presets | `listModels`, thread meta | **P0** |
| Approvals / Asks (interactive gates) | `pendingApprovals,respondApproval,pendingAsks,respondAsk` + pushes | **P0** |
| Groups / pin / archive | `listThreadGroups,setThreadGroup,updateThread` | P1 |
| Context budget / Tasks / Memory / Usage | `getContextBudget,listTodos,listMemory,listUsageRows` + pushes | P1 |
| Fork / compact | `forkThread,compactThread` | P1 |
| Background jobs, Tools inventory, MCP status | `listJobs,stopJob,listTools,listMcpServers` | P1 |
| Inter-session messaging | `listSessions,sendSessionMessage,listInbox` | P1 |
| Files diff + viewer | `fileChanges,fsReadFile,fsTree` | P1/P2 |
| Push notifications (needs-you) | A6 + APNs | P1 |
| Interactive terminal | `pty*` + `pty.data` | P2 |
| Embedded browser | `browser*` (state only / SFSafari) | P2 |

---

## 9. Subagent decomposition, sequencing, and dependencies

Assign as bounded work packages. **The protocol spec (A7/§3) and models (C1) are the shared contract — freeze
them early so A/B/C proceed in parallel.**

```
Phase 0 — Contract & scaffolding (do first, mostly serial)
  A1  refactor wiring seam (buildApi/subscribe)         ── enables A2
  A7  write net-protocol.md + method manifest           ── unblocks C1/C2
  C0  iOS scaffold                                       ── parallel

Phase 1 — Backend bridge & relay (parallel with iOS core)
  A2  bridge HTTP+WS server        (dep: A1, A7)
  A3  auth + token store           (dep: A2)
  A4  secret redaction             (dep: A2)
  A5  lifecycle + Settings UI      (dep: A2,A3)
  B1  locate CF creds              (independent, start immediately)
  B2  publish tunnel (variant 1)   (dep: A2 running locally, B1)
  B4  health + ops

Phase 2 — iOS core (parallel with Phase 1 once A7/C1 land)
  C1  Codable models               (dep: A7; verify vs live bridge from A2)
  C2  LatticeClient (RPC+WS+auth)  (dep: C1, A2/A3)
  C3  store reconciliation         (dep: C2; port store.ts)
  C4  timeline projection          (dep: C1; port runTimeline.ts + reuse its tests)
  C5  P0 views (chat/approvals/asks)(dep: C2,C3,C4)

Phase 3 — Parity & polish
  C6  inspectors & the rest        (dep: C5)
  A6+C7 push notifications         (dep: C5)
  B3  optional VM relay variant
  C8  terminal / browser (stretch)
```

**Critical path:** A1 → A2 → C2 → C3/C4 → C5. Everything else fans off it.

Recommended agent roles: a **backend agent** (A1–A5, A7), an **infra/relay agent** (B1–B4), and one or two
**iOS agents** (C0–C1 then split C2–C4 from C5). Keep the protocol doc as the synchronization point; any
change to it is a broadcast to all agents.

---

## 10. Testing & verification

- **Lattice side:** extend Vitest — bridge dispatch (mock `api`), auth (good/bad/expired/rate-limit),
  redaction (no `apiKey` leaves). Desktop app unaffected: full `pnpm typecheck` + `pnpm test` stay green; the
  existing CDP smoke (`scripts/e2e-app.mjs`) still passes.
- **End-to-end (real):** with the Mac bridge running, a scripted harness logs in, creates a thread, sends a
  prompt that triggers a gated tool, approves it, and asserts the streamed transcript matches the desktop's.
  Capture these JSON streams as **fixtures** shared by C1/C3/C4 tests.
- **iOS side:** XCTest for Codable round-trips (fixtures), timeline golden files (reuse `runTimeline.test.ts`
  cases), and reconciliation (feed a recorded `PushEvent` sequence, assert final store state). Drive the
  Simulator build for view verification via the iOS Simulator tooling.
- **Relay:** off-LAN `curl`/`wscat` against `vmcontroller.pulse-core.com`; Mac-offline behavior; reconnect.

---

## 11. Risks & open items

1. **Mac must be awake to serve** (relay model). Mitigation: document a power-management/`caffeinate` option;
   "backend offline" UX; (future) B3 VM relay could cache read-only state.
2. **`getSettings` leaks secrets if redaction is missed** — A4 is mandatory before B2 exposes the bridge
   publicly. Gate the public tunnel on redaction tests passing.
3. **`RunEventBody`/`PushEvent` union drift** — the TS unions evolve; the Swift Codable layer must be
   regenerated/checked against `API_METHODS` + types. A7's manifest + CI check contains this.
4. **iOS background limits** — no long-lived WS in background; APNs + foreground re-sync is the design, not a
   bug. Set expectations accordingly.
5. **Cloudflare Access vs app password interplay** — decide whether Access is enforced (extra login) or the
   tunnel is app-password-only; document in relay-access.md. Recommended: Access ON for defense-in-depth.
6. **Which tunnel variant** — start B-variant 1 (cloudflared on Mac). Only build B-variant 2 if the VM must
   own the endpoint independently.
7. **Personal-signing 7-day expiry** (free Apple ID) — if Dylan uses a paid account, 1-year; note re-sign
   cadence either way.

---

### Appendix — key source references (for subagents)

- Contract: `src/shared/ipc.ts` (`LatticeApi`, `PushEvent`, `API_METHODS`)
- Domain model: `src/shared/types.ts`
- Wiring seam to modify: `src/main/ipc.ts` (`push` @36, `registerIpc`/`api` @79–370)
- Boot/teardown: `src/main/index.ts` (`registerIpc()` call; `before-quit` teardown)
- Client bridge shape to mirror: `src/preload/index.ts`
- Reconciliation spec to port: `src/renderer/src/state/store.ts` (`onPush` @334–530)
- Timeline projection to port: `src/renderer/src/components/runTimeline.ts` (`buildTimeline`)
- Schema: `src/main/store/db.ts`
- Settings surface to extend: `src/renderer/src/components/Settings.tsx`
- SSH/tunnel facts: `~/.ssh/config` (cloudflared access), DNS on Cloudflare
```
