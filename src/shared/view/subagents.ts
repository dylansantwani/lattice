import type { RunEvent, TurnTelemetry } from '../types'
import { toolActivityLabel, type ToolCall } from './runTimeline'

/**
 * What a subagent is doing right now, folded from its most recent events. Drives the live status
 * line on the transcript's subagent card ("Reading src/app.ts", "Thinking…", "Writing its report").
 */
export type SubagentActivity =
  | { kind: 'starting'; since: number }
  | { kind: 'thinking'; since: number }
  | { kind: 'tool'; tool: string; label: string; since: number }
  | { kind: 'writing'; since: number }

/** One entry in a subagent's recent-tools trail. */
export interface SubagentToolTrace {
  callId: string
  tool: string
  label: string
  status: 'requested' | 'running' | 'complete' | 'failed' | 'blocked'
  durationMs?: number
}

/**
 * Everything the transcript needs to know about one subagent, folded from its `agent`-tagged
 * events. Built by {@link indexSubagents}; the card reads it, never the raw events.
 */
export interface SubagentView {
  id: string
  name?: string
  role?: string
  model?: string
  effort?: string
  /** the tool names the agent was granted (from `run.started`) */
  tools?: string[]
  /** the `run_agent` callId that spawned this agent, when the event carries it */
  parentCallId?: string
  running: boolean
  startedAt?: number
  endedAt?: number
  completedReason?: 'done' | 'canceled' | 'error' | 'length'
  error?: string
  /** tool calls proposed so far */
  toolCalls: number
  toolsDone: number
  toolsFailed: number
  /** distinct tool names actually called, in first-use order */
  toolsUsed: string[]
  /** the most recent tool calls, oldest first (capped at {@link RECENT_TOOLS}) */
  recentTools: SubagentToolTrace[]
  activity: SubagentActivity
  /** characters of spoken output so far */
  outputChars: number
  /** bouts of reasoning so far */
  thinkingBouts: number
  telemetry?: TurnTelemetry
  events: RunEvent[]
}

export const RECENT_TOOLS = 6

export interface SubagentIndex {
  /** every subagent seen, keyed by agent id, in first-appearance order */
  byId: Map<string, SubagentView>
  /** subagents whose `run.started` named the parent call that spawned them */
  byCallId: Map<string, SubagentView>
}

const EMPTY_INDEX: SubagentIndex = { byId: new Map(), byCallId: new Map() }

/**
 * Fold a thread's events into one {@link SubagentView} per subagent. Only `agent`-tagged events
 * are considered; everything else belongs to the parent run. Events are folded in array order,
 * which is seq order for a run's stream (and how the store returns them on reload).
 */
export function indexSubagents(events: RunEvent[]): SubagentIndex {
  if (events.length === 0) return EMPTY_INDEX
  const byId = new Map<string, SubagentView>()
  const byCallId = new Map<string, SubagentView>()
  // Per-agent open-call bookkeeping so a parallel batch keeps the right "current tool" label.
  const openCalls = new Map<string, Map<string, SubagentToolTrace>>()

  for (const ev of events) {
    if (!ev.agent) continue
    let a = byId.get(ev.agent)
    if (!a) {
      a = {
        id: ev.agent,
        running: true,
        toolCalls: 0,
        toolsDone: 0,
        toolsFailed: 0,
        toolsUsed: [],
        recentTools: [],
        activity: { kind: 'starting', since: ev.ts },
        outputChars: 0,
        thinkingBouts: 0,
        events: []
      }
      byId.set(ev.agent, a)
      openCalls.set(ev.agent, new Map())
    }
    a.events.push(ev)
    const open = openCalls.get(ev.agent)!
    const b = ev.body
    switch (b.type) {
      case 'run.started':
        a.model = b.model
        a.effort = b.effort
        a.role = b.agentType
        a.tools = b.tools
        a.startedAt = ev.ts
        if (b.name) a.name = b.name
        if (b.parentCallId) {
          a.parentCallId = b.parentCallId
          byCallId.set(b.parentCallId, a)
        }
        a.activity = { kind: 'starting', since: ev.ts }
        break
      case 'reasoning.delta':
        if (a.activity.kind !== 'thinking') {
          a.thinkingBouts += 1
          a.activity = { kind: 'thinking', since: b.startedAt ?? ev.ts }
        }
        break
      case 'text.delta':
        a.outputChars += b.text.length
        if (a.activity.kind !== 'writing') a.activity = { kind: 'writing', since: ev.ts }
        break
      case 'tool.drafting':
      case 'tool.proposed':
      case 'tool.started': {
        let trace = open.get(b.callId)
        const tool = b.tool ?? trace?.tool ?? 'tool'
        const args = 'args' in b && b.type !== 'tool.drafting' ? b.args : undefined
        const label = args !== undefined || !trace ? toolActivityLabel(tool, args) : trace.label
        if (!trace) {
          trace = { callId: b.callId, tool, label, status: 'requested' }
          open.set(b.callId, trace)
          a.toolCalls += 1
          a.recentTools.push(trace)
          if (a.recentTools.length > RECENT_TOOLS) a.recentTools.shift()
        } else {
          trace.tool = tool
          trace.label = label
        }
        if (b.type === 'tool.started') {
          trace.status = 'running'
          if (!a.toolsUsed.includes(tool)) a.toolsUsed.push(tool)
        }
        // The newest proposed/started call is what the agent is "doing" now.
        a.activity = { kind: 'tool', tool, label, since: ev.ts }
        break
      }
      case 'tool.denied': {
        const trace = open.get(b.callId)
        if (trace) {
          trace.status = 'blocked'
          open.delete(b.callId)
        }
        a.toolsFailed += 1
        settleActivity(a, open, ev.ts)
        break
      }
      case 'tool.result': {
        const trace = open.get(b.callId)
        if (trace) {
          trace.status = b.ok ? 'complete' : 'failed'
          trace.durationMs = b.durationMs
          open.delete(b.callId)
        }
        if (b.ok) a.toolsDone += 1
        else a.toolsFailed += 1
        settleActivity(a, open, ev.ts)
        break
      }
      case 'usage':
        a.telemetry = b.usage
        break
      case 'error':
        a.error = b.message
        break
      case 'run.completed':
        a.running = false
        a.endedAt = ev.ts
        a.completedReason = b.reason
        break
      default:
        break
    }
  }
  return { byId, byCallId }
}

