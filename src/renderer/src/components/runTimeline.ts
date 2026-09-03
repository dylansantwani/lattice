import type { ReasoningFidelity, RunEvent, RunEventBody } from '@shared/types'

/** Accumulated state of one tool call, folded from its stream of tool.* events. */
export interface ToolCall {
  tool: string
  status: string
  durationMs?: number
  ok?: boolean
  /** Raw, possibly incomplete tool arguments captured while a call is still being drafted. */
  draftArgs?: string
  /** Live output of a running command (tool.progress), replaced by each snapshot; gone once the result lands. */
  liveOutput?: string
  args?: unknown
  result?: unknown
  reason?: string
}

/** One block in a run's woven reasoning/output/tool timeline, positioned by the seq it first appeared at. */
export type TimelineItem =
  | {
      kind: 'think'
      seq: number
      text: string
      startTs: number
      endTs?: number
      fidelity?: ReasoningFidelity
      /** Authoritative thinking span (ms) from `reasoning.done`, measured live in the run loop.
       *  Preferred over `endTs − startTs`, which is unreliable because delta events are coalesced. */
      durationMs?: number
    }
  | { kind: 'output'; seq: number; text: string; startTs: number; endTs?: number }
  | { kind: 'tool'; seq: number; callId: string; call: ToolCall }
  /** A run-loop self-recovery note (a `retry` event) — e.g. a dropped tool call being re-requested. */
  | { kind: 'notice'; seq: number; ts: number; text: string }

/** A single tool row from the timeline. */
export type ToolItem = Extract<TimelineItem, { kind: 'tool' }>

/** One image a tool call's result surfaced, as a renderable data URL plus its caption if any. */
export interface FoundImage {
  url: string
  caption?: string
}

/**
 * Find image content inside a tool's result so the transcript can show it to the user, not just
 * the model. Recognizes the same shapes the main-process run loop already lifts out for model
 * vision (see `extractToolResultImages` in `runManager.ts`): an MCP `{type:'image',data,mimeType}`
 * content block, an image-bearing `{type:'resource',resource:{blob,mimeType}}`, or a raw
 * `data:image/*` string — anywhere in the result tree, so it works for the `show_image` builtin,
 * an MCP screenshot tool, or anything shaped the same way, without each needing its own case here.
 * Capped at 4 images per call so a pathological result can't flood the row.
 */
export function findResultImages(result: unknown): FoundImage[] {
  const out: FoundImage[] = []
  const MAX = 4
  const toDataUrl = (data: unknown, mime: unknown, defaultImage: boolean): string | null => {
    if (typeof data !== 'string' || data.length === 0) return null
    if (data.startsWith('data:')) return data.startsWith('data:image/') ? data : null
    const isImageMime = typeof mime === 'string' && mime.startsWith('image/')
    if (!isImageMime && !defaultImage) return null
    return `data:${isImageMime ? mime : 'image/png'};base64,${data}`
  }
  const walk = (node: unknown): void => {
    if (out.length >= MAX) return
    if (typeof node === 'string') {
      if (node.startsWith('data:image/')) out.push({ url: node })
      return
    }
    if (Array.isArray(node)) {
      for (const n of node) {
        if (out.length >= MAX) break
        walk(n)
      }
      return
    }
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (obj.type === 'image') {
      const url = toDataUrl(obj.data, obj.mimeType, true)
      if (url) {
        out.push({ url, caption: typeof obj.caption === 'string' ? obj.caption : undefined })
        return
      }
    }
    if (obj.type === 'resource' && obj.resource && typeof obj.resource === 'object') {
      const r = obj.resource as Record<string, unknown>
      const url = toDataUrl(r.blob, r.mimeType, false)
      if (url) {
        out.push({ url })
        return
      }
    }
    for (const v of Object.values(obj)) {
      if (out.length >= MAX) break
      walk(v)
    }
  }
  walk(result)
  return out
}

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
export function groupTimeline(
  items: TimelineItem[],
  // Calls that must never be folded into a group: they render as their own block (a subagent card,
  // not a tool row) so they'd be lost inside a collapsed "3 tool calls" header. Defaults to
  // delegation calls; the Inspector's agent view shares the default since subagents can't delegate.
  standalone: (item: ToolItem) => boolean = isDelegationCall
): TimelineNode[] {
  const out: TimelineNode[] = []
  let run: ToolItem[] = []
  const flush = (): void => {
    if (run.length >= 2) out.push({ kind: 'tool-group', seq: run[0]!.seq, calls: run })
    else if (run.length === 1) out.push(run[0]!)
    run = []
  }
  for (const item of items) {
    if (item.kind === 'tool' && !standalone(item)) {
      run.push(item)
    } else {
      flush()
      out.push(item)
    }
  }
  flush()
  return out
}

/** The `run_agent` builtin — a delegation, rendered as a subagent card rather than a tool row. */
export const DELEGATION_TOOL = 'run_agent'

