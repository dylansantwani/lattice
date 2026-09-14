import type { ToolDefinition } from './types'
import type { AgentKind, Mode, PermissionPreset } from '@shared/types'
import { agentForThread, getFleet, listAgents, listFleetChanges, listFleets } from '../store/agents'
import { getThreadMeta } from '../store/eventStore'
import { sessionWorkRunning, stopSessionWork, unreadCount } from '../runtime/sessionMessaging'
import { getSessionActivity } from '../runtime/sessionActivity'
import {
  applyWorkingMemoryEdit,
  readWorkingMemory,
  SOFT_LIMIT,
  writeWorkingMemory,
  type WorkingMemoryEdit
} from '../runtime/agentMemory'
import {
  actorForThread,
  createAgentFromSpec,
  createFleetFromSpec,
  delegateToAgent,
  describeAgent,
  fleetForCall,
  removeAgent,
  resolveWorker,
  updateAgentFromSpec,
  type AgentSpec
} from '../runtime/fleet'

/**
 * The fleet tools.
 *
 * Coordination (orchestrator only — gated in `availableTools` via `gateFleetTools`):
 *  - `delegate_to_agent` hands a task to one of the orchestrator's own agents.
 *
 * Building (any thread that is not a worker: a normal chat, or an orchestrator growing its team):
 *  - `create_fleet` builds a whole fleet from one spec (orchestrator + workers) in a single call —
 *    the way a model sets one up when the user says "make me a fleet that does X".
 *  - `add_agent` / `update_agent` / `remove_agent` edit one agent.
 *  - `list_fleet` shows a fleet's agents with their live status, or every fleet in the workspace.
 *
 * Improving (so a fleet gets better over time instead of repeating its mistakes):
 *  - `working_memory` is a fleet agent's own markdown notebook (runtime/agentMemory.ts), shown to it
 *    at the start of every run. Orchestrator and workers both get it; a plain chat does not.
 *  - `fleet_history` reads the change log: every add/update/remove with who, why, and the fields
 *    before/after — how an orchestrator sees that a role edit made things worse and reverts it.
 *  - add/update/remove take a `reason`, recorded in that log and in the orchestrator's notebook.
 *
 * Every mutation is reversible from the Fleet screen (⌘J), so building is R0 — no approval card
 * between the user asking for a fleet and getting one. Removing an agent deletes its thread and
 * history, so that one is R1 and asks under the workspace preset.
 */

const REASON_PROPERTY = {
  type: 'string',
  description:
    'Why you are making this change (e.g. "kept returning active listings instead of sold ones"). Recorded ' +
    'in the fleet change log so you can later tell whether it helped.'
} as const

const AGENT_SPEC_PROPERTIES = {
  name: { type: 'string', description: 'Short, unique name (e.g. "Product Sourcer"). Also its session title.' },
  role: {
    type: 'string',
    description:
      'Its standing mission, injected into its system prompt every run: what it does, how, what it must ' +
      'never do, and the shape of the report it hands back. Write it like a job description for a ' +
      'specialist who will do this task many times.'
  },
  model: { type: 'string', description: 'Model id (see the model picker). Omit for the default model.' },
  effort: {
    type: 'string',
    enum: ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    description: 'Reasoning effort used by this agent on its next run. Omit for the model default.'
  },
  cwd: {
    type: 'string',
    description: 'Working directory (inside the workspace roots). Omit for <root>/fleet/<agent-name>.'
  },
  tools: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Optional builtin tool allowlist for a worker (e.g. ["web_search","web_fetch","fs_write"]). Omit to ' +
      'give it everything its mode/permissions allow. send_message, check_inbox, memory_search, batch and ' +
      'any MCP tools it loads are always kept.'
  },
  permissions: {
    type: 'string',
    enum: ['full', 'workspace', 'manual'],
    description:
      'Default "full": the agent runs unattended. "workspace" makes every web/MCP/shell call wait for a ' +
      'human approval on the Fleet screen — an unattended agent stalls there.'
  },
  mode: { type: 'string', enum: ['act', 'plan', 'review'], description: 'Default "act".' },
  rolling: { type: 'boolean', description: 'Rolling context (lives forever, self-summarizes). Default true.' }
} as const