/**
 * After a tool call settles: if another call from the same batch is still in flight, that one is
 * the current activity; otherwise the agent is back to deciding its next move.
 */
function settleActivity(a: SubagentView, open: Map<string, SubagentToolTrace>, ts: number): void {
  let inflight: SubagentToolTrace | undefined
  for (const t of open.values()) if (t.status === 'running' || t.status === 'requested') inflight = t
  a.activity = inflight
    ? { kind: 'tool', tool: inflight.tool, label: inflight.label, since: ts }
    : { kind: 'thinking', since: ts }
}

/** The `agentId` a finished `run_agent` call returned (foreground result or background handle). */
export function agentIdFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const id = (result as Record<string, unknown>).agentId
  return typeof id === 'string' && id ? id : undefined
}

/** Whether a `run_agent` result is a background-spawn handle rather than a finished answer. */
export function isBackgroundHandle(result: unknown): boolean {
  return !!result && typeof result === 'object' && (result as Record<string, unknown>).background === true
}

/** The subagent's final answer from a foreground `run_agent` result, if it has one. */
export function resultTextOf(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const text = (result as Record<string, unknown>).result
  return typeof text === 'string' ? text : undefined
}

/** The failure message from a failed `run_agent` call's result, if any. */
export function resultErrorOf(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const err = (result as Record<string, unknown>).error
  return typeof err === 'string' && err ? err : undefined
}

/**
 * Find the subagent a `run_agent` call spawned. Live calls resolve through the `parentCallId` the
 * agent's `run.started` carries (so the card animates while the call is still running); calls
 * persisted before that field existed fall back to the `agentId` in the finished result.
 */
export function subagentForCall(index: SubagentIndex, callId: string, call: ToolCall): SubagentView | undefined {
  const live = index.byCallId.get(callId)
  if (live) return live
  const id = agentIdFromResult(call.result)
  return id ? index.byId.get(id) : undefined
}

/** How the subagent card should present itself, folded from the call and the agent's own events. */
export type SubagentPhase =
  /** the parent is still drafting the call (args streaming) or the spawn hasn't started */
  | 'starting'
  | 'running'
  /** finished with an answer */
  | 'done'
  /** the tool failed, the agent errored, or the call was blocked */
  | 'failed'
  /** stopped by the user (per-agent stop or run cancel) */
  | 'stopped'
  /** the call never resolved and the parent run is no longer live (e.g. the app quit mid-call) */
  | 'interrupted'

export function subagentPhase(call: ToolCall, view: SubagentView | undefined, live: boolean): SubagentPhase {
  if (call.status === 'blocked' || call.ok === false) return 'failed'
  if (view) {
    if (view.running) {
      // A background agent outlives the spawning turn, so `live` (the parent turn's liveness) says
      // nothing about it; a foreground agent can't outlive its parent — still "running" once the
      // parent has settled means the run was cut off.
      return live || isBackgroundHandle(call.result) ? 'running' : 'interrupted'
    }
    if (view.error || view.completedReason === 'error') return 'failed'
    if (view.completedReason === 'canceled') return 'stopped'
    return 'done'
  }
  if (call.status === 'requested') return live ? 'starting' : 'interrupted'
  if (call.status === 'running') return live ? 'running' : 'interrupted'
  return 'done'
}

/** "Title Case" for a free-form role label used as a fallback name. */
export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
