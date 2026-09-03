# Lattice remote bridge — wire protocol (v1)

Authoritative contract for the network bridge that exposes Lattice's `LatticeApi` to a remote client
(the iOS app). Implemented by `src/main/net/{server,bridge,auth}.ts`. The iOS `LatticeClient` mirrors
this. **This is the single source of truth for both sides — change it here first.**

`protocol` version: **1**. Every response and the WS `hello` carry `"protocol": 1`; a client refuses a
mismatched major version.

## Transport

Base URL is the public tunnel host, e.g. `https://vmcontroller.pulse-core.com`. The bridge itself binds
`127.0.0.1:<port>` (default 8973) and is fronted by a Cloudflare tunnel. All bodies are JSON.

### `GET /health` — no auth
`200 → { "ok": true, "protocol": 1, "subscribers": <int> }`. Liveness probe for the tunnel/monitor and
the client's "backend online?" check.

### `POST /auth` — password → device token
Request `{ "password": string, "device": string }`.
- `200 → { "ok": true, "protocol": 1, "token": string, "expiresAt": <epoch ms> }`
- `401 → { "ok": false, "error": { "message": "invalid password" } }`
- `403` when no password has been configured on the Mac yet.
- `429` when rate-limited (>8 attempts/min/IP).

The token is an opaque 256-bit hex string. Store it in the iOS Keychain. It carries the `device` label
and an expiry (`remoteAccess.tokenTtlDays`, default 30). The Mac can revoke it from Settings.

### `POST /rpc/<method>` — one call per `LatticeApi` method — **Bearer required**
`<method>` must be a member of `API_METHODS` (`src/shared/ipc.ts`). Header
`Authorization: Bearer <token>`. Request body `{ "args": [ ...positional args... ] }` matching the
method signature in `LatticeApi`.
- `200 → { "ok": true, "protocol": 1, "result": <JSON | null> }`
- `401` missing/invalid/expired token
- `404` unknown method
- `400` malformed body / body too large (>32 MB)
- `500 → { "ok": false, "error": { "message": string, "code"?: ErrorCategory } }`

Examples: `POST /rpc/listThreads` `{"args":[]}`; `POST /rpc/getThread` `{"args":["thr_123"]}`;
`POST /rpc/send` `{"args":[{"threadId":"thr_123","text":"hi","disposition":"send"}]}`.

### `WS /events` — server→client push stream — **Bearer required**
Upgrade `GET /events` with `Authorization: Bearer <token>` (native clients) or `?token=<token>` (fallback).
Bad token → the upgrade is refused (`401`, socket closed).
- First frame: `{ "kind": "hello", "protocol": 1 }`.
- Thereafter each frame is exactly one `PushEvent` JSON object (`src/shared/ipc.ts` `PushEvent` union):
  `run.event`, `message.updated`, `message.deleted`, `thread.updated`, `thread.deleted`,
  `groups.updated`, `budget.updated`, `approval.request`, `approval.resolved`, `ask.request`,
  `ask.resolved`, `todos.updated`, `notice`, `models.updated`, `mcp.updated`, `jobs.updated`,
  `files.changed`, `session.message`, and the host-only `pty.*` / `browser.*` / `zoom.changed`.
- Client → server: `{"type":"ping"}` keepalive only (server replies `{"type":"pong"}`). **All mutations
  go over RPC**, never the socket.
- The server also sends WS-level pings every 30s and drops a socket that misses two — a sleeping phone
  is cleaned up automatically.

### `POST /push-token` — register an APNs device token — **Bearer required** (P1)
`{ "token": string } → { "ok": true }`. Stored for later "needs-you" push notifications (approvals,
asks, failures). The APNs sender is a later pass.

## Auth & secrets (server-side guarantees)

- Password is stored only as a `scrypt` hash in the local `meta` table — **never** in `AppSettings`, so it
  is never sent to a client. Verified in constant time.
- `getSettings`/`setSettings` results are **redacted** before leaving the process: every provider's
  `apiKey` is stripped and replaced with `hasKey: boolean` + `headerNames: string[]`; secret-looking MCP
  `env` vars (`/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i`) are masked to `***`. See
  `bridge.ts::redactForRemote`. **Any new secret-bearing payload field must be added there.**
- Remote-access administration (set password, toggle bridge, revoke devices) is **renderer-only IPC**
  (`lattice:remote:*`), deliberately absent from `LatticeApi`, so a connected phone can never escalate.

## Initial sync & reconnect (client responsibilities)

1. On login: `POST /auth`, store token, then snapshot with `listThreads`, `getSettings`, `listModels`,
   `pendingApprovals`, `pendingAsks`; open `WS /events`.
2. Opening a thread: `getThread(id) → { meta, messages, events }`, build the transcript with the ported
   `buildTimeline` (`src/renderer/src/components/runTimeline.ts`).
3. Apply push events with the reducer semantics of `src/renderer/src/state/store.ts` (dedupe run events by
   `RunEvent.id`; `message.updated` append-or-replace by id; ignore non-active-thread run events except
   errors; maintain approvals/asks/unread).
4. On WS drop: reconnect with backoff and **re-fetch `getThread`** for the active thread rather than
   replaying missed deltas — events are idempotent and coalesced, so a fresh snapshot is always correct.
5. `run.completed` → authoritative `getContextBudget` / `getThread` pull.

## Host-bound methods (call with care from a phone)

`ptyCreate/Input/Resize/Kill` stream an interactive terminal over `pty.data`/`pty.exit` (P2 on iOS).
`browserAttach/SetBounds/Detach` drive an Electron `WebContentsView` bound to window geometry — **not**
usable from iOS; the phone should ignore the geometry methods and, at most, read `BrowserState` or open
URLs in `SFSafariViewController`. `fsTree/fsReadFile` operate on the Mac filesystem.