function specFrom(args: Record<string, unknown>): AgentSpec {
  const spec: AgentSpec = { name: String(args.name ?? '').trim() }
  if (typeof args.role === 'string') spec.role = args.role
  if (typeof args.model === 'string') spec.model = args.model
  if (typeof args.effort === 'string') spec.effort = args.effort
  if (typeof args.cwd === 'string') spec.cwd = args.cwd
  if (Array.isArray(args.tools)) spec.tools = args.tools.map((t) => String(t))
  if (typeof args.permissions === 'string') spec.permissions = args.permissions as PermissionPreset
  if (typeof args.mode === 'string') spec.mode = args.mode as Mode
  if (typeof args.rolling === 'boolean') spec.rolling = args.rolling
  if (typeof args.kind === 'string') spec.kind = args.kind as AgentKind
  return spec
}

/** One agent row as list_fleet reports it: identity + live state + what it is blocked on. */
function agentRow(a: { id: string; name: string; kind: AgentKind; role?: string; threadId: string; allowedTools?: string[] }) {
  const thread = getThreadMeta(a.threadId)
  const live = getSessionActivity(a.threadId, { forObserver: true })
  const queued = unreadCount(a.threadId)
  const blocked = live && !live.withheld
    ? [
        ...live.pending.approvals.map((p) => `approval needed: ${p.tool} — ${p.summary}`),
        ...live.pending.asks.map((q) => `question pending: ${q.question}`)
      ]
    : []
  return {
    name: a.name,
    kind: a.kind,
    session: a.threadId,
    ...(a.role ? { role: a.role } : {}),
    ...(thread?.model ? { model: thread.model } : {}),
    ...(thread?.effort ? { reasoning: thread.effort } : {}),
    ...(thread?.cwd ? { cwd: thread.cwd } : {}),
    permissions: thread?.permissionPreset ?? 'workspace',
    ...(a.allowedTools?.length ? { tools: a.allowedTools } : {}),
    ...(live ? { status: live.status, status_text: live.statusText } : {}),
    ...(live?.activity ? { doing: live.activity } : {}),
    ...(blocked.length ? { blocked_on: blocked } : {}),
    ...(queued ? { queued } : {})
  }
}

const listFleetTool: ToolDefinition = {
  name: 'list_fleet',
  description:
    'List the agents of a fleet with their live status: name, role, model, session id, whether each is ' +
    'running/idle, what it is doing, and anything it is blocked on (an approval or question waiting on a ' +
    'human). As an orchestrator you see your own fleet — use an agent name as the `agent` for ' +
    'delegate_to_agent and its session id for peek_session/send_message. From any other thread, name a ' +
    'fleet or omit it to see every fleet in the workspace.',
  parameters: {
    type: 'object',
    properties: {
      fleet: { type: 'string', description: 'Fleet name or id. Omit for your own fleet (orchestrator) or all fleets.' }
    },
    additionalProperties: false
  },
  resource: 'external_action',
  action: 'read',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: () => 'List fleet agents',
  async run(args, ctx) {
    const self = agentForThread(ctx.threadMeta.id)
    const fleetArg = typeof args.fleet === 'string' ? args.fleet : undefined
    if (self?.kind === 'orchestrator' && !fleetArg) {
      const agents = listAgents(self.fleetId).filter((a) => a.threadId !== ctx.threadMeta.id)
      const fleet = getFleet(self.fleetId)
      return { fleet: fleet?.name, count: agents.length, agents: agents.map(agentRow) }
    }
    if (self?.kind === 'worker') return { ok: false, error: 'Workers do not manage the fleet; report to your orchestrator.' }
    if (fleetArg) {
      const fleet = fleetForCall(ctx.threadMeta.id, ctx.workspace.id, fleetArg)
      if ('error' in fleet) return { ok: false, error: fleet.error }
      const agents = listAgents(fleet.id)
      return { fleet: fleet.name, id: fleet.id, count: agents.length, agents: agents.map(agentRow) }
    }
    const fleets = listFleets(ctx.workspace.id)
    if (fleets.length === 0) {
      return { count: 0, fleets: [], note: 'No fleets yet. Build one with create_fleet.' }
    }
    return {
      count: fleets.length,
      fleets: fleets.map((f) => {
        const agents = listAgents(f.id)
        const orch = agents.find((a) => a.kind === 'orchestrator')
        return {
          name: f.name,
          id: f.id,
          ...(orch ? { orchestrator: orch.name, orchestrator_session: orch.threadId } : { orchestrator: null }),
          agents: agents.map(agentRow)
        }
      }),
      note: 'To give a fleet work from here, send_message to its orchestrator_session; it delegates to its agents and reports back.'
    }
  }
}

