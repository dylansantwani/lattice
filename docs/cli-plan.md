# Lattice CLI — Build Plan (`lattice` in the terminal)

> **Status:** planning only. Nothing here is built yet. This document is the brief an implementer
> (human or subagent) works from: the architecture, the transport contract, the exact runtime
> changes, the full command/flag surface, the TUI spec, the output-format contracts, the test plan,
> and a phased milestone list with acceptance criteria.
>
> Tracked in `docs/ROADMAP.md` under "Slice 10 — Lattice CLI".

---

## 0. What this is, and why it is not a second app

`lattice` is a terminal client for the runtime Lattice already has. It is shaped like the Claude Code
CLI — you `cd` into a repo, type `lattice`, and talk to an agent that can read, edit, run commands,
and delegate — but it is a *client of the same durable event store the desktop app uses*, not a
parallel implementation.

The consequence is the feature that no other coding CLI has: **the terminal and the GUI are two views
of one session.** A run started in the terminal appears live in the desktop transcript, keeps running
when the terminal closes, can be approved from the phone, and is resumable from either side. A run
started in the GUI can be tailed and steered from a terminal in the same repo.

What already exists and must be reused rather than re-implemented:

| Capability | Lives in | Reuse posture |
| --- | --- | --- |
| Run lifecycle, tool loop, subagents, compaction, retries | `src/main/runtime/runManager.ts` | Unchanged. The CLI never talks to a provider itself. |
| Durable threads/messages/events/todos/memory/settings | `src/main/store/` (SQLite WAL) | Unchanged. |
| The API surface | `LatticeApi` + `API_METHODS` in `src/shared/ipc.ts` | The CLI speaks exactly this. New methods are additive (§4). |
| Push events | `PushEvent` in `src/shared/ipc.ts` | The CLI subscribes to the same stream the renderer does. |
| Remote transport | `src/main/net/{server,bridge,auth}.ts` | Reused for `--remote`; a local socket transport is added (§3.2). |
| Running the whole runtime without Electron | `src/headless/{index,electron-shim}.ts`, `scripts/build-headless.mjs` | The CLI's embedded mode is the same trick with a different entrypoint. |
| Timeline folding, tool grouping, subagent indexing | `src/renderer/src/components/{runTimeline,subagents}.ts` (pure, no React) | Moved to a shared view layer and imported by both surfaces (§4.7). |
| Context/cost/stats math | `src/shared/{contextScale,cost,statsSnapshot}.ts` | Already shared. |

So the CLI is: **a transport, a renderer, and an argument parser.** Everything else is a call into
code that is already tested.

---

## 1. Locked decisions

1. **Binary name** `lattice`. Short alias `lat` installed alongside it. No other names.
2. **Runtime** Node ≥ 22 (matches `engines`). Shipped as one bundled CJS file, like the headless
   backend, with `better-sqlite3` / `node-pty` external and only required in embedded mode.
3. **No TUI framework.** Hand-rolled ANSI renderer. React/Ink would double the bundle, cost ~200 ms
   of startup, and buy nothing — the hard part (folding an event stream into a timeline) is already
   solved by pure reducers that render to anything.
4. **Scrollback, not alt-screen.** Finished output stays in the user's scrollback exactly like
   `claude`. Only the live region (current turn + composer + status line) is redrawn in place.
   `--alt-screen` opts into a full-screen frame for the dashboard-ish subcommands.
5. **One writer per data directory, always.** If a runtime is already up on this data dir, the CLI
   attaches to it. It never opens a second `runManager` on the same SQLite file (§3.5).
6. **The local control socket needs no password.** Filesystem permissions (`0600`, inside the data
   dir) are the authentication boundary, the same posture as a Docker or tmux socket. The
   password-protected HTTP bridge stays exactly as it is for anything off-box.
7. **Print mode is the contract.** `-p/--print` with `--output-format stream-json` is a stable,
   versioned, machine-readable interface. It is what CI, git hooks, and other agents consume, and it
   is covered by tests that fail on an unannounced schema change.
8. **Default permission posture in a TTY is `workspace` (Auto) + `act`.** Non-interactive runs
   default to `plan` + `manual` unless explicitly widened — a piped `lattice -p` must not be able to
   `rm -rf` by accident.
9. **The CLI adds no product behavior of its own.** Anything it can do, the GUI can do, because both
   call the same methods. A feature that needs new behavior gets it in `src/main`, not in the CLI.

---

## 2. Non-goals

- Not a second agent implementation, not a second prompt, not a second tool set.
- No provider calls from the CLI process (embedded mode boots the runtime, which makes them).
- Not a replacement for the desktop app's inspectors — the CLI shows the *timeline* well and the
  *panels* adequately; deep diffing, the browser, and the file tree stay GUI-first.
- No Windows-console-specific work beyond what `src/main/platform/shell.ts` already abstracts;
  Windows ships when Slice 8's Windows QA ships (named pipe instead of a Unix socket is specced, not
  validated).
- No plugin/hook system in v1 (Claude Code's hooks map onto Lattice's approval broker + MCP, which is
  a later slice).

---

## 3. How it attaches: three transports, one client interface

Every CLI code path programs against a single object typed as `LatticeApi` plus an async iterator of
`PushEvent`. Three implementations satisfy it, chosen once at startup.

```
src/cli/transport/
  index.ts       resolve(): picks a transport, prints why under --verbose
  socket.ts      attached  → Unix domain socket / named pipe to a live runtime
  embedded.ts    embedded  → boots the runtime in-process (headless shim)
  remote.ts      remote    → HTTP + WS bridge, device token (src/main/net protocol)
  types.ts       interface LatticeTransport { api: LatticeApi; events: AsyncIterable<PushEvent>; mode; close() }
```

### 3.1 Resolution order

1. `--remote <url>` or `$LATTICE_REMOTE` → **remote**.
2. A live runtime on this data dir (`$LATTICE_DATA_DIR` / `--data-dir`, default `~/.lattice`,
   Electron default `app.getPath('userData')` on macOS — `doctor` prints which) → **attached**.
   Liveness = `runtime.json` present, its `pid` alive, and its socket answers `health` within 300 ms.
3. `--embedded` forced, or no live runtime → **embedded**.
4. Embedded refused because another process holds the write lock and its socket is unreachable →
   hard error with the pid, the socket path, and the two ways out (`lattice --remote`, or quit that
   process). Never a silent second writer.

