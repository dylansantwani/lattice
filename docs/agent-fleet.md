# Agent Fleet

A persistent orchestrator plus dedicated worker agents, on one screen (⌘J, or the hub icon in the
header). Unlike the ephemeral subagents `run_agent` spawns, a fleet agent lives on: it keeps its own
thread, memory scope, working directory and warm context across tasks, so you never re-brief it. You
tell the orchestrator what you want; it delegates to its workers and reports back.

## What an agent is

An agent is a saved role bound one-to-one to a persistent thread:

- Conversation settings — model, `cwd`, mode/preset, rolling `contextPolicy` — live on the thread
  (`ThreadMeta`) and are reached through the normal thread machinery.
- Identity — name, kind (`orchestrator` | `worker`), role, and an optional builtin tool allowlist —
  lives in an `agent_profiles` row (see `src/main/store/agents.ts`).
- The `role` is mirrored into the thread's `goal`, which the run manager already injects into the
  system prompt — so persona injection is free, no prompt surgery.

Deleting an agent deletes its thread. A fleet (`fleets` table) groups one orchestrator and its
workers, scoped to a workspace.

## Delegate, steer, queue, discuss

None of these are a new transport — they reuse the Slice-9 inter-session messaging path
(`src/main/runtime/sessionMessaging.ts`), which already:

- wakes an idle agent into a fresh run (delegate),
- injects into a running agent at its next safe boundary (steer),
- and persists the exchange so you can peek at it (`peek_session`) or read the inbox.

The orchestrator gets two extra tools (`src/main/tools/fleetTools.ts`), offered only to an
orchestrator's thread (gated in `availableTools` via `gateFleetTools`):

- `list_fleet` — its agents, their roles, models, and how busy each is.
- `delegate_to_agent(agent, task)` — hand a task to a named worker; it wakes/steers/queues per the
  worker's state and reports back when done.

From the UI you can do the same to any agent directly: the message box on an agent card sends with a
`send` / `steer` / `queue` disposition to that agent's thread.

## Tools and working directory

Give an agent tools by setting its mode/preset and, optionally, a builtin allowlist (comma-separated
names in the config panel). An allowlist narrows the builtins to the named set, but always keeps
`send_message`, `check_inbox`, `memory_search` and `batch` (so a worker can report back and recall),
and keeps any MCP tools it loads. Set a working directory (`cwd`) inside the workspace roots; the
agent resolves paths and runs shell commands from there.

## Context

Turn on "rolling context" (recommended for workers) to make an agent's thread live forever: past its
trigger it folds old turns into a running summary and mines them for long-term memories, keeping
recent conversation verbatim. Continuity you care about lives in the agent's memory scope, so the
window stays bounded and the agent is never re-briefed.

## Code map

- `src/shared/types.ts` — `Fleet`, `AgentProfile`, `FleetAgentView`, `AgentKind`.
- `src/main/store/db.ts` — `fleets` and `agent_profiles` tables.
- `src/main/store/agents.ts` — fleet/agent CRUD and the thread-id → profile cache.
- `src/main/runtime/fleet.ts` — `resolveWorker`, `delegateToAgent`, `gateFleetTools`.
- `src/main/tools/fleetTools.ts` — the `list_fleet` and `delegate_to_agent` tools.
- `src/main/ipc.ts` — `listFleets`/`createFleet`/`renameFleet`/`deleteFleet` and
  `listAgents`/`createAgent`/`updateAgent`/`deleteAgent`.
- `src/renderer/src/components/Fleet.tsx` — the screen (⌘J).

Tests: `src/main/store/agents.test.ts`, `src/main/runtime/fleet.test.ts`,
`src/main/tools/fleetTools.test.ts`.

## Seeding an example fleet

`scripts/seed-fleet.mjs` writes a ready-to-use "Reselling Desk" fleet straight into the live DB — an
orchestrator (Desk Lead) plus eBay Sourcing, Comp Scout, Listing Writer, and Model Scout, each on the
default model with its own cwd under `~/fleet/…` and rolling context on. It matches `store.createAgent`'s
insert shape exactly, so it needs no Electron runtime:

```bash
node scripts/seed-fleet.mjs
```

Re-running replaces the same-named fleet. The agents appear under ⌘J once you run the build that has
the Fleet feature (it loads them fresh on start).