const delegateTool: ToolDefinition = {
  name: 'delegate_to_agent',
  description:
    'Hand a task to one of your dedicated agents (see list_fleet). The agent carries it out in its own ' +
    'thread, with its own tools, working directory and memory. If it is idle it starts immediately; if ' +
    'it is busy, your task is folded into what it is doing (to steer it) or queued behind its current ' +
    'work. A new task to an idle agent starts from a clean context (its role and working memory, not its ' +
    'earlier tasks), so make the task self-contained: every fact, link and decision it depends on. When ' +
    'it finishes, its report arrives as a message that wakes you — so delegate once, then end your ' +
    'turn; do not poll or re-send. Use peek_session with its session id to look without interrupting.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'The agent name or id (from list_fleet).' },
      task: {
        type: 'string',
        description: 'What you want the agent to do — be specific about the input, the criteria and the report you want back. It has its own memory of past work.'
      }
    },
    required: ['agent', 'task'],
    additionalProperties: false
  },
  resource: 'external_action',
  action: 'submit',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: (args) => {
    const agent = typeof args.agent === 'string' ? args.agent : '?'
    const task = typeof args.task === 'string' ? args.task : ''
    return `Delegate to ${agent}: ${task.slice(0, 60)}`
  },
  async run(args, ctx) {
    const agent = String(args.agent ?? '').trim()
    const task = String(args.task ?? '').trim()
    if (!agent) return { ok: false, error: 'Name the agent to delegate to (see list_fleet).' }
    if (!task) return { ok: false, error: 'Provide the task to delegate.' }
    const result = delegateToAgent(ctx.threadMeta.id, agent, task)
    if (!result.ok) return { ok: false, error: result.error }
    const where =
      result.delivery === 'woken'
        ? `${result.agent} was idle and has started on it now`
        : result.delivery === 'injected'
          ? `delivered into ${result.agent}'s current work — it will fold it in`
          : `queued for ${result.agent}, behind its current task`
    return {
      ok: true,
      delivery: result.delivery,
      agent: result.agent,
      session: result.threadId,
      ...(result.freshContext ? { fresh_context: true } : {}),
      summary: `Task ${where}.${result.freshContext ? ' It started from a clean context (earlier tasks set aside), so it knows only your brief, its role and its working memory.' : ''} Its report will arrive as a message when it finishes — end your turn now rather than waiting or re-sending.`
    }
  }
}