### 3.2 The local control socket (new)

**Server** — `src/main/net/local.ts`, booted from `registerIpc()` alongside the existing bridge and
also by `lattice serve`:

- Path: `<dataDir>/control.sock` (macOS/Linux), `\\.\pipe\lattice-<hash(dataDir)>` (Windows).
- Perms `0600`; the containing dir is `0700`. Stale socket files are unlinked when their owning pid
  is gone (checked via `runtime.json`).
- Framing: newline-delimited JSON, one object per line, `\n` never appearing inside (JSON escapes it).
  - `→ {"id":1,"method":"listThreads","args":[]}`
  - `← {"id":1,"ok":true,"result":[...]}` / `{"id":1,"ok":false,"error":{"message":"…","code":"…"}}`
  - `→ {"id":2,"subscribe":true}` then `← {"push":{…PushEvent}}` until `{"id":2,"unsubscribe":true}`
  - `→ {"id":3,"method":"health"}` → `{"protocol":1,"pid":123,"version":"0.1.0","mode":"desktop"|"serve"}`
- Method dispatch is the **existing** `dispatch()`/`subscribe()` from `src/main/net/bridge.ts`, so
  the allow-list (`API_METHODS`) and `redactForRemote` behavior are shared with the HTTP bridge and
  cannot drift. The only difference is transport and the absence of a bearer check.
- `runtime.json` (written atomically on boot, removed on clean exit): `{pid, startedAt, socket,
  protocol, version, mode, dataDir, bridgePort?}`.

**Client** — `src/cli/transport/socket.ts`: connect, `health`, protocol check (mismatch → a clear
"your CLI is older/newer than the running Lattice" message naming both versions), then an in-flight
map keyed by request id and a push queue with backpressure (an unread stream over 10k events drops to
"resync" mode: it refetches thread state rather than replaying).

### 3.3 Embedded runtime

`src/cli/embedded.ts` mirrors `src/headless/index.ts` but:

- does **not** force the network bridge on (loopback HTTP stays off unless `--serve`),
- boots the control socket so a *second* terminal in the same repo attaches to the first instead of
  fighting over the DB,
- calls `registerIpc()` for the full runtime wiring, then talks to it through the same
  `bridge.dispatch` used by the socket — one code path for "call a method", in every mode,
- shuts down on SIGINT/SIGTERM through the headless shutdown sequence (`shutdownMcp`,
  `killAllBgJobs`, `killAllTerminals`, `closeDb`) plus socket + lock cleanup,
- keeps runs alive across `Ctrl-C` at the prompt: `Ctrl-C` cancels the *run*, `Ctrl-D` (or `/quit`)
  exits the process. Exiting with a background job or background subagent still running prints what
  will be killed and requires a confirm (or `--force`).

Native modules in embedded mode: `better-sqlite3` and `node-pty` are `require`d from the install's
`node_modules` (Node ABI, not Electron ABI — the packaged app ships a Node-ABI copy under
`Resources/cli/node_modules`, see §12). `lattice doctor` verifies both load and prints the exact
rebuild command when they do not.

### 3.4 Remote client

`src/cli/transport/remote.ts` speaks the documented bridge protocol: `POST /auth` (password → device
token, scrypt-hashed server side), `POST /rpc/<method>`, `WS /events` with the 30 s heartbeat. Tokens
are cached per host in `<configDir>/tokens.json` (`0600`) and refreshed on 401. `--remote` accepts
`https://host`, `host:port`, or a saved profile name (§11). This is how the CLI drives the VM backend
or a desktop Mac over a tunnel, and it is the same server the iOS app uses.

### 3.5 The single-writer invariant

SQLite is in WAL mode, so a second process *can* open the file — and that is precisely the failure
mode to prevent, because run state, approval brokers, PTY sessions, MCP clients, and background jobs
live in process memory, not in the DB. Two runtimes on one data dir means two disjoint views of
"what is running", duplicate MCP servers, and push events that never reach the other side.

Enforcement:

- `<dataDir>/runtime.lock` — an exclusive `flock`/`O_EXCL` lock file holding the pid. Acquired by any
  process that calls `registerIpc()`: the desktop app, `lattice serve`, and embedded mode alike.
- Acquisition failure is not fatal by itself — the CLI first tries the control socket (the normal
  case: the desktop app is running). Only "locked *and* unreachable" is an error.
- Stale locks (pid gone) are broken automatically, with a log line.
- The desktop app gains the same lock, which also fixes the documented README hazard that "the
  packaged app and `pnpm dev` share a data directory and the bridge port" — the second one now says
  so instead of quietly corrupting session state.

---

## 4. Runtime changes required in `src/main` and `src/shared`

These are the only places the CLI needs behavior that does not exist yet. Each is small, testable on
its own, and useful to the GUI too.

### 4.1 Workspace management RPCs (`src/main/ipc.ts`, `src/shared/ipc.ts`)

`LatticeApi` today can only *list* workspaces, but a CLI launched in an arbitrary directory must be
able to bind one. Add, and append to `API_METHODS`:

```ts
createWorkspace(opts: { name?: string; roots: string[] }): Promise<WorkspaceMeta>
updateWorkspace(id: WorkspaceId, patch: { name?: string; roots?: string[] }): Promise<WorkspaceMeta>
deleteWorkspace(id: WorkspaceId): Promise<void>            // refuses while threads reference it
/** Find (or, with `create`, make) the workspace whose roots contain `path`. */
resolveWorkspace(path: string, opts?: { create?: boolean }): Promise<WorkspaceMeta>
```

`resolveWorkspace` is the CLI's entry point (§5) and is deliberately server-side so the GUI's
"open folder" flow can share it later. Root containment reuses `isPathInsideRoots` from
`src/main/files.ts` (symlink-resolved, platform case-folding) — no second implementation.

### 4.2 Per-thread working directory (`db.ts`, `eventStore.ts`, `types.ts`, `builtin.ts`, `ptyShell.ts`)

Today relative tool paths resolve against `ctx.workspace.roots[0]` and a shell with no `cwd` starts
in `homedir()` (`src/main/tools/builtin.ts:147`, `src/main/tools/ptyShell.ts:318`). A terminal user's
mental model is "the agent is in *this* directory", including a subdirectory of the workspace root.

