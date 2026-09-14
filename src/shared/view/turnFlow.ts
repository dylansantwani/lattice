/**
 * The transcript's view of an assistant turn: a flow of prose passages, activity blocks, and
 * subagent cards. Everything here is pure so the shape of a turn — what gets one line, what gets
 * folded, how a block is summarised — is unit-tested without React.
 *
 * Reading model (see docs/design/transcript.md):
 *   - Prose is the turn. It reads as plain text in the column; no box.
 *   - A stretch of reasoning + tool calls between two passages is ONE activity block, summarised
 *     in one sentence while settled ("Ran 4 commands, edited 2 files, thought 21s · 1m 04s") and
 *     expanded into a step list while live or when the reader opens it.
 *   - A step is one line: what was done (verb + subject) and how it went. Details live one click
 *     further down.
 */
import type { TurnTelemetry } from '../types'
import { toolActivityLabel, draftPreviewFor, isDelegationCall, type TimelineItem, type ToolCall, type ToolItem } from './runTimeline'
import { fmtTokens, formatElapsed } from './format'

export type ThinkItem = Extract<TimelineItem, { kind: 'think' }>
export type OutputItem = Extract<TimelineItem, { kind: 'output' }>
export type NoticeItem = Extract<TimelineItem, { kind: 'notice' }>
/** Anything that lives inside an activity block. */
export type ActivityItem = ThinkItem | ToolItem | NoticeItem

export type FlowNode =
  | { kind: 'activity'; items: ActivityItem[] }
  | { kind: 'prose'; item: OutputItem }
  | { kind: 'agent'; item: ToolItem }

/**
 * Split a woven timeline into the turn's flow: maximal stretches of reasoning/tool/notice items
 * become one activity block each; a spoken passage and a delegation stand on their own and break
 * the stretch. Silent reasoning blips (see {@link isThoughtBlip}) are dropped — they carry nothing
 * a reader can use and would otherwise put an empty "Thought" line in front of every call on
 * models that report thinking only as a token count.
 */
export function flowOf(items: TimelineItem[]): FlowNode[] {
  const out: FlowNode[] = []
  let run: ActivityItem[] = []
  const flush = (): void => {
    if (run.length > 0) out.push({ kind: 'activity', items: run })
    run = []
  }
  for (const item of items) {
    if (item.kind === 'output') {
      flush()
      out.push({ kind: 'prose', item })
    } else if (item.kind === 'tool' && isDelegationCall(item)) {
      flush()
      out.push({ kind: 'agent', item })
    } else if (item.kind === 'think') {
      if (!isThoughtBlip(item)) run.push(item)
    } else {
      run.push(item)
    }
  }
  flush()
  return out
}

/** Measured span of a bout of reasoning, preferring the run loop's own number. */
export function thoughtMs(t: ThinkItem): number | undefined {
  if (t.durationMs !== undefined) return t.durationMs
  if (t.endTs !== undefined) return Math.max(0, t.endTs - t.startTs)
  return undefined
}

/**
 * A reasoning bout with nothing to show: no text, no token count, and under a second long. A model
 * that streams its thinking never produces one; a hosted reasoner that reports thinking as a count
 * produces one per round, and a row for each would be pure noise.
 */
export function isThoughtBlip(t: ThinkItem): boolean {
  if (t.text.length > 0) return false
  if (t.tokenCount) return false
  if (t.endTs === undefined && t.durationMs === undefined) return false // still open — it may grow
  return (thoughtMs(t) ?? 0) < 1000
}

/** "deepseek/deepseek-v4-flash" → "deepseek-v4-flash"; the full id belongs in a title attribute. */
export function shortModel(id: string | undefined): string {
  if (!id) return ''
  const bare = id.replace(/^mcp__(.+?)__/, '')
  const parts = bare.split('/')
  return parts[parts.length - 1] || bare
}

/** Split "mcp__server__tool" into a server tag and bare tool name; leave builtins as-is. */
export function prettyTool(name: string): { label: string; server?: string } {
  const m = name.match(/^mcp__(.+?)__(.+)$/)
  if (m) return { label: m[2]!, server: m[1] }
  return { label: name }
}