const createFleetTool: ToolDefinition = {
  name: 'create_fleet',
  description:
    'Build a persistent agent fleet in one call: a named fleet, its orchestrator, and its worker agents. ' +
    'Each agent becomes a long-lived thread with its own role (system prompt), model, working directory, ' +
    'tools, permissions and working memory; each delegated task starts from a clean context. Use it when the user wants a standing ' +
    'team for a recurring job ("an orchestrator with a sourcer, a comps checker and a listing writer"). ' +
    'Give every worker a precise role: what it does, how, what it never does, and the report format it ' +
    'returns. Afterwards the user drives the fleet from the Fleet screen (⌘J), or you can send_message ' +
    'the orchestrator session it returns.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Fleet name, e.g. "3D Print Desk".' },
      orchestrator: {
        type: 'object',
        description: 'The orchestrator (optional — omit for "<name> Lead" with the standard coordinator role). Same fields as an agent.',
        properties: AGENT_SPEC_PROPERTIES,
        additionalProperties: false
      },
      agents: {
        type: 'array',
        description: 'The worker agents, in the order they usually run.',
        items: { type: 'object', properties: AGENT_SPEC_PROPERTIES, required: ['name'], additionalProperties: false }
      }
    },
    required: ['name', 'agents'],
    additionalProperties: false
  },
  resource: 'external_action',
  action: 'submit',
  riskTier: 'R0',
  allowedInPlan: false,
  summarize: (args) => {
    const name = typeof args.name === 'string' ? args.name : '?'
    const n = Array.isArray(args.agents) ? args.agents.length : 0
    return `Create fleet "${name}" with ${n} agent${n === 1 ? '' : 's'}`
  },
  async run(args, ctx) {
    if (agentForThread(ctx.threadMeta.id)?.kind === 'worker') {
      return { ok: false, error: 'Workers do not build fleets.' }
    }
    const name = String(args.name ?? '').trim()
    if (!name) return { ok: false, error: 'Give the fleet a name.' }
    const rawAgents = Array.isArray(args.agents) ? args.agents : []
    const agents = rawAgents.map((a) => specFrom((a ?? {}) as Record<string, unknown>))
    const orchestrator =
      args.orchestrator && typeof args.orchestrator === 'object'
        ? specFrom(args.orchestrator as Record<string, unknown>)
        : undefined
    const res = await createFleetFromSpec(
      ctx.workspace.id,
      { name, orchestrator, agents },
      { actor: actorForThread(ctx.threadMeta.id), reason: 'created with the fleet' }
    )
    if (!res.ok) return { ok: false, error: res.error, ...(res.fleet ? { created_so_far: res.fleet } : {}) }
    const orch = res.fleet.agents.find((a) => a.kind === 'orchestrator')
    return {
      ok: true,
      fleet: res.fleet,
      next:
        `Fleet "${res.fleet.name}" is live. The user can open it with ⌘J (the hub icon) and type a task to ` +
        `${orch?.name ?? 'the orchestrator'}; from here, send_message to:"${orch?.session ?? ''}" does the same. ` +
        `Agents default to "full" permissions so they run unattended; tell the user if any should be narrowed.`
    }
  }
}

const addAgentTool: ToolDefinition = {
  name: 'add_agent',
  description:
    'Add one persistent agent to a fleet (your own fleet if you are its orchestrator; otherwise name the ' +
    'fleet, or omit it when there is only one). Give it a precise role. Defaults: worker, the default ' +
    'model, <root>/fleet/<name> as its working directory, "full" permissions, rolling context.',
  parameters: {
    type: 'object',
    properties: {
      fleet: { type: 'string', description: 'Fleet name or id (optional when unambiguous).' },
      kind: { type: 'string', enum: ['worker', 'orchestrator'], description: 'Default worker. A fleet has one orchestrator.' },
      ...AGENT_SPEC_PROPERTIES,
      reason: REASON_PROPERTY
    },
    required: ['name'],
    additionalProperties: false
  },
  resource: 'external_action',
  action: 'submit',
  riskTier: 'R0',
  allowedInPlan: false,
  summarize: (args) => `Add agent ${typeof args.name === 'string' ? args.name : '?'}`,
  async run(args, ctx) {
    if (agentForThread(ctx.threadMeta.id)?.kind === 'worker') {
      return { ok: false, error: 'Workers do not build fleets.' }
    }
    const fleet = fleetForCall(ctx.threadMeta.id, ctx.workspace.id, typeof args.fleet === 'string' ? args.fleet : undefined)
    if ('error' in fleet) return { ok: false, error: fleet.error }
    const reason = typeof args.reason === 'string' ? args.reason : undefined
    const res = await createAgentFromSpec(fleet, specFrom(args), { actor: actorForThread(ctx.threadMeta.id), reason })
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true, fleet: fleet.name, agent: res.agent }
  }
}

