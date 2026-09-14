import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import type { AgentKind, AgentProfile, Fleet, Mode, PermissionPreset, ThreadId } from '@shared/types'
import type { ToolDefinition } from '../tools/types'
import {
  agentAllowlist,
  agentForThread,
  createAgent,
  createFleet,
  deleteAgent,
  findFleet,
  getFleet,
  listAgents,
  listFleets,
  updateAgent,
  type UpdateAgentPatch
} from '../store/agents'
import { getSettings, getThreadMeta, listWorkspaces } from '../store/eventStore'
import { effortDefaultFor } from './effortDefaults'
import { countSentSince, sendSessionMessage } from './sessionMessaging'

/**
 * Fleet runtime: the orchestrator-facing verbs (resolve a worker, delegate a task), the fleet-building
 * verbs any capable thread may use (create a fleet from a spec, add/update/remove agents), the tool
 * gating `availableTools` applies, the `# Fleet` prompt section, and the completion hook that makes a
 * worker's finished run reach its orchestrator even when the model forgot to `send_message`.
 *
 * Deliberately a near-leaf module — it imports the store and the (leaf) session-messaging broker,
 * never the run manager or the tool registry — so the dependency graph stays acyclic:
 * runManager → fleet, builtin → fleetTools → fleet. The two couplings it needs from above (push a
 * renderer event; check a cwd against workspace roots) arrive through {@link configureFleet}.
 *
 * Delegation is not a new transport: it reuses inter-session messaging, which already wakes an idle
 * agent (delegate), injects into a running one (steer), or queues behind its current work (queue).
 */

// ---------- wiring ----------

type PushFn = (event: PushEvent) => void

interface Deps {
  push: PushFn
  /** True when `path` lies inside one of `roots` (symlink-safe). Supplied by the IPC layer. */
  isPathInsideRoots: (path: string, roots: string[]) => Promise<boolean>
}

let deps: Deps | null = null

/** Wire the fleet runtime to the renderer push channel + path guard. Called once at startup by IPC. */
export function configureFleet(d: Deps): void {
  deps = d
}

/** Reset wiring (tests). */
export function resetFleet(): void {
  deps = null
}

/** Tell the renderer (Fleet screen, sidebar) that the roster changed; a new thread is announced too. */
function fleetChanged(threadId?: ThreadId): void {
  if (!deps) return
  if (threadId) {
    const meta = getThreadMeta(threadId)
    if (meta) deps.push({ kind: 'thread.updated', meta })
  }
  deps.push({ kind: 'fleet.updated' })
}

// ---------- tool gating ----------

/** The verb only an orchestrator gets: handing work to one of its own agents. */
export const ORCHESTRATOR_ONLY_TOOLS: ReadonlySet<string> = new Set(['delegate_to_agent'])

/** The fleet-building verbs: any thread that is not a worker may use them (a normal chat, or an orchestrator growing its own team). */
export const FLEET_MANAGEMENT_TOOLS: ReadonlySet<string> = new Set([
  'create_fleet',
  'add_agent',
  'update_agent',
  'remove_agent',
  'list_fleet'
])

/** Every fleet tool. Kept here (not in fleetTools) to avoid a cycle. */
export const FLEET_TOOL_NAMES: ReadonlySet<string> = new Set([...ORCHESTRATOR_ONLY_TOOLS, ...FLEET_MANAGEMENT_TOOLS])

/**
 * What an orchestrator is offered: coordination, memory, and the user — and NOT the work tools. With
 * web_search/fs/shell in reach, a small model reads "do the work through your agents" and then
 * searches the web itself (observed on qwen3:30b, 2026-09-14). Taking the work tools away makes
 * delegation the only path, on any model. An orchestrator's profile `allowedTools` extends this set
 * (the escape hatch for a lead that should also read a file or run a script).
 */
