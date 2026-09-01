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

/** One block in a run's woven reasoning/output/tool timeline, positioned by the seq it first appeared at. */
export type TimelineItem =
  | { kind: 'think'; seq: number; text: string; startTs: number; endTs?: number; fidelity?: ReasoningFidelity }
  | { kind: 'output'; seq: number; text: string; startTs: number; endTs?: number }
  | { kind: 'tool'; seq: number; callId: string; call: ToolCall }

/** A single tool row from the timeline. */
export type ToolItem = Extract<TimelineItem, { kind: 'tool' }>

/**
 * A run of 2+ back-to-back tool calls, collapsed into one expandable block. Positioned by the seq
 * of its first call so it keeps its place in the woven timeline.
 */
export interface ToolGroup {
  kind: 'tool-group'
  seq: number
  calls: ToolItem[]
}

/** A grouped timeline node: any timeline item, or a collapsed run of consecutive tool calls. */
export type TimelineNode = Exclude<TimelineItem, ToolItem> | ToolItem | ToolGroup

/**
 * Collapse maximal runs of consecutive tool calls into `tool-group` nodes so a burst of back-to-back
 * calls renders as a single expandable block instead of a wall of rows. A lone tool call (one not
 * adjacent to another) is left as a plain `tool` item; thinking and output items always break a run.
 */
export function groupTimeline(items: TimelineItem[]): TimelineNode[] {
  const out: TimelineNode[] = []
  let run: ToolItem[] = []
  const flush = (): void => {
    if (run.length >= 2) out.push({ kind: 'tool-group', seq: run[0]!.seq, calls: run })
    else if (run.length === 1) out.push(run[0]!)
    run = []
  }
  for (const item of items) {
    if (item.kind === 'tool') {
      run.push(item)
    } else {
      flush()
      out.push(item)
    }
  }
  flush()
  return out
}

type ToolEventBody = Extract<RunEventBody, { type: `tool.${string}` }>

const isToolEvent = (b: RunEventBody): b is ToolEventBody => b.type.startsWith('tool.')

/**
 * Weave a run's events into one chronological timeline. Consecutive `reasoning.delta`s form a
 * thinking segment and consecutive `text.delta`s form an output segment; each is closed the moment
 * a *different* kind of activity begins — thinking ends when the model starts speaking or calls a
 * tool, an output block ends when the model goes back to thinking or calls a tool. Tool events are
 * grouped by callId (a row keeps the position it first appeared at). The result reads think →
 * output → tools → think → output exactly as it happened, so a model that alternates thinking,
 * speaking, and tool calls renders each output block in its true place instead of collapsing every
 * spoken passage into one block at the end.
 */
export function buildTimeline(events: RunEvent[]): TimelineItem[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const items: TimelineItem[] = []
  const toolIndex = new Map<string, number>()
  let think: Extract<TimelineItem, { kind: 'think' }> | null = null
  let output: Extract<TimelineItem, { kind: 'output' }> | null = null

  const closeThink = (ts: number): void => {
    if (think) {
      if (think.endTs === undefined) think.endTs = ts
      think = null
    }
  }
  const closeOutput = (ts: number): void => {
    if (output) {
      if (output.endTs === undefined) output.endTs = ts
      output = null
    }
  }

  for (const ev of sorted) {
    const b = ev.body
    if (b.type === 'reasoning.delta') {
      closeOutput(ev.ts)
      if (!think) {
        think = { kind: 'think', seq: ev.seq, text: '', startTs: ev.ts, fidelity: b.fidelity }
        items.push(think)
      }
      think.text += b.text
      think.fidelity = b.fidelity
    } else if (b.type === 'reasoning.done') {
      if (think) {
        think.fidelity = b.fidelity ?? think.fidelity
        think.endTs = ev.ts
        think = null
      }
    } else if (b.type === 'text.delta') {
      // The model started speaking — that bout of thinking is over.
      closeThink(ev.ts)
      if (!output) {
        output = { kind: 'output', seq: ev.seq, text: '', startTs: ev.ts }
        items.push(output)
      }
      output.text += b.text
    } else if (isToolEvent(b)) {
      // Tool activity means the current thinking/output block has ended; stamp its close time.
      closeThink(ev.ts)
      closeOutput(ev.ts)
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