const updateAgentTool: ToolDefinition = {
  name: 'update_agent',
  description:
    'Change an existing fleet agent: its role, model, reasoning effort, working directory, tools, permissions, mode, rolling ' +
    'context or name. Only the fields you pass change. Its thread and memory are kept. This is how a fleet ' +
    'learns: when an agent repeats a mistake, write the fix into its role instead of re-explaining it in ' +
    'every task. An orchestrator may also update itself. Pass a reason; the result returns the previous ' +
    'values, and fleet_history keeps them so a change that made things worse can be reverted.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'The agent name or id.' },
      fleet: { type: 'string', description: 'Fleet name or id (optional when unambiguous).' },
      new_name: { type: 'string', description: 'Rename the agent.' },
      role: AGENT_SPEC_PROPERTIES.role,
      model: AGENT_SPEC_PROPERTIES.model,
      effort: AGENT_SPEC_PROPERTIES.effort,
      cwd: AGENT_SPEC_PROPERTIES.cwd,
      tools: { ...AGENT_SPEC_PROPERTIES.tools, description: 'Replace the tool allowlist; pass [] to clear it.' },
      permissions: AGENT_SPEC_PROPERTIES.permissions,
      mode: AGENT_SPEC_PROPERTIES.mode,
      rolling: AGENT_SPEC_PROPERTIES.rolling,
      reason: REASON_PROPERTY
    },
    required: ['agent'],
    additionalProperties: false
  },
  resource: 'external_action',
  action: 'submit',
  riskTier: 'R0',
  allowedInPlan: false,
  summarize: (args) => `Update agent ${typeof args.agent === 'string' ? args.agent : '?'}`,
  async run(args, ctx) {
    if (agentForThread(ctx.threadMeta.id)?.kind === 'worker') {
      return { ok: false, error: 'Workers do not manage the fleet.' }
    }
    const fleet = fleetForCall(ctx.threadMeta.id, ctx.workspace.id, typeof args.fleet === 'string' ? args.fleet : undefined)
    if ('error' in fleet) return { ok: false, error: fleet.error }
    const target = resolveWorker(fleet.id, String(args.agent ?? ''))
    if ('error' in target) return { ok: false, error: target.error }
    const patch: Partial<AgentSpec> = {}
    if (typeof args.new_name === 'string' && args.new_name.trim()) patch.name = args.new_name.trim()
    if (typeof args.role === 'string') patch.role = args.role
    if (typeof args.model === 'string') patch.model = args.model
    if (typeof args.effort === 'string') patch.effort = args.effort
    if (typeof args.cwd === 'string') patch.cwd = args.cwd
    if (Array.isArray(args.tools)) patch.tools = args.tools.map((t) => String(t))
    if (typeof args.permissions === 'string') patch.permissions = args.permissions as PermissionPreset
    if (typeof args.mode === 'string') patch.mode = args.mode as Mode
    if (typeof args.rolling === 'boolean') patch.rolling = args.rolling
    if (Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to change — pass at least one field.' }
    const self = agentForThread(ctx.threadMeta.id)
    if (self?.id === target.id && (patch.tools !== undefined || patch.permissions !== undefined || patch.mode !== undefined)) {
      return {
        ok: false,
        error: 'An orchestrator may refine its own name, role, model, reasoning effort, working directory, or rolling context, but it cannot grant itself tools, widen permissions, or change its operating mode. The user can change those controls on the Fleet screen.'
      }
    }
    const reason = typeof args.reason === 'string' ? args.reason : undefined
    const res = await updateAgentFromSpec(target, patch, { actor: actorForThread(ctx.threadMeta.id), reason })
    if (!res.ok) return { ok: false, error: res.error }
    if (!res.changed.length) return { ok: true, fleet: fleet.name, agent: res.agent, note: 'Nothing changed — the values you passed are already set.' }
    return {
      ok: true,
      fleet: fleet.name,
      agent: res.agent,
      changed: res.changed,
      previous: res.previous,
      ...(reason ? {} : { note: 'Logged without a reason — next time pass `reason` so the change log says why.' })
    }
  }
}