/** Whether a tool call is a delegation to a subagent (see {@link DELEGATION_TOOL}). */
export function isDelegationCall(item: ToolItem): boolean {
  return item.call.tool === DELEGATION_TOOL
}

/**
 * Scope a run's events to a single assistant segment. A steered run is split into several assistant
 * messages that all share one runId — each stamped with its own `createdAt` at the steer boundary
 * (see splitAssistantSegment in the run loop). Handing the whole run's events to every segment makes
 * each one rebuild the *entire* timeline: every reasoning/tool row is duplicated under each bubble
 * and the woven order is shuffled around the interleaved steer messages. This returns only the
 * events in `[segmentStart, nextSegmentStart)`, where `nextSegmentStart` is the `createdAt` of the
 * next segment of the same run (or +∞ for the last). The earliest segment claims everything before
 * the next boundary (lower bound −∞) so events stamped a hair before the first assistant message —
 * `run.started`, an early reasoning delta — are never dropped. `segmentStarts` is every assistant
 * segment's `createdAt` for the run (order-independent); an unsplit run has one entry and keeps all
 * its events, so the single-segment path is unchanged.
 */
export function eventsForSegment(
  events: RunEvent[],
  segmentStarts: number[],
  segmentStart: number
): RunEvent[] {
  const sorted = [...segmentStarts].sort((a, b) => a - b)
  const idx = sorted.indexOf(segmentStart)
  const isFirst = idx <= 0
  const upper = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1]! : Infinity
  const lower = isFirst ? -Infinity : segmentStart
  return events.filter((e) => e.ts >= lower && e.ts < upper)
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

  // The item count at the last *committed* point. Everything from here on is the current attempt's
  // provisional output (streamed reasoning/text and any tool draft). A `rewound` retry — an endpoint
  // failure that restarts the round — discards exactly that tail, so a mid-stream drop never leaves a
  // broken half-reply in the transcript. A real tool lifecycle, a steer, a compaction, or any retry
  // notice commits what came before it (that content is kept and continued, never redone).
  let commitIndex = 0
  const commit = (): void => {
    commitIndex = items.length
  }

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
        // Date the segment from when the model actually started thinking (`startedAt`, stamped live),
        // falling back to the event ts for older events that predate the field.
        think = { kind: 'think', seq: ev.seq, text: '', startTs: b.startedAt ?? ev.ts, fidelity: b.fidelity }
        items.push(think)
      }
      think.text += b.text
      think.fidelity = b.fidelity
    } else if (b.type === 'reasoning.done') {
      if (think) {
        think.fidelity = b.fidelity ?? think.fidelity
        think.endTs = ev.ts
        // Prefer the run loop's measured span; timestamp subtraction is a fallback for old events.
        if (b.durationMs !== undefined) think.durationMs = b.durationMs
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
    } else if (b.type === 'retry') {
      // A run-loop self-recovery: surface it as a small inline notice so the pause and the extra
      // round are legible, not mysterious.
      closeThink(ev.ts)
      closeOutput(ev.ts)
      // `rewound` marks an endpoint-failure redo: drop the failed attempt's provisional output
      // (reasoning/text/tool drafts streamed since the last commit) so only the successful reply
      // remains. Non-rewound retries (stall/length) keep their partial and continue it.
      if (b.rewound) {
        items.length = commitIndex
        for (const [id, idx] of [...toolIndex]) if (idx >= commitIndex) toolIndex.delete(id)
        think = null
        output = null
      }
      items.push({ kind: 'notice', seq: ev.seq, ts: ev.ts, text: b.reason })
      commit()
    } else if (b.type === 'steer.injected' || b.type === 'compaction') {
      // These mark a boundary whose preceding output is committed — a later rewound retry must not
      // reach back past them. They render elsewhere, so nothing is pushed here.
      closeThink(ev.ts)
      closeOutput(ev.ts)
      commit()
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
      // A real tool lifecycle event (past a bare draft) commits the round: its output survives a
      // later rewound retry. A drafting-only row stays provisional and can still be rewound.
      if (b.type !== 'tool.drafting') commit()
    }
  }
  return items
}