export const ORCHESTRATOR_TOOLS: ReadonlySet<string> = new Set([
  'list_fleet',
  'delegate_to_agent',
  'add_agent',
  'update_agent',
  'remove_agent',
  'peek_session',
  'list_sessions',
  'send_message',
  'check_inbox',
  'memory_search',
  'memory_save',
  'recall_threads',
  'ask_user',
  'todo_write',
  'set_thread_title',
  'batch'
])

/**
 * Tools a narrowed worker always keeps regardless of its allowlist: it must be able to report its
 * result back to the orchestrator (`send_message`), pick up queued follow-ups (`check_inbox`), recall
 * its own memory (`memory_search`), and fold multiple reads into one round-trip (`batch`).
 */
const WORKER_ALWAYS_KEEP = new Set(['send_message', 'check_inbox', 'memory_search', 'memory_save', 'recall_threads', 'batch'])

/**
 * Coordination tools a fleet agent keeps even on a LEAN (local-model) thread, where the generic lean
 * profile would otherwise drop them. Without this a worker on a local model has no `send_message` and
 * its delegated task silently never reports back; an orchestrator has no `peek_session` to check on
 * anyone. Returns undefined for a thread that is not a fleet agent (nothing to keep).
 */
export function fleetLeanKeep(threadId: ThreadId): ReadonlySet<string> | undefined {
  const self = agentForThread(threadId)
  if (!self) return undefined
  return self.kind === 'orchestrator'
    ? new Set(['send_message', 'check_inbox', 'peek_session', 'list_fleet', 'delegate_to_agent', 'recall_threads'])
    : new Set(['send_message', 'check_inbox', 'recall_threads'])
}

/**
 * Narrow a thread's tool set for fleet membership:
 *  - a WORKER loses every fleet tool and `ask_user` (it escalates to its orchestrator instead), and —
 *    when it has an explicit allowlist — keeps only the allowed builtins (plus the always-keep set
 *    and any MCP tools it has loaded);
 *  - an ORCHESTRATOR keeps only the coordination set ({@link ORCHESTRATOR_TOOLS}) plus whatever its
 *    profile allowlist adds — never the work tools, so it must delegate;
 *  - a thread that is not an agent loses only the orchestrator-only verb (`delegate_to_agent`), so a
 *    normal chat can still build fleets and see them.
 */
export function gateFleetTools(tools: ToolDefinition[], threadId: string): ToolDefinition[] {
  const self = agentForThread(threadId)
  if (!self) return tools.filter((tool) => !ORCHESTRATOR_ONLY_TOOLS.has(tool.name))
  if (self.kind === 'orchestrator') {
    const extra = new Set(agentAllowlist(threadId) ?? [])
    return tools.filter((tool) => ORCHESTRATOR_TOOLS.has(tool.name) || extra.has(tool.name))
  }
  let out = tools.filter((tool) => !FLEET_TOOL_NAMES.has(tool.name) && tool.name !== 'ask_user')
  const allow = agentAllowlist(threadId)
  if (allow) {
    const keep = new Set([...allow, ...WORKER_ALWAYS_KEEP])
    out = out.filter((tool) => keep.has(tool.name) || tool.mcpServerId !== undefined)
  }
  return out
}

// ---------- prompt ----------

/** First non-empty line of a role, clipped — for a compact roster line in the orchestrator's prompt. */
function firstLine(s: string): string {
  const line = (s.split('\n').find((l) => l.trim()) ?? '').trim()
  return line.length > 140 ? `${line.slice(0, 137)}…` : line
}

/**
 * The `# Fleet` system-prompt section for an agent thread (null for a non-agent). It gives the agent
 * standing context — who it is, its fleet, its teammates and their session ids — and encodes the
 * escalation chain: a worker reports to and asks the orchestrator (it has no `ask_user`), and the
 * orchestrator answers its workers, escalating to the human via `ask_user` only when it genuinely
 * cannot decide. It also names the traps a first-time orchestrator fell into: fleet agents are not
 * subagents (`peek_agents`/`agent_result` never see them), and memory usually already holds what the
 * user "was doing before".
 */