const removeAgentTool: ToolDefinition = {
  name: 'remove_agent',
  description:
    'Remove an agent from a fleet. This deletes its persistent thread and history (its saved memories ' +
    'stay). Prefer update_agent to fix a role; remove only when the user wants the agent gone.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'The agent name or id.' },
      fleet: { type: 'string', description: 'Fleet name or id (optional when unambiguous).' },
      reason: REASON_PROPERTY
    },
    required: ['agent'],
    additionalProperties: false
  },
  resource: 'external_action',
  action: 'submit',
  riskTier: 'R1',
  allowedInPlan: false,
  summarize: (args) => `Remove agent ${typeof args.agent === 'string' ? args.agent : '?'}`,
  async run(args, ctx) {
    if (agentForThread(ctx.threadMeta.id)?.kind === 'worker') {
      return { ok: false, error: 'Workers do not manage the fleet.' }
    }
    const fleet = fleetForCall(ctx.threadMeta.id, ctx.workspace.id, typeof args.fleet === 'string' ? args.fleet : undefined)
    if ('error' in fleet) return { ok: false, error: fleet.error }
    const target = resolveWorker(fleet.id, String(args.agent ?? ''))
    if ('error' in target) return { ok: false, error: target.error }
    if (target.threadId === ctx.threadMeta.id) return { ok: false, error: 'An orchestrator cannot remove itself.' }
    const gone = describeAgent(target)
    const reason = typeof args.reason === 'string' ? args.reason : undefined
    const removed = removeAgent(target, { actor: actorForThread(ctx.threadMeta.id), reason })
    return {
      ok: true,
      fleet: fleet.name,
      removed: gone.name,
      session: gone.session,
      ...(removed.notebook
        ? {
            its_working_memory: removed.notebook.length > 6000 ? `${removed.notebook.slice(0, 6000)}… (clipped)` : removed.notebook,
            archived_to: removed.archivedTo
          }
        : {}),
      note:
        'Its full configuration (role, model, tools) is in fleet_history if it needs to come back.' +
        (removed.notebook ? ' Carry any lessons from its working memory (above) to the agent taking over its duty.' : '')
    }
  }
}

const stopAgentTool: ToolDefinition = {
  name: 'stop_agent',
  description:
    'Stop all work currently owned by one agent in your fleet: its live model run, background ' +
    'subagents, and background jobs. Use this when work is going down the wrong path or no longer ' +
    'matters. This keeps the agent, thread, and memory intact. When the work should continue with ' +
    'corrected instructions, steer it with send_message instead.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'The agent name or id.' },
      reason: REASON_PROPERTY
    },
    required: ['agent'],
    additionalProperties: false
  },
  resource: 'external_action',
  action: 'submit',
  riskTier: 'R0',
  allowedInPlan: false,
  summarize: (args) => `Stop agent ${typeof args.agent === 'string' ? args.agent : '?'}`,
  async run(args, ctx) {
    const self = agentForThread(ctx.threadMeta.id)
    if (!self || self.kind !== 'orchestrator') {
      return { ok: false, error: 'Only a fleet orchestrator can stop one of its agents.' }
    }
    const target = resolveWorker(self.fleetId, String(args.agent ?? ''))
    if ('error' in target) return { ok: false, error: target.error }
    if (target.id === self.id) return { ok: false, error: 'An orchestrator cannot stop itself with stop_agent.' }
    const wasRunning = sessionWorkRunning(target.threadId)
    if (!stopSessionWork(target.threadId)) return { ok: false, error: 'Agent stopping is not available right now.' }
    return {
      ok: true,
      agent: target.name,
      stopped: wasRunning,
      ...(typeof args.reason === 'string' && args.reason.trim() ? { reason: args.reason.trim() } : {}),
      summary: wasRunning ? `Stopped all live work for ${target.name}.` : `${target.name} was already idle.`
    }
  }
}