- Add `cwd TEXT` to `threads` (additive migration in `migrate()`, the established pattern) and
  `cwd?: string` to `ThreadMeta` + `createThread` options + `updateThread` patch.
- `ToolContext` gains `cwd` (falling back to `workspace.roots[0] ?? homedir()`, so nothing changes
  for existing threads). `resolveToolPath` and the shell session key use it.
- The PTY session key becomes `${threadId}:${cwd}` so two threads in different directories do not
  share one shell.
- Containment is unchanged: `cwd` must be inside the workspace roots or the call is refused.
- Tests: `pathArgs.test.ts` (relative resolution under a thread cwd), `ptyShell.test.ts` (session
  keying), `db.test.ts` (migration on an old DB).

### 4.3 Attachment ingestion for a non-GUI client (`src/main/ipc.ts`)

`SendOptions.attachments` carries `Attachment` objects the renderer builds from a File. The CLI has
paths. Add a small server-side helper RPC:

```ts
attachFile(path: string): Promise<Attachment>   // validates type/size against the renderer's limits, returns the wire-ready attachment
```

so `lattice -i screenshot.png` and drag-drop-a-path-into-the-composer both work without duplicating
`attachments.ts`'s validation table.

### 4.4 Approval and ask delivery are already push-based — verify, don't rebuild

`approval.request` / `ask.request` pushes plus `respondApproval` / `respondAsk` / `pendingApprovals`
/ `pendingAsks` already exist and are transport-agnostic. The CLI needs no new API. What it needs is
a **reconnect contract**: on attach, call `pendingApprovals()` and `pendingAsks()` and render
anything parked, because the push that announced it fired before the CLI existed. Same rule the iOS
app follows.

### 4.5 Notices and titles

`notice` pushes are already emitted for failures and needs-you moments; the CLI renders them as
dimmed one-liners above the composer. `thread.updated` carries model-set titles (`set_thread_title`),
so the CLI's header updates live.

### 4.6 Control-socket boot wiring

`registerIpc()` starts the control socket unless `LATTICE_NO_CONTROL_SOCKET=1`; `index.ts` (desktop)
and the headless entry both stop it on quit. `bridgeStatus()` gains `control: { path, connections }`
so `lattice doctor` and the Settings panel can show it.

### 4.7 Shared view layer (renderer → shared)

Move the framework-free reducers the CLI needs into `src/shared/view/` and re-export from their old
paths so renderer imports do not churn in one big diff:

- `runTimeline.ts` (`buildTimeline`, `groupTimeline`, `draftPreviewFor`, `toolActivityLabel`,
  `findResultImages`, `DELEGATION_TOOL`)
- `subagents.ts` (`indexSubagents`)
- `sidebarActivity.ts`, `backgroundWork.ts`, `retryView.ts`, `incomingDisplay.ts`
- a new `slashCatalog.ts`: the *metadata* half of `commands.ts` (name, aliases, title, hint,
  category, `expectsArg`, `argHint`) with each surface binding its own `run`. The renderer keeps its
  store-bound handlers; the CLI binds transport-bound ones. One catalog, two bindings — so `/compact`
  can never exist in one surface and not the other.

Their existing tests move with them and must keep passing unchanged; that is the proof the move was
mechanical.

---

## 5. Directory → workspace → thread binding

What happens when someone types `lattice` in `~/code/foo/src`:

1. Find the project root: nearest ancestor with `.git`, else the nearest ancestor containing
   `AGENTS.md`/`CLAUDE.md`, else the cwd itself.
2. `resolveWorkspace(root, { create: true })` — reuses a workspace whose roots contain it, otherwise
   creates one named after the directory with `roots: [root]`.
3. Thread selection:
   - `--continue` → most recently updated non-archived thread in that workspace,
   - `--resume [id|title]` → picker (interactive) or exact/prefix match (non-interactive),
   - otherwise a new thread with `{ workspaceId, cwd: process.cwd(), model, effort, mode,
     permissionPreset }`.
4. `--add-dir <path>` appends roots (with a confirmation when it widens the boundary beyond the
   project root; `-y` skips it).
5. The header line shows `workspace · cwd(relative) · model · mode/preset`, so the boundary the agent
   is operating under is never invisible.

`AGENTS.md` / `CLAUDE.md` in the project root are already imported by the memory bridge
(`src/main/memory/bridge.ts`); the CLI prints "loaded project instructions: AGENTS.md" on startup so
the user knows the agent has them.

---

## 6. The command surface

### 6.1 Synopsis

```
lattice [prompt...]                     start (or continue) an interactive session in this directory
lattice -p "prompt"                     print mode: run once, stream to stdout, exit
lattice <subcommand> [args] [flags]
```

### 6.2 Global flags

