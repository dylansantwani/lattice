import type { AgentProfile } from '@shared/types'
import type { ToolDefinition } from '../tools/types'
import { agentAllowlist, agentForThread, isOrchestratorThread, listAgents } from '../store/agents'
import { sendSessionMessage } from './sessionMessaging'

/**
 * Fleet runtime: the orchestrator-facing verbs (resolve a worker, delegate a task) and the tool
 * gating `availableTools` applies. Deliberately a near-leaf module — it imports the store and the
 * (leaf) session-messaging broker, never the run manager or the tool registry — so the dependency
 * graph stays acyclic: runManager → fleet, builtin → fleetTools → fleet.
 *
 * Delegation is not a new transport: it reuses inter-session messaging, which already wakes an idle
 * agent (delegate), injects into a running one (steer), or queues behind its current work (queue).
 */

/** The tools only an orchestrator agent is offered. Kept here (not in fleetTools) to avoid a cycle. */
export const FLEET_TOOL_NAMES = new Set(['delegate_to_agent', 'list_fleet'])

/**
 * Tools a narrowed worker always keeps regardless of its allowlist: it must be able to report its
 * result back to the orchestrator (`send_message`), pick up queued follow-ups (`check_inbox`), recall
 * its own memory (`memory_search`), and fold multiple reads into one round-trip (`batch`).
 */
const WORKER_ALWAYS_KEEP = new Set(['send_message', 'check_inbox', 'memory_search', 'batch'])

/**
 * Narrow a thread's tool set for fleet membership: strip the orchestrator-only tools from anything
 * that is not an orchestrator, and — for a worker with an explicit allowlist — keep only the allowed
 * builtins (plus the always-keep set and any MCP tools it has loaded). A thread that is not an agent
 * at all is returned unchanged.
 */
export function gateFleetTools(tools: ToolDefinition[], threadId: string): ToolDefinition[] {
  let out = isOrchestratorThread(threadId)
    ? tools
    : tools.filter((tool) => !FLEET_TOOL_NAMES.has(tool.name))
  const allow = agentAllowlist(threadId)
  if (allow) {
    const keep = new Set([...allow, ...WORKER_ALWAYS_KEEP])
    out = out.filter((tool) => keep.has(tool.name) || tool.mcpServerId !== undefined)
  }
  return out
}

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