const MAX_HISTORY_ROLE = 4000

/** Clip long string fields (a role) in a change-log snapshot so one entry cannot flood the context. */
function clipSnapshot(snap: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!snap) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(snap)) {
    out[k] = typeof v === 'string' && v.length > MAX_HISTORY_ROLE ? `${v.slice(0, MAX_HISTORY_ROLE)}… (clipped)` : v
  }
  return out
}

const fleetHistoryTool: ToolDefinition = {
  name: 'fleet_history',
  description:
    'Read the fleet change log: every agent added, updated or removed — who did it, why, and exactly which ' +
    'fields changed (before and after, including the full previous role). Use it in a retro to check ' +
    'whether a change you made helped, and to restore a previous role with update_agent when it did not. ' +
    'A removed agent\'s full configuration is here too, so it can be re-added.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Only entries about this agent (name or id). Omit for the whole fleet.' },
      fleet: { type: 'string', description: 'Fleet name or id (optional for an orchestrator or when there is one fleet).' },
      limit: { type: 'number', description: 'How many entries, newest first (default 20, max 100).' }
    },
    additionalProperties: false
  },
  resource: 'external_action',
  action: 'read',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: (args) => `Fleet history${typeof args.agent === 'string' ? ` for ${args.agent}` : ''}`,
  async run(args, ctx) {
    if (agentForThread(ctx.threadMeta.id)?.kind === 'worker') {
      return { ok: false, error: 'Workers do not manage the fleet; report to your orchestrator.' }
    }
    const fleet = fleetForCall(ctx.threadMeta.id, ctx.workspace.id, typeof args.fleet === 'string' ? args.fleet : undefined)
    if ('error' in fleet) return { ok: false, error: fleet.error }
    const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit) || 20)))
    const agentQuery = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined
    const resolvedAgent = agentQuery ? resolveWorker(fleet.id, agentQuery) : undefined
    const agent = resolvedAgent && !('error' in resolvedAgent) ? resolvedAgent.id : agentQuery
    const changes = listFleetChanges(fleet.id, { agent, limit })
    return {
      fleet: fleet.name,
      count: changes.length,
      changes: changes.map((c) => ({
        when: new Date(c.createdAt).toISOString(),
        action: c.action,
        agent: c.agentName,
        by: c.actor,
        ...(c.reason ? { reason: c.reason } : {}),
        ...(c.before ? { before: clipSnapshot(c.before) } : {}),
        ...(c.after ? { after: clipSnapshot(c.after) } : {})
      })),
      ...(changes.length ? {} : { note: agent ? `No recorded changes for "${agent}".` : 'No recorded changes yet.' })
    }
  }
}

const WORKING_MEMORY_ACTIONS = ['read', 'append', 'replace_section', 'remove_section', 'str_replace', 'rewrite'] as const

