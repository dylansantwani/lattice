import type { ToolDefinition } from './types'
import { agentForThread, listAgents } from '../store/agents'
import { getThreadMeta } from '../store/eventStore'
import { unreadCount } from '../runtime/sessionMessaging'
import { delegateToAgent } from '../runtime/fleet'

/**
 * The orchestrator's fleet tools. They are only offered to an orchestrator agent's thread (gated in
 * `availableTools` via `gateFleetTools`), so their `run` can assume the caller is an orchestrator and
 * fail cleanly if the mapping ever disappears. Delegation/steering/queueing all ride the existing
 * inter-session messaging path — see runtime/fleet.ts.
 */

const listFleetTool: ToolDefinition = {
  name: 'list_fleet',
  description:
    'List the dedicated agents in your fleet that you can delegate to. Each one has a name, its role, ' +
    'its model, whether it is busy right now, and how many tasks are queued for it. Use an agent name ' +
    'as the `agent` argument to delegate_to_agent. Your agents are persistent: they keep their own ' +
    'working directory, tools and memory between tasks, so you never need to re-brief them.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  resource: 'external_action',
  action: 'read',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: () => 'List fleet agents',
  async run(_args, ctx) {
    const orchestrator = agentForThread(ctx.threadMeta.id)
    if (!orchestrator) return { ok: false, error: 'Only an orchestrator agent has a fleet.' }
    const agents = listAgents(orchestrator.fleetId).filter((a) => a.threadId !== ctx.threadMeta.id)
    return {
      count: agents.length,
      agents: agents.map((a) => {
        const thread = getThreadMeta(a.threadId)
        const queued = unreadCount(a.threadId)
        return {
          name: a.name,
          kind: a.kind,
          ...(a.role ? { role: a.role } : {}),
          ...(thread?.model ? { model: thread.model } : {}),
          ...(thread?.cwd ? { cwd: thread.cwd } : {}),
          ...(queued ? { queued } : {})
        }
      })
    }
  }
}

const delegateTool: ToolDefinition = {
  name: 'delegate_to_agent',
  description:
    'Hand a task to one of your dedicated agents (see list_fleet). The agent carries it out in its own ' +
    'thread, with its own tools, working directory and memory. If it is idle it starts immediately; if ' +
    'it is busy, your task is folded into what it is doing (to steer it) or queued behind its current ' +
    'work. Because it keeps its context between tasks you need not repeat what it already knows. It ' +
    'reports back to you when done — use peek_session to check on it without interrupting, or call this ' +
    'again to steer it or add a follow-up.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'The agent name or id (from list_fleet).' },
      task: {
        type: 'string',
        description: 'What you want the agent to do. Be specific; it has its own memory of past work.'
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
    return { ok: true, delivery: result.delivery, agent: result.agent, summary: `Task ${where}.` }
  }
}

export const fleetTools: ToolDefinition[] = [listFleetTool, delegateTool]