export function fleetPromptSection(threadId: string): string | null {
  const self = agentForThread(threadId)
  if (!self) return null
  const fleetName = getFleet(self.fleetId)?.name ?? 'the fleet'
  const mates = listAgents(self.fleetId)

  if (self.kind === 'orchestrator') {
    const workers = mates.filter((a) => a.kind === 'worker')
    const roster = workers.length
      ? workers
          .map((w) => `- ${w.name} (session ${w.threadId})${w.role ? ` — ${firstLine(w.role)}` : ''}`)
          .join('\n')
      : '- (no worker agents yet — add them with add_agent, or the user can on the Fleet screen)'
    return (
      `# Fleet\n` +
      `You are the orchestrator of the "${fleetName}" fleet. You coordinate a team of dedicated, ` +
      `persistent agents and do the real work THROUGH them, not yourself. Your agents:\n${roster}\n\n` +
      `How to work:\n` +
      `- You have no web, file or shell tools on purpose: every piece of real work goes to an agent. ` +
      `Delegate with delegate_to_agent(agent, task). Give the agent everything it needs for THIS ` +
      `job in the task text (the item, the criteria, the output you want back). It keeps its own ` +
      `memory, tools and working directory, so do not re-explain its standing role.\n` +
      `- Delegate ONCE per task and then end your turn. The agent reports back to you as a new ` +
      `message when it finishes (its final reply is forwarded to you automatically even if it forgets ` +
      `to send_message), and that message wakes you. Do not re-send the same task, and do not poll.\n` +
      `- To check on an agent without interrupting it, use peek_session with its session id above. ` +
      `Your fleet agents are NOT subagents: peek_agents, agent_result and run_agent never see them.\n` +
      `- Before asking the user what they "were doing before" or what their criteria are, call ` +
      `memory_search — the user's saved facts and past runs are usually there. Ask the human ` +
      `(ask_user) only for a genuine decision you cannot make: a preference, a spend, an irreversible ` +
      `action, or a fact memory does not hold.\n` +
      `- Your workers escalate their questions to YOU, not the user. When one messages you a ` +
      `question, answer it from what you know and reply with send_message to its session id; only ` +
      `escalate to the human when you genuinely cannot decide.\n` +
      `- When an agent reports back, fold its result in, hand the next step to the next agent if the ` +
      `job has more steps, and give the user a short, concrete report (what was found, the numbers, ` +
      `the links). If an agent reports it is blocked on an approval, tell the user to allow it on the ` +
      `Fleet screen.\n` +
      `- Never authorize an irreversible action (buying, messaging a seller, publishing, sending) ` +
      `without the user's explicit go-ahead.`
    )
  }

  const orch = mates.find((a) => a.kind === 'orchestrator')
  const orchRef = orch ? `the orchestrator "${orch.name}" (session id ${orch.threadId})` : 'the orchestrator'
  return (
    `# Fleet\n` +
    `You are "${self.name}", a dedicated worker agent in the "${fleetName}" fleet. You take tasks ` +
    `from ${orchRef} and carry them out in your own thread, with your own tools, memory and working ` +
    `directory.\n` +
    `- Do the task, then end your turn with a clear, complete final report: the concrete result, the ` +
    `numbers, the links, what you could not verify. Your final reply is forwarded to the ` +
    `orchestrator automatically when your run finishes, so a good final message IS your report. You ` +
    `may also send it explicitly with send_message to the orchestrator's session id.\n` +
    `- You have NO direct line to the human. If you need a decision, clarification, or approval you ` +
    `cannot resolve yourself, do not stop and wait — send_message to the orchestrator describing ` +
    `exactly what you need, then keep going once it answers. The orchestrator asks the user on your ` +
    `behalf when necessary.\n` +
    `- Use memory_search when the task refers to earlier work or criteria; save durable findings ` +
    `with memory_save so you never need re-briefing.`
  )
}

// ---------- resolve / delegate ----------

