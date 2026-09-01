import type { RunEvent, SubagentStatus } from '@shared/types'
import { buildTimeline, type TimelineItem } from './runTimeline'

/** Everything the Agents tab needs to render one subagent, folded from its tagged events. */
export interface AgentSummary {
  id: string
  name: string
  model?: string
  status: SubagentStatus
  /** starting / running / idle — still live and worth showing prominently */
  active: boolean
  toolCalls: number
  /** accumulated assistant output */
  text: string
  lastLine?: string
  /** messages the parent sent this subagent (via message_agent) */
  messages: string[]
  events: RunEvent[]
  timeline: TimelineItem[]
}

const ACTIVE = new Set<SubagentStatus>(['starting', 'running', 'idle'])

/**
 * Group a thread's run events by subagent id (events tagged with `agent`) and fold each group into
 * a summary. Mirrors how the main transcript reads a run — status, model, woven think/tool
 * timeline, and output text — so a subagent can be viewed exactly the way the main model is.
 */
export function summarizeAgents(events: RunEvent[]): AgentSummary[] {
  const order: string[] = []
  const byId = new Map<string, RunEvent[]>()
  for (const ev of events) {
    if (!ev.agent) continue
    let arr = byId.get(ev.agent)
    if (!arr) {
      arr = []
      byId.set(ev.agent, arr)
      order.push(ev.agent)
    }
    arr.push(ev)
  }

  const summaries = order.map((id, index) => {
    const evs = byId.get(id)!
    let name = id.slice(0, 8)
    let model: string | undefined
    let status: SubagentStatus = 'running'
    let sawStatus = false
    let completed = false
    let toolCalls = 0
    let text = ''
    const messages: string[] = []
    for (const ev of evs) {
      const b = ev.body
      if (b.type === 'run.started') {
        model = b.model
        if (b.agentName) name = b.agentName
      } else if (b.type === 'agent.status') {
        status = b.status
        sawStatus = true
        if (b.name) name = b.name
      } else if (b.type === 'text.delta') {
        text += b.text
      } else if (b.type === 'agent.message') {
        messages.push(b.text)
      } else if (b.type === 'tool.started') {
        toolCalls += 1
      } else if (b.type === 'run.completed') {
        completed = true
      }
    }
    // Fallback for streams without agent.status events (e.g. older runs): a completed run is done.
    if (!sawStatus && completed) status = 'done'
    const lastLine = text.trim().split('\n').filter(Boolean).pop()?.slice(-140)
    return {
      id,
      name,
      model,
      status,
      active: ACTIVE.has(status),
      toolCalls,
      text,
      lastLine,
      messages,
      events: evs,
      timeline: buildTimeline(evs),
      _index: index
    }
  })

  // Active subagents first, then in spawn order.
  return summaries
    .sort((a, b) => (a.active === b.active ? a._index - b._index : a.active ? -1 : 1))
    .map(({ _index, ...rest }) => {
      void _index
      return rest
    })
}