| Flag | Meaning |
| --- | --- |
| `--data-dir <path>` | Data directory (default `$LATTICE_DATA_DIR`, else the app's userData). |
| `--profile <name>` | Named config profile (§11): endpoint, model, defaults. |
| `--remote <url\|profile>` | Force remote transport. |
| `--embedded` | Force an in-process runtime (fails if another writer holds the lock). |
| `--model <id>` \| `-m` | Model for this session (`lattice models` lists ids). |
| `--effort <tier>` | Reasoning effort; validated against the model's advertised tiers. |
| `--mode <plan\|act\|review>` | Thread mode. |
| `--preset <manual\|workspace\|full>` | Permission preset. `--yolo` is an alias for `full` and requires a confirm or `-y`. |
| `--allow-tool <spec>` / `--deny-tool <spec>` | Repeatable pre-seeded permission rules, e.g. `shell:git *`, `fs_write:src/**`, `web_fetch`. |
| `--add-dir <path>` | Extra approved root (repeatable). |
| `--goal <text>` | Set the thread goal (the pinned north star). |
| `--instructions <text\|@file>` | Append standing system instructions (`settings.customInstructions`). |
| `-i, --image <path>` | Attach an image (repeatable, validated by `attachFile`). |
| `--output-format <text\|json\|stream-json>` | Print-mode output (§7). |
| `--json` | Shorthand for `--output-format json`. |
| `--no-color` / `--color <auto\|always\|never>` | Honors `NO_COLOR` and `FORCE_COLOR`. |
| `--quiet` / `-q` | Suppress the status line and tool chatter; final answer only. |
| `--verbose` | Transport resolution, protocol version, timings, event trace. |
| `-y, --yes` | Assume yes for CLI-level confirmations (never for tool approvals — those follow `--preset`/`--allow-tool`). |
| `--timeout <dur>` | Wall-clock cap for a print run (`90s`, `10m`). |
| `--max-turns <n>` | Cap provider rounds in print mode. |
| `--version` / `--help` | Version prints CLI + runtime + protocol versions. |

### 6.3 Interactive session (default)

`lattice` with no subcommand. A trailing prompt is sent immediately: `lattice "fix the flaky test"`.
Piped stdin is read as the first message when stdin is not a TTY: `git diff | lattice "review this"`.

### 6.4 Print mode

```
lattice -p "summarize the failing tests" --output-format stream-json --max-turns 6
cat build.log | lattice -p "what failed and why?" --json
lattice -p --resume abc123 "now fix it" --preset workspace
```

Contract: no TUI, no cursor tricks, no prompts. If a tool needs approval and the preset cannot grant
it, the run is **denied and reported**, not parked (parking a headless run is a hang). `stream-json`
still emits the approval event so a wrapper can decide to re-run with a wider preset.

### 6.5 Subcommands

```
lattice threads list [--all] [--workspace <id>] [--json]
lattice threads show <id> [--events] [--json]
lattice threads new [--title <t>]
lattice threads rm <id> [--force]
lattice threads clear <id>              # keep the thread, drop history
lattice threads fork <id> [--title <t>]
lattice threads compact <id>
lattice threads archive|unarchive|pin|unpin <id>
lattice threads search <query> [--limit n] [--json]
lattice threads title <id> <title>

lattice send <id> <text> [--steer|--queue] [--image f]     # one-shot into an existing thread
lattice attach <id|title> [--follow] [--since <n>]         # live view of a session (§10)
lattice stop <id>                                          # stopThreadWork: run + agents + jobs
lattice retry <id> [--mode auto|resume|restart]

lattice models [--refresh] [--health] [--json]
lattice models check <id...>                               # checkModelHealth
lattice providers [--check <id>]

lattice mcp list|add|remove [...]                          # upsertMcpServer / deleteMcpServer
lattice memory list|add|rm|sync [--json]
lattice todos list|add|done|rm|clear [--thread <id>]
lattice jobs list|stop [--thread <id>]
lattice usage [--range today|7d|30d|all] [--json]          # getStatsSnapshot rollup
lattice sessions [--activity] [--json]                     # listSessions / listSessionActivity
lattice message <to> <body> [--from <id>]                  # sendSessionMessage
lattice inbox [<id>] [--read <msgid>]

lattice config get|set|list [--profile p]
lattice serve [--port n] [--bind addr] [--bridge] [--no-control-socket]
lattice doctor                                             # environment + transport + native modules
lattice install [--dir ~/.local/bin] [--alias lat]
lattice completion <bash|zsh|fish>
```

Every subcommand that lists supports `--json` and emits the same shapes `LatticeApi` returns, so
scripting never needs to scrape text.

### 6.6 Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success; in print mode, the run reached `run.completed{reason:'done'}`. |
| 1 | Generic failure (run errored, subcommand failed). |
| 2 | Usage error (bad flag, unknown subcommand, invalid model id). |
| 3 | Transport failure (no runtime reachable, auth failed, protocol mismatch). |
| 4 | Run canceled (SIGINT, `--timeout`, `--max-turns` hit before completion). |
| 5 | Tool denied by policy in a non-interactive run — the actionable "widen the preset" code. |
| 130 | SIGINT at the prompt (conventional). |

### 6.7 Environment variables

`LATTICE_DATA_DIR`, `LATTICE_REMOTE`, `LATTICE_TOKEN`, `LATTICE_PASSWORD`, `LATTICE_PROFILE`,
`LATTICE_MODEL`, `LATTICE_PRESET`, `LATTICE_MODE`, `LATTICE_NO_CONTROL_SOCKET`, `NO_COLOR`,
`FORCE_COLOR`, `TERM`, `COLUMNS`/`LINES`. Precedence: flag > env > profile > `AppSettings` defaults.

---

## 7. Output formats

### 7.1 `text` (default)

Human output. In a TTY: styled, with live tool rows. Not a TTY: no ANSI, no live region, tool
activity as plain `→ shell: npm test (2.3s ok)` lines, final answer last.

### 7.2 `json`

One object at exit:

```jsonc
{
  "ok": true,
  "threadId": "th_…", "runId": "run_…", "messageId": "msg_…",
  "text": "the final assistant message",
  "stopReason": "done",                       // done | canceled | error | length
  "model": "cc/claude-sonnet-5", "mode": "act", "preset": "workspace",
  "turns": 4,
  "toolCalls": [{ "callId": "…", "tool": "shell", "ok": true, "durationMs": 2310, "summary": "npm test" }],
  "files": [{ "path": "src/a.ts", "kind": "edit" }],
  "todos": [{ "title": "…", "status": "done" }],
  "usage": { "inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0, "reasoningTokens": 0,
             "costUsd": 0, "costEstimated": false, "wallMs": 0, "tps": 0 },
  "error": null
}
```

### 7.3 `stream-json`

Newline-delimited JSON, one envelope per line, flushed immediately:

```jsonc
{"type":"session","protocol":1,"threadId":"th_…","runId":"run_…","model":"…","mode":"act","preset":"workspace","cwd":"/…"}
{"type":"event","seq":41,"event":{ /* RunEvent, verbatim from src/shared/types.ts */ }}
{"type":"approval","request":{ /* ApprovalRequest */ },"decision":"denied","reason":"preset manual"}
{"type":"ask","request":{ /* AskRequest */ },"answered":false}
{"type":"result", /* the §7.2 object */ }
```

Rules that make it a contract: the `event` payload is the persisted `RunEvent` with no reshaping, so
anything the GUI can render a consumer can too; `seq` is the store's monotonic sequence, so a
consumer can resume with `--since`; `protocol` is bumped only for breaking changes and asserted in
tests; unknown envelope types must be ignored by consumers (documented forward-compat rule).

---

## 8. The interactive TUI

### 8.1 Rendering architecture

```
src/cli/ui/
  screen.ts     terminal capability probe, raw mode, resize, cursor, alt-screen (opt-in)
  frame.ts      pure: (ViewModel, width) → string[] lines. No I/O. Snapshot-tested.
  diff.ts       previous lines vs next lines → minimal ANSI writes (cursor moves + erase-to-EOL)
  ansi.ts       color/style helpers, width-aware (wcwidth for CJK/emoji), NO_COLOR aware
  markdown.ts   mdast (remark-parse + remark-gfm, already deps) → ANSI blocks
  code.ts       lazy shiki highlight with an ANSI theme + cache; plain fallback
  spinner.ts    frame ticker; disabled under --no-color, dumb terms, or reduced-motion env
  input.ts      key decoding, bracketed paste, history, multi-line editing, completion
  composer.ts   the input model (draft, mode/preset chips, attachments, slash menu state)
  transcript.ts RunEvent[] → ViewModel via the shared reducers
```

The loop: transport pushes → a reducer folds them into a `ViewModel` → `frame.ts` renders lines →
`diff.ts` writes only what changed, at most ~20 fps and only when the model changed. Because
`frame.ts` is pure, the entire UI is unit-testable as strings — the same discipline
`runTimeline.test.ts` already uses.

### 8.2 Layout

```
  lattice · foo · src/ · claude-sonnet-5 · act/auto            ← header (redrawn on change)

  › fix the flaky test in runManager.test.ts                   ← user turn

  ⏺ Thinking… 4s · 812 tokens                                  ← reasoning bout (collapsed by default)
  ⏺ I'll reproduce it first.
    → shell  npm test -- runManager                 2.3s ✓     ← tool row (live: spinner + output tail)
    → fs_read src/main/runtime/runManager.ts:210    0.1s ✓
    ▸ 3 tool calls                                             ← folded group (⇥ expands)
    ◆ researcher · reading src/…                    12 calls   ← subagent card
  ⏺ The race is in the retry path. …

  ☐ reproduce  ☑ isolate  ☐ fix                                ← todo strip when the thread has todos
  ─────────────────────────────────────────────────────────────
  › ▊                                                          ← composer (multi-line, grows)
  act/auto · 34% ctx · $0.021 · 42 tok/s · ⌥⏎ newline · / cmds ← status line
```

Everything above the rule is committed to scrollback once finished; only the last block, the rule,
the composer and the status line are live.

### 8.3 Event → render mapping

| `RunEvent` | Terminal |
| --- | --- |
| `run.started` | header refresh; run id under `--verbose` |
| `text.delta` | streamed into the current answer block, markdown re-rendered per completed block |
| `reasoning.delta` / `reasoning.done` | collapsed "Thinking… Ns · N tokens", expandable with `⇥`; `--show-thinking` streams it |
| `tool.drafting` | a dim "preparing…" row with the drafted arg preview (`draftPreviewFor`) |
| `tool.proposed` / `approved` / `denied` | row state changes; a denial shows the reason |
| `tool.started` / `tool.progress` | spinner + last 3 lines of live output, replaced per snapshot |
| `tool.result` | final row: duration, ✓/✗, one-line summary (`toolActivityLabel`); `⇥` opens full args/result |
| images in a result (`findResultImages`) | iTerm2/kitty inline image when supported, else `[image 1024×768 — /path]` |
| `ask.requested` | inline question with numbered choices or a text field |
| `usage` | status line totals |
| `steer.injected` | `↳ steered` marker |
| `compaction` | `⋯ compacted 148k → 32k tokens` |
| `retry` | `↺ retry 2/3 — endpoint error` (rewound retries clear the discarded partial) |
| `error` | red block with category, message, and the retry hint |
| `run.completed` | commit block to scrollback, restore prompt, ring the bell on `--bell` |

Subagents come from `indexSubagents` and render as one card per delegation with live phase and call
counts — never as raw `run_agent` rows.

### 8.4 Markdown

`remark-parse` + `remark-gfm` (already dependencies) → mdast → ANSI: headings bold/underlined, lists
with hanging indents, tables width-fitted with truncation and an `⇥`-to-widen hint, block quotes with
a left bar, links as `text (url)` (never OSC-8 auto-open), inline code inverted, fenced code
highlighted lazily by shiki with a terminal theme and a plain fallback under `--no-highlight` or
`TERM=dumb`. Streaming safety: only *closed* blocks are re-rendered; an open fence renders raw so the
screen never flickers between half-parsed states.

### 8.5 Keybindings

| Key | Action |
| --- | --- |
| `Enter` | send; while running, steer (matches the GUI) |
| `⌥/Alt+Enter`, `\` + `Enter` | newline |
| `Ctrl+J` | newline (terminals that swallow Alt) |
| `Esc` | cancel the composer's menu; twice → cancel the run |
| `Ctrl+C` | cancel the run; at an empty prompt, twice within 2 s → exit |
| `Ctrl+D` | exit (confirms if work is running) |
| `⇥` | expand/collapse the focused block (thinking, tool group, subagent) |
| `Shift+⇥` | cycle focus backward through expandable blocks |
| `↑`/`↓` | prompt history (per workspace, `<configDir>/history`) |
| `Ctrl+R` | reverse search over history |
| `Ctrl+L` | clear the screen, keep the session |
| `Ctrl+T` | toggle the todo strip |
| `Ctrl+O` | toggle raw-event trace (the Run inspector, terminal edition) |
| `/` at column 0 | slash menu |
| `@` | file-path completion rooted at the thread cwd |
| `!` at column 0 | run the rest of the line as a shell command in the thread's session and show it to the agent |
| `#` at column 0 | save the rest of the line to memory (`memory_save` equivalent) |

### 8.6 Slash commands

Bound from the shared catalog (§4.7), so parity with the GUI is structural. Session: `/new`,
`/clear`, `/compact`, `/goal`, `/system`, `/side`, `/btw`. Mode: `/plan`, `/act`, `/review`.
Permissions: `/manual`, `/auto`, `/full`. Model: `/model [id]`, `/think <tier>`. Panels become
terminal views: `/context`, `/run`, `/tasks`, `/memory`, `/agents`, `/mcp`, `/usage`, `/sessions`
(rendered as a paged, alt-screen overlay that restores the transcript on exit). Thread: `/rename`,
`/pin`, `/archive`. Plus CLI-only: `/attach <id>`, `/cwd <path>`, `/tools` (the effective inventory
via `listTools`), `/approvals`, `/quit`. Unknown slash → nearest-match suggestion, never sent as a
prompt.

### 8.7 Approvals inline

```
  ⚠ shell wants to run:  rm -rf node_modules && pnpm install
    resource: shell · action: execute · risk: R2 · cwd /Users/…/foo

    [y] once   [a] this run   [t] this thread   [!] always for `shell: pnpm *`
    [n] deny   [e] edit the command   [?] explain
```

Keys map to `ApprovalScope` (`once|run|thread|profile`) and `proposedRule` for the "always" case.
`e` re-opens the arguments in `$EDITOR` and resubmits the edited call (denied + re-proposed, never
silently mutated). Multiple pending approvals queue and are answered in order. On `Ctrl+C` at an
approval prompt: deny and cancel the run.

### 8.8 Asks

`ask.requested` renders as a numbered choice list (`kind: 'choice'`), a single-line field, or a
`$EDITOR` buffer when `multiline`. Answering calls `respondAsk`. In print mode an ask is auto-denied
with `answer: ''` and reported in the result — with `--ask-answer <text>` supplying a canned answer
for scripted flows.

### 8.9 Status line

Left: mode/preset chips. Middle: context occupancy from `getContextBudget` (the Context Orbit as a
percentage plus a compaction warning at 80%), live cost and tok/s from the `usage` event. Right:
hints. Hidden under `--quiet`, and never drawn when stdout is not a TTY.

### 8.10 Degradation

- Not a TTY → plain streaming, no live region, no spinners, no cursor movement.
- `NO_COLOR` / `--no-color` / `TERM=dumb` → no styling, ASCII glyph set (`->`, `[x]`, `*`).
- Width < 60 → single-column, no tables (lists instead), truncation with `…`.
- `SIGWINCH` → recompute widths and full-redraw the live region only.
- Screen readers (`--plain` or `LATTICE_PLAIN=1`) → no redraw-in-place at all; each state change is
  appended as a line, so nothing is announced twice.
- Reduced motion (`--no-spinner`, or a dumb term) → static `…` instead of animation.

### 8.11 Paste and attachments

Bracketed paste is enabled: a multi-line paste is one composer edit, not N sends. A pasted path to an
image (or `-i`) becomes an attachment via `attachFile`. In iTerm2/kitty an image is previewed inline;
elsewhere it shows as a chip. Very large pastes (> 8 KB) are folded into `[pasted 412 lines]` in the
composer and sent in full.

---

## 9. Permissions in a terminal

The CLI does not invent a permission model; it drives the existing one (`Mode` × `PermissionPreset` ×
approval broker, with `RiskTier` ceilings).

- `--preset manual|workspace|full` maps to `permissionPreset`; `--mode plan|act|review` to `mode`.
- `--allow-tool` / `--deny-tool` pre-seed `PermissionRule`s at thread scope before the first turn:
  `shell:git *` → `{resource:'shell', action:'execute', scope:'git *', effect:'allow',
  duration:'thread'}`. Globs are matched by the broker's existing scope matching; an unparseable spec
  is a usage error (exit 2), never a silent no-op.
- Interactive default: `act` + `workspace` (asks before shell and before writes outside the roots).
- Non-interactive default: `plan` + `manual`. Widening requires an explicit flag; `--yolo` (full)
  additionally requires `-y` or a typed confirmation, and prints exactly what it disables.
- `lattice /tools` and `lattice threads show --tools` render `listTools` so "what can this session
  actually do right now" is one command, not a guess.
- Saved rules are per thread today (the known gap in `docs/ROADMAP.md`); when the durable rule store
  lands, `--allow-tool … --save` writes profile-scoped rules and `lattice config rules list|rm`
  manages them. The CLI is designed so that arrives as a new flag, not a redesign.

---

## 10. Multi-session behavior

- **Attach** — `lattice attach <id|title>` renders a live view of a session running anywhere
  (desktop, another terminal, the VM): recent transcript, live tool rows, pending approvals, todos.
  Read-only until you type; typing steers the live run (`send` with `disposition:'steer'`), matching
  the GUI's Enter-while-running semantics. Built on `getThread` + the `run.event` push, with
  `watchSessionActivity` for the compact dashboard mode.
- **Dashboard** — `lattice sessions --activity --watch` is the terminal version of the Sessions
  panel: every session, its status dot, what it is doing, what it is waiting on; `Enter` attaches.
- **Message** — `lattice message <to> "<body>"` uses `sendSessionMessage` (live steer if the target
  is running, inbox otherwise); `lattice inbox` drains. This is how a CI job or a git hook hands work
  to a long-lived session.
- **Notifications** — a finished run in a background terminal writes an OSC 9 / OSC 777 notification
  (and `--bell`), so a backgrounded `lattice -p` surfaces the same way desktop notifications do.

---

## 11. Config, profiles, auth, secrets

- App-level settings stay in the DB (`AppSettings`) — the CLI reads/writes them through
  `getSettings`/`setSettings`, so a change made in the terminal shows up in the GUI immediately.
  `lattice config set defaultModel <id>` is exactly that call.
- CLI-only preferences live in `<configDir>/config.json` (`$XDG_CONFIG_HOME/lattice` or
  `~/.config/lattice`): profiles (`{name, remote?, dataDir?, model?, preset?, mode?}`), color and
  glyph preferences, history size, editor.
- Remote tokens: `<configDir>/tokens.json`, `0600`, one entry per host, opaque expiring device tokens
  from `/auth`. `--password-stdin` for scripted provisioning; the password is never a flag and never
  echoed. Later: macOS Keychain via the same helper the desktop app will use when keychain-backed
  secrets land in Slice 8.
- Secrets never printed: every CLI call in every mode — embedded included — goes through
  `dispatch()` in `src/main/net/bridge.ts`, which already pipes results through `redactForRemote`.
  So `lattice config list` cannot leak a provider `apiKey` or a secret MCP `env` even locally, and
  that property is inherited rather than re-implemented. The write direction is unaffected
  (`setSettings` accepts a key; only the echoed result is redacted), so
  `lattice config set-key <provider> --stdin` works while `get` can only ever report presence.

---

## 12. Build, packaging, distribution

- `scripts/build-cli.mjs` — esbuild, same shape as `build-headless.mjs`: entry `src/cli/index.ts`,
  platform node, target node22, format cjs, `--external better-sqlite3 node-pty ws`, alias
  `electron` → the headless shim, `@shared/*` → `src/shared/*`. Output `out/cli/lattice.cjs`
  (expected ~6 MB, one file). Scripts: `pnpm build:cli`, `pnpm cli` (dev via tsx/esbuild-register).
- `bin/lattice` — `#!/usr/bin/env node` shim requiring the bundle, with a Node-version guard that
  prints the required version instead of a stack trace.
- Packaged app: electron-builder `extraResources` ships `out/cli/` plus a Node-ABI copy of the two
  native modules to `Lattice.app/Contents/Resources/cli/`. `lattice install` (also offered from
  Settings) symlinks `~/.local/bin/lattice` → that path, printing a PATH hint when the dir is not on
  PATH. This is how the GUI user gets the CLI without npm.
- Standalone: `@lattice/cli` npm tarball for `pnpm dlx @lattice/cli` and a Homebrew formula later;
  both carry the same bundle.
- Version/protocol: `lattice --version` prints CLI version, runtime version, and protocol version.
  A protocol mismatch across the socket is a clear error naming both sides and the fix (upgrade one).
- Shell completion generated from the same option table the parser uses (`lattice completion zsh`),
  so a new flag can never be missing from completions.

---

## 13. Testing and verification

Everything below runs under the repo's existing `pnpm test` (vitest, mocked providers, temp DBs) and
must pass alongside `pnpm typecheck` and `pnpm test:packages`.

| Area | Test | Shape |
| --- | --- | --- |
| Frame rendering | `src/cli/ui/frame.test.ts` | ViewModel → expected lines; width 40/80/200; no-color; ASCII fallback |
| Diffing | `diff.test.ts` | line sets → minimal write sequences; no writes when unchanged |
| Markdown/ANSI | `markdown.test.ts` | tables, nested lists, open fences mid-stream, CJK width |
| Transcript folding | reuse `runTimeline.test.ts` / `subagents.test.ts` unchanged after the move | proves the shared-view move was mechanical |
| Arg parsing | `args.test.ts` | every flag, precedence (flag > env > profile > settings), exit code 2 cases |
| Permission specs | `permissionSpec.test.ts` | `--allow-tool` strings → `PermissionRule`s; invalid specs rejected |
| Control socket | `src/main/net/local.test.ts` | framing, concurrent ids, subscribe/unsubscribe, unknown method 404-equivalent, perms `0600`, stale-socket reclaim |
| Single writer | `runtimeLock.test.ts` | second acquirer fails; stale pid reclaimed; embedded refuses when locked+unreachable |
| Transports | `transport.test.ts` | one fake runtime, three transports, identical `LatticeApi` results |
| Print mode | `printMode.test.ts` | `text`/`json`/`stream-json` against a scripted event stream; envelope schema snapshot; `--since` resume |
| Exit codes | `exit.test.ts` | done/error/cancel/denied/usage/transport |
| Workspace binding | `workspaceBind.test.ts` | git root discovery, `resolveWorkspace` reuse vs create, `--add-dir` widening |
| Thread cwd | `pathArgs.test.ts`, `ptyShell.test.ts` (extended) | relative resolution and shell session keying |
| End-to-end | `scripts/e2e-cli.mjs` (like `scripts/e2e-app.mjs`) | temp data dir + mocked provider: embedded `-p` run with a tool call, an approval denial, a resume, and an attached second CLI seeing the same events |

Manual verification checklist for the milestone reviews: iTerm2 + Terminal.app + tmux + VS Code
terminal; `TERM=dumb`; `NO_COLOR=1`; 40-column window; a resize mid-run; SIGINT mid-tool; the desktop
app open at the same time showing the same thread updating live; and a `--remote` session against the
headless backend.

---

## 14. Milestones

Each milestone is independently useful and independently shippable.

- [ ] **M0 — Foundations.** Shared-view move (§4.7) with tests unchanged; `runtime.lock` + single
      writer in `registerIpc()`; `src/main/net/local.ts` control socket + `runtime.json`; `doctor`
      diagnoses environment, transport, and native modules.
      *Accept:* two processes cannot both hold the data dir; `lattice doctor` correctly reports an
      attached desktop app, a `serve`, and neither.
- [ ] **M1 — Talk to it.** Arg parser, three transports behind `LatticeTransport`, `-p` print mode
      with `text`/`json`/`stream-json`, exit codes, stdin piping, `--model/--mode/--preset`,
      workspace binding + per-thread `cwd`, `createWorkspace`/`resolveWorkspace` RPCs.
      *Accept:* `git diff | lattice -p "review this" --json` works in a fresh repo, embedded and
      attached, with identical output.
- [ ] **M2 — Live terminal.** Screen/frame/diff/ansi/markdown renderer, streaming text and reasoning,
      tool rows with live output, folded groups, subagent cards, status line, `Ctrl+C` semantics,
      resize, degradation matrix.
      *Accept:* a multi-tool run renders legibly at 80 and 40 columns, in `TERM=dumb`, and under
      `NO_COLOR`, with frame snapshots covering each.
- [ ] **M3 — Full conversation.** Composer with history/multi-line/bracketed paste, slash catalog,
      inline approvals with scopes, asks, attachments via `attachFile`, `@` completion, `!` shell,
      `#` memory, todo strip.
      *Accept:* a session started in the terminal is indistinguishable in the desktop transcript from
      one started in the GUI, including approvals answered from either side.
- [ ] **M4 — The rest of the surface.** `threads`, `models`, `mcp`, `memory`, `todos`, `jobs`,
      `usage`, `providers`, `config`, `completion`, all with `--json`.
      *Accept:* every `LatticeApi` method is reachable from the CLI or explicitly documented as
      GUI-only (browser, PTY panel, window chrome).
- [ ] **M5 — Multi-session.** `attach --follow`, `sessions --activity --watch`, `message`, `inbox`,
      `stop`, `retry`, OSC notifications.
      *Accept:* a run started on the desktop is attached, steered, and stopped from a terminal; a
      message from a git hook reaches a live session.
- [ ] **M6 — Ship it.** `scripts/build-cli.mjs`, `bin/lattice`, `extraResources` in
      `electron-builder.yml`, `lattice install`, `docs/cli.md` (user-facing), README section,
      completions, `e2e-cli.mjs` in the required checks.
      *Accept:* `pnpm package` produces an app whose Settings offers "Install command line tool", and
      the installed binary runs against a closed app (embedded) and an open one (attached).
- [ ] **M7 — Nice to have, once the above is real.** `--watch` mode (re-run a prompt on file change),
      `lattice review` (diff → structured findings using the existing subagent machinery), git-hook
      recipes, `lattice exec <saved-prompt>`, tmux-aware split rendering.

---

## 15. Risks and open questions

1. **Native modules in embedded mode.** The packaged app's `better-sqlite3` is built for Electron's
   ABI; the CLI needs the Node ABI. Mitigation: ship a second prebuilt copy under
   `Resources/cli/node_modules` and have `doctor` verify it. Open: whether to instead make embedded
   mode *always* go through a spawned `lattice serve` (simpler ABI story, extra process).
2. **Two writers is the one unforgivable bug.** Hence the lock, the socket-first resolution order,
   and a test that specifically asserts refusal. Any future entrypoint that calls `registerIpc()`
   must take the lock — enforce it *inside* `registerIpc()` so it cannot be forgotten.
3. **Terminal diversity.** tmux/screen swallow Alt, VS Code's terminal reports odd sizes, older
   Terminal.app lacks truecolor. Mitigation: capability probe + the degradation matrix + the manual
   checklist; never assume a capability without probing it.
4. **Streaming markdown flicker.** Re-rendering an open block on every delta looks bad. Mitigation:
   only closed blocks are re-rendered, plus a frame-rate cap and diffed writes.
5. **Approval UX in scripts.** A parked approval in a non-interactive run is a hang. Locked: print
   mode denies and reports with exit code 5.
6. **Scope creep into a second UI.** The panels (`/context`, `/agents`, `/mcp`) are the tempting edge.
   Keep them read-mostly and paged; anything that wants real interaction belongs in the GUI.
7. **Open question — remote `cwd`.** With `--remote`, "this directory" is the *server's* filesystem.
   v1 refuses to bind a local path to a remote workspace and says so; a later slice can add file
   sync or an SSH-style mount.
8. **Open question — does the CLI ever start its own runtime by default?** Current answer: yes,
   embedded, because a terminal user with the app closed should not have to run a daemon first. If
   startup cost (native module load + MCP boot) proves high, flip the default to auto-spawning a
   detached `lattice serve` and attaching to it.

---

## Appendix A — event → surface parity table

| Concept | GUI | CLI |
| --- | --- | --- |
| Transcript | `Transcript.tsx` | `ui/transcript.ts` + `frame.ts` |
| Tool row / group | `ToolRow`, `groupTimeline` | same reducer, ANSI rows |
| Subagent card | `SubagentCard.tsx`, `indexSubagents` | same reducer, one-line card + expand |
| Approvals | `ApprovalBar.tsx` | inline prompt (§8.7) |
| Asks | `AskBar.tsx` | inline prompt (§8.8) |
| Context orbit | `ContextOrbit.tsx` | status-line percentage + `/context` |
| Tasks | `TasksPanel.tsx` | todo strip + `/tasks` + `lattice todos` |
| Agents | `AgentsPanel.tsx` | `/agents` |
| Sessions/Inbox | `Sessions.tsx` | `lattice sessions`, `lattice inbox`, `/sessions` |
| Usage | `UsagePage.tsx` | `lattice usage` (same `getStatsSnapshot`) |
| Files/Browser/Terminal panels | `FilesTab`/`BrowserTab`/`TerminalTab` | GUI-only by design (the CLI *is* the terminal) |

## Appendix B — new and changed files

**New**

```
src/cli/index.ts                     entry, arg parse, dispatch
src/cli/args.ts                      option table (also feeds completions + help)
src/cli/transport/{index,socket,embedded,remote,types}.ts
src/cli/session.ts                   thread/workspace binding, resume/continue
src/cli/print.ts                     -p mode, output formats
src/cli/commands/*.ts                one file per subcommand
src/cli/ui/*.ts                      screen, frame, diff, ansi, markdown, code, spinner, input, composer, transcript
src/cli/permissionSpec.ts            --allow-tool/--deny-tool → PermissionRule
src/main/net/local.ts                control socket server
src/shared/view/*.ts                 moved pure reducers + slashCatalog.ts
scripts/build-cli.mjs                esbuild bundle
scripts/e2e-cli.mjs                  end-to-end harness
bin/lattice                          node shim
docs/cli.md                          user-facing documentation
```

**Changed**

```
src/shared/ipc.ts                    + createWorkspace/updateWorkspace/deleteWorkspace/resolveWorkspace/attachFile (+ API_METHODS)
src/main/ipc.ts                      implement the above; boot/stop the control socket; take the runtime lock
src/main/store/db.ts                 threads.cwd migration
src/main/store/eventStore.ts         cwd read/write on ThreadMeta
src/shared/types.ts                  ThreadMeta.cwd, WorkspaceMeta helpers
src/main/tools/builtin.ts            ToolContext.cwd in path resolution
src/main/tools/ptyShell.ts           cwd-aware session keying
src/main/net/bridge.ts               (unchanged dispatch; exported for the local transport)
src/main/index.ts                    stop the control socket on quit; release the lock
src/renderer/src/components/*.ts     re-export from src/shared/view (mechanical)
package.json                         build:cli, cli scripts
electron-builder.yml                 extraResources for the CLI bundle
README.md / AGENTS.md                CLI section + source map entry
```

## Appendix C — source references

- Runtime and tool loop: `src/main/runtime/runManager.ts`
- API contract and push events: `src/shared/ipc.ts` (`LatticeApi`, `API_METHODS`, `PushEvent`)
- Domain types: `src/shared/types.ts` (`RunEventBody`, `SendOptions`, `Mode`, `PermissionPreset`,
  `RiskTier`, `ApprovalRequest`, `AskRequest`, `ThreadMeta`, `WorkspaceMeta`)
- Bridge transport, dispatch allow-list, redaction: `src/main/net/{server,bridge,auth}.ts`
- Running without Electron: `src/headless/{index,electron-shim}.ts`, `scripts/build-headless.mjs`
- Path containment: `src/main/files.ts` (`isPathInsideRoots`), `src/main/tools/builtin.ts:146`
- Shell sessions and platform abstraction: `src/main/tools/ptyShell.ts`, `src/main/platform/shell.ts`
- Pure view reducers to share: `src/renderer/src/components/{runTimeline,subagents,sidebarActivity}.ts`
- Slash command catalog to split: `src/renderer/src/components/commands.ts`
- Existing e2e harness pattern: `scripts/e2e-app.mjs`