const workingMemoryTool: ToolDefinition = {
  name: 'working_memory',
  description:
    'Your working memory: a markdown notebook that is yours alone and is shown to you at the start of every ' +
    'run, so what you write down you never have to relearn. Keep in it your current focus, the process you ' +
    'have settled on, lessons learned from mistakes (dated, with the fix), notes on the agents you work with, ' +
    'and open threads. Actions: "append" adds text to the end of a section (created if missing) — the usual ' +
    'way to record a lesson; "replace_section" rewrites one section; "remove_section" drops one; ' +
    '"str_replace" swaps an exact snippet; "rewrite" replaces the whole document (use it to condense when it ' +
    'grows past the soft limit); "read" returns it as it is now. Different from memory_save, which stores ' +
    'single facts for search across every chat.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...WORKING_MEMORY_ACTIONS], description: 'What to do (see the tool description).' },
      section: {
        type: 'string',
        description:
          'Section heading for append/replace_section/remove_section, e.g. "Lessons learned", "Agent notes", "Standing process", "Open threads", "Current focus".'
      },
      text: { type: 'string', description: 'The markdown to append, the new section body, or (rewrite) the whole document.' },
      old: { type: 'string', description: 'str_replace: the exact text to replace (must occur once).' },
      new: { type: 'string', description: 'str_replace: the replacement text (may be empty).' },
      agent: {
        type: 'string',
        description:
          'Orchestrator only: read or edit one of YOUR agents\' working memory instead of your own (name or id) — ' +
          'to coach it with a lesson directly, without rewriting its role. Omit for your own.'
      }
    },
    required: ['action'],
    additionalProperties: false
  },
  resource: 'external_action',
  action: 'submit',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: (args) => {
    const action = typeof args.action === 'string' ? args.action : '?'
    if (action === 'read') return 'Read working memory'
    const section = typeof args.section === 'string' ? ` · ${args.section}` : ''
    return `Working memory: ${action.replace('_', ' ')}${section}`
  },
  async run(args, ctx) {
    const self = agentForThread(ctx.threadMeta.id)
    if (!self) return { ok: false, error: 'Working memory belongs to fleet agents; this thread is not one. Use memory_save instead.' }
    let owner = self
    const agentArg = typeof args.agent === 'string' ? args.agent.trim() : ''
    if (agentArg) {
      const target = resolveWorker(self.fleetId, agentArg)
      if ('error' in target) return { ok: false, error: target.error }
      if (target.id !== self.id && self.kind !== 'orchestrator') {
        return { ok: false, error: 'Only the orchestrator can read or edit another agent\'s working memory.' }
      }
      owner = target
    }
    const action = String(args.action ?? '') as (typeof WORKING_MEMORY_ACTIONS)[number]
    if (!WORKING_MEMORY_ACTIONS.includes(action)) {
      return { ok: false, error: `Unknown action "${action}". Use one of: ${WORKING_MEMORY_ACTIONS.join(', ')}.` }
    }
    const mem = readWorkingMemory(owner)
    const whose = owner.id === self.id ? {} : { agent: owner.name }
    if (action === 'read') {
      return { ...whose, path: mem.path, exists: mem.exists, chars: mem.chars, soft_limit: SOFT_LIMIT, content: mem.content }
    }
    const text = typeof args.text === 'string' ? args.text : ''
    const section = typeof args.section === 'string' ? args.section : ''
    let edit: WorkingMemoryEdit
    if (action === 'str_replace') edit = { action, old: typeof args.old === 'string' ? args.old : '', new: typeof args.new === 'string' ? args.new : '' }
    else if (action === 'rewrite') edit = { action, text }
    else if (action === 'remove_section') edit = { action, section }
    else edit = { action, section, text }
    if (action !== 'str_replace' && action !== 'rewrite' && !section.trim()) {
      return { ok: false, error: `${action} needs \`section\` (e.g. "Lessons learned").` }
    }
    const applied = applyWorkingMemoryEdit(mem.content, edit)
    if ('error' in applied) return { ok: false, error: applied.error }
    const written = writeWorkingMemory(owner, applied.content)
    if (!written.ok) return { ok: false, error: written.error }
    return {
      ok: true,
      ...whose,
      path: written.path,
      chars: written.chars,
      ...(written.chars > SOFT_LIMIT
        ? { note: `Working memory is ${written.chars} characters, past the ${SOFT_LIMIT} soft limit — condense it with action "rewrite" soon.` }
        : {}),
      summary:
        owner.id === self.id
          ? 'Saved. It is shown to you at the start of every run from now on.'
          : `Saved to ${owner.name}'s working memory; it sees it at the start of its next run.`
    }
  }
}

export const fleetTools: ToolDefinition[] = [
  listFleetTool,
  delegateTool,
  createFleetTool,
  addAgentTool,
  updateAgentTool,
  removeAgentTool,
  stopAgentTool,
  fleetHistoryTool,
  workingMemoryTool
]