/** "fs_read" → "Fs read", "abrowser_session_close" → "Abrowser session close". */
function humanize(tool: string): string {
  const s = tool.replace(/[_-]+/g, ' ').trim()
  return s ? s[0]!.toUpperCase() + s.slice(1) : tool
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const oneLine = (s: string, max = 96): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

export interface StepLabel {
  /** What was done — "Ran", "Read", or the model's own purpose for a command. */
  verb: string
  /** The thing it was done to — a command, a path, a query. Empty when the verb says it all. */
  subject: string
  /** Whether the subject is code-like (command, path, pattern) and should render monospace. */
  mono: boolean
  /** The MCP server a tool belongs to, for a quiet tag after the name. */
  server?: string
}

const VERBS: Record<string, { verb: string; key?: string; targetKey?: string; mono?: boolean }> = {
  shell: { verb: 'Ran', key: 'command', mono: true },
  start_job: { verb: 'Started', key: 'command', mono: true },
  fs_read: { verb: 'Read', key: 'path', mono: true },
  fs_list: { verb: 'Listed', key: 'path', mono: true },
  fs_write: { verb: 'Wrote', key: 'path', mono: true },
  fs_edit: { verb: 'Edited', key: 'path', mono: true },
  fs_mkdir: { verb: 'Created', key: 'path', mono: true },
  fs_delete: { verb: 'Deleted', key: 'path', mono: true },
  fs_move: { verb: 'Moved', key: 'from', targetKey: 'to', mono: true },
  grep_search: { verb: 'Searched', key: 'pattern', mono: true },
  web_search: { verb: 'Searched the web', key: 'query' },
  web_fetch: { verb: 'Fetched', key: 'url', mono: true },
  fetch_image: { verb: 'Fetched image', key: 'url', mono: true },
  show_image: { verb: 'Showed', key: 'path', mono: true },
  show_image_data: { verb: 'Showed an image' },
  job_status: { verb: 'Checked on jobs' },
  stop_job: { verb: 'Stopped a job' },
  agent_result: { verb: 'Collected agent results' },
  peek_agents: { verb: 'Checked on agents' },
  todo_write: { verb: 'Updated the task list' },
  ask_user: { verb: 'Asked', key: 'question' },
  send_message: { verb: 'Sent a message', key: 'to' },
  list_sessions: { verb: 'Listed sessions' },
  check_inbox: { verb: 'Checked the inbox' },
  memory_search: { verb: 'Searched memory', key: 'query' },
  memory_read: { verb: 'Read memory', key: 'name', mono: true },
  memory_write: { verb: 'Wrote memory', key: 'name', mono: true }
}

/** The one-line label for a tool step: verb + subject, or the model's own purpose for a command. */
export function stepLabel(call: ToolCall): StepLabel {
  const { label, server } = prettyTool(call.tool)
  const args = rec(call.args)
  const purpose = str(args?.purpose)
  // Still drafting: nothing parsed yet, so read the streaming JSON for the primary argument.
  if (args === undefined && call.draftArgs) {
    const draft = draftPreviewFor(call)
    if (draft) {
      const subject = draft.target ?? draft.text
      return { verb: draft.label, subject: oneLine(subject), mono: true, server }
    }
  }
  const spec = VERBS[call.tool]
  if (spec) {
    const primary = spec.key ? str(args?.[spec.key]) : undefined
    const target = spec.targetKey ? str(args?.[spec.targetKey]) : undefined
    const subject = primary && target ? `${primary} → ${target}` : (primary ?? '')
    if (purpose && (call.tool === 'shell' || call.tool === 'start_job')) {
      // The model's own label for a command IS the step; the command text becomes the subject.
      return { verb: oneLine(purpose, 80), subject: oneLine(subject), mono: true, server }
    }
    return { verb: spec.verb, subject: oneLine(subject), mono: !!spec.mono, server }
  }
  // Unknown builtin or MCP tool: the tool name in words, with its first short string argument.
  let subject = ''
  if (args) {
    for (const v of Object.values(args)) {
      if (typeof v === 'string' && v.trim() && v.length <= 200) {
        subject = oneLine(v)
        break
      }
    }
  }
  return { verb: server ? label : humanize(label), subject, mono: true, server }
}

export type StepStatus = 'drafting' | 'running' | 'complete' | 'failed' | 'blocked' | 'interrupted'

/** A call's terminal-or-not state, with the two things the row needs to know about the run. */
export function stepStatus(call: ToolCall, live: boolean): StepStatus {
  if (call.status === 'requested') return live ? 'drafting' : 'interrupted'
  if (call.status === 'running') return live ? 'running' : 'interrupted'
  if (call.status === 'blocked') return 'blocked'
  if (call.status === 'failed' || call.ok === false) return 'failed'
  return 'complete'
}

export type ActivityStatus = 'running' | 'complete' | 'failed' | 'interrupted'

export interface ActivityOutcome {
  status: ActivityStatus
  /** Calls that failed or were denied. */
  failed: number
  /** Calls that reached a terminal state. */
  done: number
  /** All tool calls in the block. */
  calls: number
  /** Wall time the block accounts for: tool time plus reasoning time. */
  durationMs: number
}

/**
 * How a block went. `pending` says the block is the last thing in a still-running turn, where the
 * model may already be drafting the next call whose event has not landed — the block stays live
 * through that gap instead of flashing "done" between rounds.
 */
export function activityOutcome(items: ActivityItem[], live: boolean, pending: boolean): ActivityOutcome {
  let failed = 0
  let done = 0
  let calls = 0
  let durationMs = 0
  let active = false
  let interrupted = false
  for (const it of items) {
    if (it.kind === 'think') {
      durationMs += thoughtMs(it) ?? 0
      if (live && it.endTs === undefined && it.durationMs === undefined) active = true
      continue
    }
    if (it.kind !== 'tool') continue
    calls++
    const s = stepStatus(it.call, live)
    if (s === 'drafting' || s === 'running') active = true
    else if (s === 'interrupted') interrupted = true
    else {
      done++
      if (s === 'failed' || s === 'blocked') failed++
    }
    durationMs += it.call.durationMs ?? 0
  }
  const status: ActivityStatus =
    live && (active || pending) ? 'running' : interrupted ? 'interrupted' : failed > 0 ? 'failed' : 'complete'
  return { status, failed, done, calls, durationMs }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * One sentence for a settled block: "Ran 4 commands, read 2 files, edited Transcript.tsx, thought
 * 21s". Categories are named in the order a reader cares about (what changed first), an edit to a
 * single file names the file, and reasoning is included only when it was long enough to matter.
 */
export function summarizeActivity(items: ActivityItem[]): string {
  const edits = new Set<string>()
  let writes = 0
  let commands = 0
  let reads = 0
  let searches = 0
  let fetches = 0
  let images = 0
  const others = new Map<string, number>()
  let thinkMs = 0
  for (const it of items) {
    if (it.kind === 'think') {
      thinkMs += thoughtMs(it) ?? 0
      continue
    }
    if (it.kind !== 'tool') continue
    const { tool, args } = it.call
    const a = rec(args)
    switch (tool) {
      case 'fs_edit':
      case 'fs_write':
        writes++
        edits.add(str(a?.path) ?? `#${writes}`)
        break
      case 'shell':
      case 'start_job':
        commands++
        break
      case 'fs_read':
      case 'fs_list':
        reads++
        break
      case 'grep_search':
      case 'web_search':
      case 'memory_search':
        searches++
        break
      case 'web_fetch':
      case 'fetch_image':
        fetches++
        break
      case 'show_image':
      case 'show_image_data':
        images++
        break
      default: {
        const { label } = prettyTool(tool)
        others.set(label, (others.get(label) ?? 0) + 1)
      }
    }
  }
  const parts: string[] = []
  if (edits.size === 1) parts.push(`edited ${basename([...edits][0]!)}`)
  else if (edits.size > 1) parts.push(`edited ${plural(edits.size, 'file')}`)
  if (commands) parts.push(`ran ${plural(commands, 'command')}`)
  if (reads) parts.push(`read ${plural(reads, 'file')}`)
  if (searches) parts.push(searches === 1 ? 'searched once' : `searched ${searches} times`)
  if (fetches) parts.push(`fetched ${plural(fetches, 'page')}`)
  if (images) parts.push(`showed ${plural(images, 'image')}`)
  for (const [label, n] of others) {
    const words = VERBS[label]?.verb.toLowerCase() ?? humanize(label).toLowerCase()
    parts.push(n > 1 ? `${words} ×${n}` : words)
  }
  if (thinkMs >= 1000) parts.push(`thought ${formatElapsed(thinkMs)}`)
  if (parts.length === 0) return 'Worked'
  const s = parts.join(', ')
  return s[0]!.toUpperCase() + s.slice(1)
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Lines added and removed by a file edit, for the "+12 −3" chip on the step. */
export function editCounts(call: ToolCall): { added: number; removed: number } | null {
  const a = rec(call.args)
  if (!a || typeof a.path !== 'string') return null
  if (call.tool === 'fs_write' && typeof a.content === 'string') {
    return { added: a.content.length ? a.content.split('\n').length : 0, removed: 0 }
  }
  if (call.tool === 'fs_edit' && typeof a.old_string === 'string' && typeof a.new_string === 'string') {
    const before = a.old_string.split('\n')
    const after = a.new_string.split('\n')
    // Cheap symmetric difference on lines — the exact LCS is in Diff.tsx for the expanded view;
    // the chip only needs the order of magnitude.
    const counts = new Map<string, number>()
    for (const l of before) counts.set(l, (counts.get(l) ?? 0) + 1)
    let added = 0
    for (const l of after) {
      const n = counts.get(l) ?? 0
      if (n > 0) counts.set(l, n - 1)
      else added++
    }
    let removed = 0
    for (const n of counts.values()) removed += n
    return { added, removed }
  }
  return null
}

/** "584ms" under a second, else "1m 04s"; nothing for a call that took no measurable time. */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return formatElapsed(ms)
}

/**
 * The turn's one-line stats: wall time, output tokens, cache hit rate, cost. The full breakdown
 * (throughput, TTFT, reasoning tokens, cache writes) goes in `title` for a hover read; the visible
 * line carries only what a reader glances at.
 */
export function turnStats(t: TurnTelemetry, cost?: { usd: number; estimated: boolean }): { text: string; title: string } {
  const visible: string[] = []
  const detail: string[] = []
  if (t.wallMs !== undefined) {
    visible.push(t.wallMs >= 60000 ? formatElapsed(t.wallMs) : `${(t.wallMs / 1000).toFixed(1)}s`)
    detail.push(`Wall time ${formatElapsed(t.wallMs)}`)
  }
  const est = t.estimated ? '~' : ''
  if (t.tokensOut !== undefined) {
    visible.push(`${est}${fmtTokens(t.tokensOut)} out`)
    detail.push(`${est}${fmtTokens(t.tokensOut)} output tokens`)
  }
  if (t.tokensIn !== undefined) detail.push(`${est}${fmtTokens(t.tokensIn)} input tokens`)
  if (t.cacheReadTokens && t.tokensIn) {
    const pct = Math.round((t.cacheReadTokens / t.tokensIn) * 100)
    visible.push(`${pct}% cached`)
    detail.push(`${fmtTokens(t.cacheReadTokens)} input tokens served from cache (${pct}%)`)
  } else if (t.cacheWriteTokens) {
    detail.push(`${fmtTokens(t.cacheWriteTokens)} tokens written to the prompt cache`)
  }
  if (t.tokensReasoning) detail.push(`${fmtTokens(t.tokensReasoning)} reasoning tokens`)
  if (t.tps) detail.push(`${t.tps} tokens/s`)
  if (t.ttftMs !== undefined) detail.push(`${(t.ttftMs / 1000).toFixed(1)}s to first token`)
  if (t.toolMs) detail.push(`${formatElapsed(t.toolMs)} in tools`)
  if (cost && cost.usd > 0) {
    visible.push(`${cost.estimated ? '~' : ''}$${cost.usd.toFixed(cost.usd < 0.01 ? 4 : 3)}`)
    detail.push(cost.estimated ? 'Cost estimated from list price — click to set your own rates' : 'Cost')
  } else if (t.costUsd !== undefined) {
    visible.push(`$${t.costUsd.toFixed(t.costUsd < 0.01 ? 4 : 3)}`)
    detail.push('Cost reported by the provider')
  }
  return { text: visible.join(' · '), title: detail.join('\n') }
}

/** Whether a tool call produced something the reader should see even when its block is folded. */
export function hasVisibleResult(call: ToolCall): boolean {
  return call.tool === 'show_image' || call.tool === 'show_image_data' || call.tool === 'fetch_image'
}

/** Re-export for the component so it has one import for labels. */
export { toolActivityLabel }