/** Resolve a worker within a fleet by id, thread id, or (case-insensitive) name/name-prefix. */
export function resolveWorker(fleetId: string, target: string): AgentProfile | { error: string } {
  const query = target.trim()
  if (!query) return { error: 'Name the agent to delegate to (see list_fleet).' }
  const agents = listAgents(fleetId)
  const byId = agents.find((a) => a.id === query || a.threadId === query)
  if (byId) return byId
  const lower = query.toLowerCase()
  const exact = agents.filter((a) => a.name.toLowerCase() === lower)
  const pool = exact.length ? exact : agents.filter((a) => a.name.toLowerCase().startsWith(lower))
  if (pool.length === 1) return pool[0]!
  if (pool.length > 1) {
    const names = pool.map((a) => `"${a.name}"`).join(', ')
    return { error: `"${query}" matches more than one agent: ${names}. Use the exact name.` }
  }
  return { error: `No agent named "${query}" in this fleet. Call list_fleet to see your agents.` }
}

export interface DelegateResult {
  ok: boolean
  delivery?: 'injected' | 'woken' | 'queued'
  agent?: string
  threadId?: string
  error?: string
}

/**
 * Delegate a task from an orchestrator to one of its workers. The message reaches the worker exactly
 * as inter-session messaging does: it wakes an idle worker into a fresh run (delegate), injects into
 * a running one at its next safe boundary (steer), or queues behind its current work. The worker
 * keeps its own thread, memory and cwd, so it needs no re-briefing.
 */
export function delegateToAgent(orchestratorThreadId: string, target: string, task: string): DelegateResult {
  const orchestrator = agentForThread(orchestratorThreadId)
  if (!orchestrator) return { ok: false, error: 'This thread is not an orchestrator agent.' }
  if (orchestrator.kind !== 'orchestrator') {
    return { ok: false, error: 'Only an orchestrator agent can delegate.' }
  }
  const worker = resolveWorker(orchestrator.fleetId, target)
  if ('error' in worker) return { ok: false, error: worker.error }
  if (worker.threadId === orchestratorThreadId) {
    return { ok: false, error: 'An orchestrator cannot delegate to itself.' }
  }
  const result = sendSessionMessage({
    fromThreadId: orchestratorThreadId,
    to: worker.threadId,
    body: task
  })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, delivery: result.delivery, agent: worker.name, threadId: worker.threadId }
}

// ---------- building a fleet from a spec ----------

/** One agent as a model (or the seed script) describes it. Everything but `name` has a sensible default. */
export interface AgentSpec {
  name: string
  /** The persona/mission, injected into the agent's system prompt. Strongly recommended. */
  role?: string
  /** Default `worker`. A fleet has exactly one orchestrator. */
  kind?: AgentKind
  /** Model id; defaults to the app's default model. */
  model?: string
  /** Working directory (must lie inside the workspace roots). Defaults to `<root>/fleet/<agent-slug>`. */
  cwd?: string
  /** Builtin tool allowlist for a worker; omit for everything its mode/preset grants. */
  tools?: string[]
  /**
   * Permission preset. Defaults to `full` — an agent runs unattended, and under `workspace` every
   * web/MCP/shell call parks on an approval card in a hidden thread until a human notices.
   */
  permissions?: PermissionPreset
  /** Default `act`. */
  mode?: Mode
  /** Rolling context (lives forever, self-summarizes). Default true. */
  rolling?: boolean
}

export interface FleetSpec {
  name: string
  /** The orchestrator. Omit to get a default "<fleet name> Lead" with the standard orchestrator role. */
  orchestrator?: Omit<AgentSpec, 'kind'>
  /** The worker agents. */
  agents?: AgentSpec[]
}

export const DEFAULT_ORCHESTRATOR_ROLE =
  'You are the orchestrator of a fleet of dedicated agents. Use list_fleet to see your agents and ' +
  'delegate_to_agent to hand each one work in its domain. Keep your own replies short; do the real ' +
  'work through your agents, check on them with peek_session, and report back to the user. Never ' +
  'take an irreversible action (purchase, send, publish) without the user’s go-ahead.'

const PERMISSION_PRESETS: readonly PermissionPreset[] = ['workspace', 'manual', 'full']
const MODES: readonly Mode[] = ['act', 'plan', 'review']

