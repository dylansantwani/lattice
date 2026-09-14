# Agent Fleet

A fleet is a persistent orchestrator plus dedicated worker agents. Unlike the ephemeral subagents
`run_agent` spawns, a fleet agent lives on: it keeps its own thread, memory, working directory and
warm context across tasks, so you never re-brief it. You tell the orchestrator what you want; it
delegates to its workers, they report back, and it reports to you.

Open it with ⌘J (or the hub icon in the header).

## Three ways to build one

**Ask any chat.** In a normal thread, describe the team: "make me a fleet with an orchestrator, an
agent that finds 3D-printed products selling on eBay, one that checks sell-through, one that finds
the STL, one that pulls photos, and one that writes the listing." The model calls `create_fleet`
once with the whole spec and the fleet appears under ⌘J. It can refine with `add_agent`,
`update_agent` and `remove_agent`, and inspect with `list_fleet`.

**Use the screen.** ⌘J → "+ Fleet" (it asks for a name) → "Add the orchestrator" → "Add agent" for
each worker. Rename and Delete fleet live in the header.

**Seed from a file.** A JSON spec (same shape the tool takes) goes straight into the live DB, app
running or not, and the app notices without a restart:

```bash
node scripts/fleet-seed.mjs fleets/3d-print-desk.json
```

Re-running upserts by name (threads and memory are kept; roles/models/settings are updated; new
agents are added). `--replace` wipes and recreates; `--dry-run` shows what would happen. Ready-made
specs: `fleets/3d-print-desk.json` (eBay 3D-print pipeline: sourcer → STR analyst → STL finder → photo
puller → listing maker), `fleets/amazon-gold-desk.json` (Amazon FBM gold hunt: hunter → verifier →
print checker → STL sourcer → mailer; the rulebook is the one `GOLDRUSH.md` in the gapfinder repo
encodes), and `fleets/reselling-desk.json`.

## The spec

```json
{
  "name": "3D Print Desk",
  "orchestrator": { "name": "Print Desk Lead", "role": "...", "model": "deepseek/deepseek-v4-flash" },
  "agents": [
    { "name": "Product Sourcer", "role": "...", "cwd": "~/fleet/product-sourcer" },
    { "name": "STL Finder", "role": "...", "tools": ["web_search", "web_fetch"], "permissions": "full" }
  ]
}
```

Per agent, only `name` is required. Defaults: `kind` worker, the app's default model, `mode` act,
`permissions` **full**, `rolling` true, `cwd` `<workspace root>/fleet/<agent-slug>` (created for
you). `tools` is an optional allowlist of builtin names for a worker; `send_message`, `check_inbox`,
`memory_search`, `batch` and any MCP tools it loads are always kept. The orchestrator is optional —
omit it and you get "`<fleet name>` Lead" with the standard coordinator role.

Write roles like a job description for a specialist who will do the task many times: what it does,
how (which sites, which filters, which thresholds), what it must never do, and the exact shape of the
report it hands back. The role is injected into the agent's system prompt on every run.

## Why `full` permissions is the default

Under the `workspace` preset every web search, web fetch, MCP call and shell command in a worker
waits for a human approval — and a worker's thread is hidden from the sidebar. That is exactly how
the first fleet "silently died": the worker parked on a `web_search` approval card nobody saw. The
Fleet screen now surfaces every pending approval and question under **Needs you**, `list_fleet`
reports what each agent is `blocked_on`, and the orchestrator's prompt tells it to relay a block to
you — but an unattended agent should simply not be gated. Use `workspace` only for an agent you
intend to babysit; use `manual` for a read-only agent.

## The screen

Under the agent cards, **Activity** lists every hand-off in the fleet — the orchestrator's delegations
(`task` / `steer`), the workers' reports, and questions between agents — newest first; click to
expand, double-click to open the receiving agent's thread. **Needs you** at the top collects any
approval or question parked in a hidden agent thread. The header has Rename / + Fleet (asks for a
name) / Delete fleet.

Every agent thread also keeps a running digest, so an orchestrator (and any chat) can ask
`recall_threads` what its workers were doing without reading their transcripts — see
`docs/memory-continuity.md`.

## How a task flows

1. You type a task to the orchestrator (the command bar on the Fleet screen, or `send_message` to its
   session from any chat).
2. It calls `delegate_to_agent(agent, task)`. That is inter-session messaging: an idle worker is
   **woken** into a fresh run with the task; a busy one gets it **injected** at its next safe
   boundary (steer). The orchestrator then ends its turn — it does not poll.
3. The worker does the job in its own thread, with its own tools, cwd and memory. If it needs a
   decision it `send_message`s the orchestrator (it has no `ask_user`); the orchestrator answers, or
   escalates to you with `ask_user` only for a genuine decision (a preference, a spend, an
   irreversible action).
4. When the worker's run finishes, its report reaches the orchestrator **automatically**: if it did
   not `send_message` during the run, its final reply is forwarded as the report (an errored or
   cut-off run is labeled as such). This is what closes the loop on small local models that end their
   turn without calling a tool. That message wakes the orchestrator, which folds the result in, hands
   the next step to the next agent if there is one, and reports to you.