/** Fold one tool.* event into the accumulating call record (shared by every tool row). */
function applyToolEvent(call: ToolCall, body: ToolEventBody): void {
  if ('tool' in body && typeof body.tool === 'string') call.tool = body.tool
  if (body.type === 'tool.drafting') {
    if (body.args !== undefined) call.draftArgs = body.args
    return
  }
  if (body.type === 'tool.progress') {
    call.liveOutput = body.output
    return
  }
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

export interface ToolDraftPreview {
  label: string
  text: string
  /** A path/target to identify what the tool is acting on. */
  target?: string
}

type DraftField = { key: string; label: string; targetKey?: string }

const DRAFT_FIELDS: Record<string, DraftField> = {
  fs_write: { key: 'content', label: 'Writing', targetKey: 'path' },
  fs_edit: { key: 'new_string', label: 'Editing', targetKey: 'path' },
  shell: { key: 'command', label: 'Running' },
  start_job: { key: 'command', label: 'Starting job' },
  fs_read: { key: 'path', label: 'Reading' },
  fs_list: { key: 'path', label: 'Listing' },
  fs_mkdir: { key: 'path', label: 'Creating directory' },
  fs_delete: { key: 'path', label: 'Deleting' },
  fs_move: { key: 'from', label: 'Moving', targetKey: 'to' },
  grep_search: { key: 'pattern', label: 'Searching' },
  web_search: { key: 'query', label: 'Searching' },
  web_fetch: { key: 'url', label: 'Fetching' }
}

interface PartialJsonString {
  value: string
  complete: boolean
}

/**
 * Read a string property from a JSON object while its value is still streaming. A normal
 * JSON.parse is used when possible; the scanner is deliberately small and forgiving for the
 * incomplete string/escape at the end of a tool-call delta.
 */
function partialJsonString(source: string, key: string): PartialJsonString | null {
  try {
    const parsed: unknown = JSON.parse(source)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>)[key]
      if (typeof value === 'string') return { value, complete: true }
    }
  } catch {
    // The arguments are expected to be incomplete while drafting; scan the string below.
  }

  const marker = `"${key}"`
  let cursor = 0
  while (cursor < source.length) {
    const markerAt = source.indexOf(marker, cursor)
    if (markerAt < 0) return null
    const afterMarker = source.slice(markerAt + marker.length)
    const prefix = afterMarker.match(/^\s*:\s*"/)
    if (!prefix) {
      cursor = markerAt + marker.length
      continue
    }

    let value = ''
    let escaped = false
    const valueStart = markerAt + marker.length + prefix[0].length
    for (let i = valueStart; i < source.length; i++) {
      const ch = source[i]!
      if (escaped) {
        switch (ch) {
          case '"':
            value += '"'
            break
          case '\\':
            value += '\\'
            break
          case '/':
            value += '/'
            break
          case 'b':
            value += '\b'
            break
          case 'f':
            value += '\f'
            break
          case 'n':
            value += '\n'
            break
          case 'r':
            value += '\r'
            break
          case 't':
            value += '\t'
            break
          case 'u': {
            const hex = source.slice(i + 1, i + 5)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value, complete: false }
            value += String.fromCharCode(parseInt(hex, 16))
            i += 4
            break
          }
          default:
            // Keep malformed-but-visible data readable rather than dropping the character.
            value += ch
            break
        }
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        return { value, complete: true }
      } else {
        value += ch
      }
    }
    return { value, complete: false }
  }
  return null
}

/**
 * Read one string field out of a tool call's still-streaming argument JSON — e.g. the `name` or
 * `task` of a `run_agent` call while the model is still drafting it. Returns the prefix read so
 * far (possibly incomplete), or undefined when the field hasn't appeared yet.
 */
export function draftStringField(draftArgs: string | undefined, key: string): string | undefined {
  if (!draftArgs) return undefined
  return partialJsonString(draftArgs, key)?.value
}

/**
 * A short human label for what a completed-or-running tool call is doing — "Reading src/app.ts",
 * "Running npm test", "Searching foo" — for compact activity lines (a subagent card's live status,
 * its recent-tools trail). Tools without a known primary argument fall back to their bare name.
 */
export function toolActivityLabel(tool: string, args: unknown): string {
  const bare = tool.replace(/^mcp__(.+?)__/, '')
  const field = DRAFT_FIELDS[tool]
  if (!field) return bare
  const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined
  // A command's own `purpose` label beats its raw text ("Running Benchmark the 3 hosts").
  const purpose = a && typeof a.purpose === 'string' ? a.purpose.replace(/\s+/g, ' ').trim() : ''
  if (purpose) return `${field.label} ${purpose.length > 72 ? purpose.slice(0, 71) + '…' : purpose}`
  const primary = a && typeof a[field.key] === 'string' ? (a[field.key] as string) : ''
  const target = field.targetKey && a && typeof a[field.targetKey] === 'string' ? (a[field.targetKey] as string) : ''
  const detail = (target || primary).replace(/\s+/g, ' ').trim()
  if (!detail) return field.label
  const clipped = detail.length > 72 ? detail.slice(0, 71) + '…' : detail
  return `${field.label} ${clipped}`
}

/** Return the meaningful part of a still-streaming tool call for the live transcript. */
export function draftPreviewFor(call: ToolCall): ToolDraftPreview | null {
  if (!call.draftArgs) return null
  const field = DRAFT_FIELDS[call.tool]
  if (!field) return null
  const value = partialJsonString(call.draftArgs, field.key)
  if (!value) return null
  const target = field.targetKey ? partialJsonString(call.draftArgs, field.targetKey)?.value : undefined
  return { label: field.label, text: value.value, target }
}
