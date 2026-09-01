import type { ReasoningFidelity, RunEvent, RunEventBody } from '@shared/types'

/** Accumulated state of one tool call, folded from its stream of tool.* events. */
export interface ToolCall {
  tool: string
  status: string
  durationMs?: number
  ok?: boolean
  args?: unknown
  result?: unknown
  reason?: string
}

/** One block in a run's woven reasoning/tool timeline, positioned by the seq it first appeared at. */
export type TimelineItem =
  | { kind: 'think'; seq: number; text: string; startTs: number; endTs?: number; fidelity?: ReasoningFidelity }
  | { kind: 'tool'; seq: number; callId: string; call: ToolCall }

type ToolEventBody = Extract<RunEventBody, { type: `tool.${string}` }>

const isToolEvent = (b: RunEventBody): b is ToolEventBody => b.type.startsWith('tool.')

/**
 * Weave a run's events into one chronological timeline. Consecutive `reasoning.delta`s form a
 * thinking segment that is closed by its `reasoning.done` — or by the first tool activity that
 * follows, since a tool call means that bout of thinking is over. Tool events are grouped by
 * callId (a row keeps the position it first appeared at) so the sequence reads think → tools →
 * think → tools, exactly as it happened rather than in fixed slots.
 */
export function buildTimeline(events: RunEvent[]): TimelineItem[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const items: TimelineItem[] = []
  const toolIndex = new Map<string, number>()
  let cur: Extract<TimelineItem, { kind: 'think' }> | null = null

  for (const ev of sorted) {
    const b = ev.body
    if (b.type === 'reasoning.delta') {
      if (!cur) {
        cur = { kind: 'think', seq: ev.seq, text: '', startTs: ev.ts, fidelity: b.fidelity }
        items.push(cur)
      }
      cur.text += b.text
      cur.fidelity = b.fidelity
    } else if (b.type === 'reasoning.done') {
      if (cur) {
        cur.fidelity = b.fidelity ?? cur.fidelity
        cur.endTs = ev.ts
        cur = null
      }
    } else if (isToolEvent(b)) {
      // Tool activity means the current bout of thinking has ended; stamp its close time.
      if (cur) {
        if (cur.endTs === undefined) cur.endTs = ev.ts
        cur = null
      }
      const callId = b.callId
      let idx = toolIndex.get(callId)
      if (idx === undefined) {
        idx = items.length
        toolIndex.set(callId, idx)
        items.push({ kind: 'tool', seq: ev.seq, callId, call: { tool: 'tool', status: 'requested' } })
      }
      applyToolEvent((items[idx] as Extract<TimelineItem, { kind: 'tool' }>).call, b)
    }
  }
  return items
}

/** Fold one tool.* event into the accumulating call record (shared by every tool row). */
function applyToolEvent(call: ToolCall, body: ToolEventBody): void {
  if ('tool' in body && typeof body.tool === 'string') call.tool = body.tool
  if ('args' in body && body.args !== undefined) call.args = body.args
  if (body.type === 'tool.started') call.status = 'running'
  else if (body.type === 'tool.denied') {
    call.status = 'blocked'
    call.reason = body.reason
  } else if (body.type === 'tool.result') {
    call.status = body.ok ? 'complete' : 'failed'
    call.durationMs = body.durationMs
    call.ok = body.ok
    call.result = body.result
  }
}