5. `peek_session` (with the session id `list_fleet` returns) lets the orchestrator — or you, from any
   chat — look at a worker without interrupting it. Fleet agents are not subagents: `peek_agents`,
   `agent_result` and `run_agent` never see them.

## Models

Local models run a lean tool set to save context. Fleet agents keep their coordination tools through
that cut: a worker always has `send_message` and `check_inbox`; an orchestrator also keeps
`peek_session`, `list_fleet` and `delegate_to_agent`. The fleet-building verbs (`create_fleet` etc.)
are not offered on lean threads — build the fleet from a capable model, then run it on whatever you
like. Change an agent's model from its card (the picker) or with `update_agent`.

## Tools reference

| Tool | Who gets it | What it does |
| --- | --- | --- |
| `create_fleet(name, orchestrator?, agents)` | any non-worker thread | Build a whole fleet in one call. |
| `add_agent(name, role, …, fleet?)` | any non-worker thread | Add one agent (own fleet for an orchestrator; `fleet` when ambiguous). |
| `update_agent(agent, …)` | any non-worker thread | Change role/model/cwd/tools/permissions/mode/rolling/name. |
| `remove_agent(agent)` | any non-worker thread (R1: asks under `workspace`) | Delete an agent and its thread. |
| `list_fleet(fleet?)` | any non-worker thread | Agents with session ids, live status, `blocked_on`, queued count. From a plain thread without `fleet`: every fleet. |
| `delegate_to_agent(agent, task)` | orchestrator only | Hand a task to one of its own agents. |

Workers get none of these (they report to the orchestrator with `send_message`). Subagents spawned
by `run_agent` get none of them either.

**An orchestrator has no work tools.** It is offered only the coordination set — the fleet verbs,
`peek_session`, `send_message`/`check_inbox`, memory, `recall_threads`, `ask_user`, `todo_write` — and
never `web_search`, files or `shell`. The first live run showed why: with those in reach, a 30B local
model read "do the work through your agents" and then ran the eBay searches itself. Taking the work
tools away makes delegation the only path on any model. If a lead genuinely needs a work tool, name it
in its `tools` allowlist (the profile's Tools field / the spec's `tools`) and it is added back.

## Troubleshooting

- **Nothing happens after I delegate.** Open ⌘J: if an agent shows under *Needs you*, it is waiting
  on an approval or a question — allow it, or switch the agent to `full`. `list_fleet` from any chat
  shows the same as `blocked_on`.
- **The orchestrator keeps asking me what I was doing before.** Its prompt now tells it to
  `memory_search` first. If memory genuinely has nothing, tell it once; it saves what it learns.
- **The orchestrator re-delegates the same task twice.** Fixed in the prompt and the tool result
  ("end your turn now rather than waiting or re-sending"). If a model still does it, the worker
  receives the second message as a steer and folds it in; nothing is lost.
- **The worker never reported back.** It now cannot fail to: the completion hook forwards its final
  reply. If the reply is empty the orchestrator is told to ask it to summarize.
- **An agent I seeded from a script did not get its fleet prompt.** The agent cache now tracks
  SQLite's `data_version`, so external writes are seen immediately. No restart needed.
- **"agent cwd is outside the workspace roots".** Working directories must lie inside a workspace root
  (`~` for the default workspace). Omit `cwd` to get `<root>/fleet/<agent-slug>`.

## Code map

- `src/shared/types.ts` — `Fleet`, `AgentProfile`, `FleetAgentView`, `AgentKind`.
- `src/main/store/db.ts` — `fleets` and `agent_profiles` tables.
- `src/main/store/agents.ts` — fleet/agent CRUD, `findFleet`, and the thread-id → profile cache
  (invalidated by own writes and by `PRAGMA data_version` for external ones).
- `src/main/runtime/fleet.ts` — tool gating (`gateFleetTools`, `fleetLeanKeep`), the `# Fleet`
  prompt section, `delegateToAgent`, spec building (`createFleetFromSpec`, `createAgentFromSpec`,
  `updateAgentFromSpec`), and `reportWorkerRun` (the completion hook).
- `src/main/tools/fleetTools.ts` — the six tools above.
- `src/main/runtime/runManager.ts` — `availableTools` applies the gate and the lean keep-set; a
  run records `delegatedBy`/`startedAt` and calls `reportWorkerRun` on completion.
- `src/main/runtime/contextProfile.ts` — `leanToolSet(tools, { keep })`.
- `src/main/ipc.ts` — `configureFleet`, the `listFleets`/`createFleet`/`renameFleet`/`deleteFleet`
  and `listAgents`/`createAgent`/`updateAgent`/`deleteAgent` handlers the screen uses.
- `src/renderer/src/components/Fleet.tsx` — the screen (⌘J).
- `scripts/fleet-seed.mjs`, `fleets/*.json` — seeding from a spec.

Tests: `src/main/store/agents.test.ts`, `src/main/runtime/fleet.test.ts`,
`src/main/tools/fleetTools.test.ts`, `src/main/runtime/contextProfile.test.ts`.