/** A filesystem-safe slug for an agent's default working directory. */
export function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'agent'
}

export interface CreatedAgentInfo {
  id: string
  name: string
  kind: AgentKind
  /** The agent's persistent thread — what `send_message`/`peek_session` address. */
  session: ThreadId
  model: string
  cwd?: string
  permissions: PermissionPreset
  mode: Mode
  rolling: boolean
  tools?: string[]
}

/** Describe a created/updated agent the way the tools report it. */
export function describeAgent(profile: AgentProfile): CreatedAgentInfo {
  const thread = getThreadMeta(profile.threadId)
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    session: profile.threadId,
    model: thread?.model ?? '',
    ...(thread?.cwd ? { cwd: thread.cwd } : {}),
    permissions: thread?.permissionPreset ?? 'workspace',
    mode: thread?.mode ?? 'act',
    rolling: !!thread?.contextPolicy,
    ...(profile.allowedTools?.length ? { tools: profile.allowedTools } : {})
  }
}

function validateSpec(spec: AgentSpec): string | null {
  if (!spec.name || !spec.name.trim()) return 'Every agent needs a name.'
  if (spec.permissions !== undefined && !PERMISSION_PRESETS.includes(spec.permissions)) {
    return `Unknown permissions "${spec.permissions}" for "${spec.name}" — use one of ${PERMISSION_PRESETS.join(', ')}.`
  }
  if (spec.mode !== undefined && !MODES.includes(spec.mode)) {
    return `Unknown mode "${spec.mode}" for "${spec.name}" — use one of ${MODES.join(', ')}.`
  }
  if (spec.kind !== undefined && spec.kind !== 'worker' && spec.kind !== 'orchestrator') {
    return `Unknown kind "${String(spec.kind)}" for "${spec.name}" — use worker or orchestrator.`
  }
  if (spec.tools !== undefined && (!Array.isArray(spec.tools) || spec.tools.some((t) => typeof t !== 'string'))) {
    return `"tools" for "${spec.name}" must be a list of tool names.`
  }
  return null
}

/**
 * Resolve an agent's working directory: an explicit one is checked against the workspace roots; an
 * omitted one becomes `<first root>/fleet/<slug>` and is created so the agent has somewhere to write.
 */
