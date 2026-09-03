import type { RunEventBody } from '../../shared/types'

/**
 * A live, in-memory snapshot of what a background subagent is doing right now, folded from the
 * run events it emits. Kept on the {@link BgAgent} so the orchestrator can `peek_agents` at it
 * without blocking, reading the event store, or consuming the agent's result. Purely observational
 * — it never affects the agent's lifecycle or delivery.
 */
export type AgentPhase = 'starting' | 'thinking' | 'responding' | 'tool' | 'done' | 'error'

export interface AgentProgress {
  /** wall-clock (ms) when the sub-run began — set on run.started, so elapsed reflects real work */
  startedAt: number
  /** wall-clock (ms) of the last event folded in — drives "how long since it last did anything" */
  updatedAt: number
  /** tool calls that have COMPLETED so far (a tool.result each) */
  toolCalls: number
  /** the tool it is executing right this moment, if any */
  currentTool?: string
  phase: AgentPhase
  /** rolling tail of the latest assistant text the subagent has produced */
  preview: string
}

/** How many trailing characters of the subagent's text we keep for the peek preview. */
export const PREVIEW_MAX = 240

export function initialProgress(now = Date.now()): AgentProgress {
  return { startedAt: now, updatedAt: now, toolCalls: 0, phase: 'starting', preview: '' }
}

/**
 * Fold one run event into a progress snapshot. Pure: returns the next state, never mutates `prev`.
 * Only the events that change what the agent is visibly doing move the phase; everything else just
 * refreshes `updatedAt` so idle time stays honest.
 */
export function applyEvent(prev: AgentProgress, body: RunEventBody, now = Date.now()): AgentProgress {
  const next: AgentProgress = { ...prev, updatedAt: now }
  switch (body.type) {
    case 'run.started':
      next.phase = 'starting'
      next.startedAt = now
      break
    case 'reasoning.delta':
      next.phase = 'thinking'
      break
    case 'text.delta':
      next.phase = 'responding'
      next.preview = (next.preview + body.text).slice(-PREVIEW_MAX)
      break
    case 'tool.drafting':
      // The model has started composing a call but not submitted it yet — already "on a tool".
      next.phase = 'tool'
      if (body.tool) next.currentTool = body.tool
      break
    case 'tool.started':
      next.phase = 'tool'
      next.currentTool = body.tool
      break
    case 'tool.result':
      next.toolCalls += 1
      next.currentTool = undefined
      // After a result the model reasons over it before the next move — surface that as thinking.
      next.phase = 'thinking'
      break
    case 'run.completed':
      next.phase = body.reason === 'error' ? 'error' : 'done'
      next.currentTool = undefined
      break
    case 'error':
      next.phase = 'error'
      break
    default:
      break
  }
  return next
}

/** A short, human-readable line describing what the agent is doing now, for the peek result. */
export function describeActivity(p: AgentProgress, status: 'running' | 'done' | 'error'): string {
  if (status === 'done') return 'finished'
  if (status === 'error' || p.phase === 'error') return 'failed'
  switch (p.phase) {
    case 'tool':
      return p.currentTool ? `running ${p.currentTool}` : 'running a tool'
    case 'thinking':
      return 'thinking'
    case 'responding':
      return 'writing its response'
    case 'starting':
    default:
      return 'starting up'
  }
}