async function resolveCwd(spec: AgentSpec, roots: string[]): Promise<{ cwd?: string } | { error: string }> {
  if (spec.cwd && spec.cwd.trim()) {
    const cwd = resolve(spec.cwd.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
    const inside = deps ? await deps.isPathInsideRoots(cwd, roots) : true
    if (!inside) {
      return { error: `Working directory for "${spec.name}" (${cwd}) is outside the workspace roots (${roots.join(', ')}).` }
    }
    try {
      mkdirSync(cwd, { recursive: true })
    } catch {
      /* the thread can still exist without the dir; tools will report a missing cwd */
    }
    return { cwd }
  }
  const root = roots[0]
  if (!root) return {}
  const cwd = join(root, 'fleet', slug(spec.name))
  try {
    mkdirSync(cwd, { recursive: true })
  } catch {
    return {}
  }
  return { cwd }
}

/** Create one agent in a fleet from its spec, applying the defaults documented on {@link AgentSpec}. */
export async function createAgentFromSpec(
  fleet: Fleet,
  spec: AgentSpec
): Promise<{ ok: true; agent: CreatedAgentInfo } | { ok: false; error: string }> {
  const invalid = validateSpec(spec)
  if (invalid) return { ok: false, error: invalid }
  const kind: AgentKind = spec.kind ?? 'worker'
  if (kind === 'orchestrator' && listAgents(fleet.id).some((a) => a.kind === 'orchestrator')) {
    return { ok: false, error: `Fleet "${fleet.name}" already has an orchestrator; a fleet has exactly one.` }
  }
  const taken = listAgents(fleet.id).find((a) => a.name.toLowerCase() === spec.name.trim().toLowerCase())
  if (taken) return { ok: false, error: `Fleet "${fleet.name}" already has an agent named "${taken.name}".` }
  const workspace = listWorkspaces().find((w) => w.id === fleet.workspaceId)
  if (!workspace) return { ok: false, error: `Workspace not found for fleet "${fleet.name}".` }
  const settings = getSettings()
  const model = spec.model?.trim() || settings.defaultModel
  if (!model) return { ok: false, error: 'No model given and no default model is configured.' }
  const cwdRes = await resolveCwd(spec, workspace.roots)
  if ('error' in cwdRes) return { ok: false, error: cwdRes.error }
  const { profile } = createAgent({
    fleetId: fleet.id,
    name: spec.name.trim(),
    kind,
    role: spec.role?.trim() || (kind === 'orchestrator' ? DEFAULT_ORCHESTRATOR_ROLE : undefined),
    model,
    effort: effortDefaultFor(model, settings) ?? settings.defaultEffort,
    mode: spec.mode ?? 'act',
    permissionPreset: spec.permissions ?? 'full',
    cwd: cwdRes.cwd,
    rolling: spec.rolling ?? true,
    allowedTools: spec.tools
  })
  fleetChanged(profile.threadId)
  return { ok: true, agent: describeAgent(profile) }
}

export interface CreatedFleetInfo {
  id: string
  name: string
  agents: CreatedAgentInfo[]
}

/**
 * Create a whole fleet from a spec in one go: the fleet row, its orchestrator (a default one when the
 * spec omits it) and every worker. Agents are created in order; the first failure aborts and reports
 * which agent failed and why, leaving what was created so far (the model can add_agent the rest).
 */
export async function createFleetFromSpec(
  workspaceId: string,
  spec: FleetSpec
): Promise<{ ok: true; fleet: CreatedFleetInfo } | { ok: false; error: string; fleet?: CreatedFleetInfo }> {
  const name = spec.name?.trim()
  if (!name) return { ok: false, error: 'Give the fleet a name.' }
  const clash = listFleets(workspaceId).find((f) => f.name.toLowerCase() === name.toLowerCase())
  if (clash) {
    return { ok: false, error: `A fleet named "${clash.name}" already exists (id ${clash.id}). Add agents to it with add_agent, or pick another name.` }
  }
  const fleet = createFleet({ workspaceId, name })
  const created: CreatedAgentInfo[] = []
  const orchSpec: AgentSpec = {
    ...(spec.orchestrator ?? { name: `${name} Lead` }),
    name: spec.orchestrator?.name?.trim() || `${name} Lead`,
    kind: 'orchestrator'
  }
  const specs: AgentSpec[] = [orchSpec, ...(spec.agents ?? []).map((a) => ({ ...a, kind: a.kind ?? 'worker' }))]
  for (const agentSpec of specs) {
    const res = await createAgentFromSpec(fleet, agentSpec)
    if (!res.ok) {
      fleetChanged()
      return { ok: false, error: res.error, fleet: { id: fleet.id, name: fleet.name, agents: created } }
    }
    created.push(res.agent)
  }
  fleetChanged()
  return { ok: true, fleet: { id: fleet.id, name: fleet.name, agents: created } }
}

/** Apply a partial {@link AgentSpec} to an existing agent (name/role/model/cwd/tools/permissions/mode/rolling). */
export async function updateAgentFromSpec(
  profile: AgentProfile,
  patch: Partial<AgentSpec>
): Promise<{ ok: true; agent: CreatedAgentInfo } | { ok: false; error: string }> {
  const invalid = validateSpec({ ...patch, name: patch.name ?? profile.name })
  if (invalid) return { ok: false, error: invalid }
  if (patch.kind !== undefined && patch.kind !== profile.kind) {
    return { ok: false, error: 'An agent’s kind cannot be changed; remove it and add a new one.' }
  }
  const next: UpdateAgentPatch = {}
  if (patch.name !== undefined) next.name = patch.name
  if (patch.role !== undefined) next.role = patch.role
  if (patch.model !== undefined && patch.model.trim()) next.model = patch.model.trim()
  if (patch.permissions !== undefined) next.permissionPreset = patch.permissions
  if (patch.mode !== undefined) next.mode = patch.mode
  if (patch.rolling !== undefined) next.rolling = patch.rolling
  if (patch.tools !== undefined) next.allowedTools = patch.tools.length ? patch.tools : null
  if (patch.cwd !== undefined) {
    if (!patch.cwd.trim()) next.cwd = null
    else {
      const fleet = getFleet(profile.fleetId)
      const workspace = fleet ? listWorkspaces().find((w) => w.id === fleet.workspaceId) : undefined
      if (!workspace) return { ok: false, error: 'Workspace not found for this agent.' }
      const cwdRes = await resolveCwd({ name: profile.name, cwd: patch.cwd }, workspace.roots)
      if ('error' in cwdRes) return { ok: false, error: cwdRes.error }
      next.cwd = cwdRes.cwd ?? null
    }
  }
  const updated = updateAgent(profile.id, next)
  fleetChanged(updated.threadId)
  return { ok: true, agent: describeAgent(updated) }
}

/** Remove an agent and its thread. */
export function removeAgent(profile: AgentProfile): void {
  const threadId = profile.threadId
  deleteAgent(profile.id)
  deps?.push({ kind: 'thread.deleted', id: threadId })
  fleetChanged()
}

/**
 * The fleet a tool call refers to: an explicit `fleet` argument (id/name/prefix) wins; an
 * orchestrator's own fleet is the default; otherwise the workspace's only fleet. Returns an error
 * naming the candidates when it is ambiguous.
 */
export function fleetForCall(threadId: ThreadId, workspaceId: string, fleetArg?: string): Fleet | { error: string } {
  if (fleetArg && fleetArg.trim()) return findFleet(workspaceId, fleetArg)
  const self = agentForThread(threadId)
  if (self) {
    const own = getFleet(self.fleetId)
    if (own) return own
  }
  const fleets = listFleets(workspaceId)
  if (fleets.length === 1) return fleets[0]!
  if (fleets.length === 0) return { error: 'There is no fleet yet. Create one with create_fleet.' }
  return { error: `Several fleets exist — say which with the fleet argument: ${fleets.map((f) => `"${f.name}"`).join(', ')}.` }
}

// ---------- completion hook ----------

/**
 * The completion hook the run manager calls when a run on a fleet WORKER ends. If the run was a task
 * the orchestrator delegated (`delegatedBy` is the orchestrator's thread) and the worker did not
 * already message the orchestrator during the run, its final reply is forwarded as the report — so a
 * delegation always closes the loop, even when the model ended its turn without calling
 * `send_message` (small local models routinely do). Returns true when a report was sent.
 *
 * Runs the human started directly in the worker thread (`delegatedBy` undefined) are not forwarded:
 * the human is reading that thread, and waking the orchestrator would only be noise.
 */
export function reportWorkerRun(opts: {
  threadId: ThreadId
  delegatedBy?: ThreadId
  startedAt: number
  text: string
  reason: 'done' | 'error' | 'length'
}): boolean {
  const self = agentForThread(opts.threadId)
  if (!self || self.kind !== 'worker') return false
  const orch = listAgents(self.fleetId).find((a) => a.kind === 'orchestrator')
  if (!orch || !opts.delegatedBy || opts.delegatedBy !== orch.threadId) return false
  if (countSentSince(opts.threadId, orch.threadId, opts.startedAt) > 0) return false
  const text = opts.text.trim()
  const body =
    opts.reason === 'done'
      ? `Task report (my run finished):\n\n${text || '(I finished without writing a report — ask me to summarize what I found.)'}`
      : opts.reason === 'error'
        ? `My run ended with an ERROR before I could finish.${text ? ` What I had so far:\n\n${text}` : ''}`
        : `My run was cut off by the output limit before I could finish. What I had so far:\n\n${text || '(nothing usable)'}`
  const res = sendSessionMessage({ fromThreadId: opts.threadId, to: orch.threadId, body })
  return res.ok
}
