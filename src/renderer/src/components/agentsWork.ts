import type { BgJobView, RunEvent } from '@shared/types'
import type { SubagentIndex, SubagentView } from './subagents'

/**
 * Pure folding for the Agents panel (the inspector's "what is working for this thread" view).
 *
 * The panel lists two kinds of work side by side — subagents the model delegated to, and shell
 * commands running in the background — as one list of rows that all read the same way: a name,
 * a one-line status that says what the thing is doing (or how it ended), and how long it took.
 * Everything here is plain data so it can be unit-tested; the component only renders it.
 */

/** How a subagent stands right now, folded from its events. */
export type AgentOutcome =
  | 'running'
  | 'done'
  | 'failed'
  /** the user stopped it (per-agent Stop, Stop all, or the thread's run was canceled) */
  | 'stopped'
  /** the model hit its output limit before finishing */
  | 'truncated'

export function agentOutcome(v: SubagentView): AgentOutcome {
  if (v.running) return 'running'
  if (v.error || v.completedReason === 'error') return 'failed'
  if (v.completedReason === 'canceled') return 'stopped'
  if (v.completedReason === 'length') return 'truncated'
  return 'done'
}

/** What the parent asked a subagent to do, read off its `run_agent` call. */
export interface Brief {
  task?: string
  /** spawned with `background: true` — it outlives the turn and reports back as a new message */
  background: boolean
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/**
 * Index the parent run's `run_agent` calls by callId so each subagent row can show its brief.
 * Only parent events (no `agent` tag) are considered: a subagent's own delegations belong to it.
 */
export function indexBriefs(events: RunEvent[]): Map<string, Brief> {
  const out = new Map<string, Brief>()
  for (const ev of events) {
    if (ev.agent) continue
    const b = ev.body
    if ((b.type === 'tool.proposed' || b.type === 'tool.started') && b.tool === 'run_agent') {
      const args = record(b.args)
      const prev = out.get(b.callId)
      out.set(b.callId, {
        task: str(args?.task) ?? prev?.task,
        background: args?.background === true || prev?.background === true
      })
    } else if (b.type === 'tool.result' && b.tool === 'run_agent') {
      const res = record(b.result)
      if (res?.background === true) {
        const prev = out.get(b.callId)
        out.set(b.callId, { task: prev?.task, background: true })
      }
    }
  }
  return out
}

export type WorkItem =
  | {
      kind: 'agent'
      id: string
      view: SubagentView
      brief?: Brief
      running: boolean
      startedAt: number
      endedAt?: number
    }
  | {
      kind: 'job'
      id: string
      job: BgJobView
      running: boolean
      startedAt: number
      endedAt?: number
    }

export interface WorkLists {
  /** still going — oldest first, so a row keeps its place while it runs */
  working: WorkItem[]
  /** settled — most recently finished first */
  finished: WorkItem[]
}

/** Fold subagents and background jobs into one ordered list of rows. */
export function buildWorkItems(index: SubagentIndex, briefs: Map<string, Brief>, jobs: BgJobView[]): WorkLists {
  const items: WorkItem[] = []
  for (const view of index.byId.values()) {
    items.push({
      kind: 'agent',
      id: `agent:${view.id}`,
      view,
      brief: view.parentCallId ? briefs.get(view.parentCallId) : undefined,
      running: view.running,
      startedAt: view.startedAt ?? view.events[0]?.ts ?? 0,
      endedAt: view.endedAt
    })
  }
  for (const job of jobs) {
    items.push({
      kind: 'job',
      id: `job:${job.id}`,
      job,
      running: job.running,
      startedAt: job.startedAt,
      endedAt: job.endedAt
    })
  }
  const working = items.filter((i) => i.running).sort((a, b) => a.startedAt - b.startedAt)
  const finished = items
    .filter((i) => !i.running)
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  return { working, finished }
}

export interface Summary {
  working: number
  done: number
  failed: number
  stopped: number
  truncated: number
}

/** Counts for the strip at the top of the panel (and the tab badge). */
export function summarize(lists: WorkLists): Summary {
  const s: Summary = { working: lists.working.length, done: 0, failed: 0, stopped: 0, truncated: 0 }
  for (const item of lists.finished) {
    if (item.kind === 'agent') {
      const o = agentOutcome(item.view)
      if (o === 'done') s.done += 1
      else if (o === 'failed') s.failed += 1
      else if (o === 'stopped') s.stopped += 1
      else if (o === 'truncated') s.truncated += 1
    } else {
      if (item.job.status === 'done') s.done += 1
      else if (item.job.status === 'failed') s.failed += 1
      else if (item.job.status === 'canceled') s.stopped += 1
    }
  }
  return s
}

/** Colour family for a status line. */
export type Tone = 'live' | 'ok' | 'bad' | 'warn' | 'muted'

/** One line that says what a row is doing, or how it ended. */
export interface StatusLine {
  icon: string
  tone: Tone
  text: string
  /** animate the icon (running work) */
  spin?: boolean
}

/** "no tool calls" / "1 tool call" / "12 tool calls · 2 failed" */
export function toolsSummary(v: SubagentView): string {
  if (v.toolCalls === 0) return 'no tool calls'
  const base = `${v.toolCalls} tool ${v.toolCalls === 1 ? 'call' : 'calls'}`
  return v.toolsFailed > 0 ? `${base} · ${v.toolsFailed} failed` : base
}

/** The agent's wall-clock span once it has settled, in ms. */
export function agentSpanMs(v: SubagentView): number | undefined {
  if (v.startedAt === undefined) return undefined
  const end = v.endedAt ?? v.events[v.events.length - 1]?.ts
  return end === undefined ? undefined : Math.max(0, end - v.startedAt)
}

/**
 * The status line for a subagent row. A finished row's span lives on the title line next to the
 * name (the same slot that ticks while it runs), so the status text says only how it ended.
 */
export function agentStatus(v: SubagentView): StatusLine {
  const outcome = agentOutcome(v)
  if (outcome === 'running') {
    const a = v.activity
    switch (a.kind) {
      case 'starting':
        return { icon: 'rocket_launch', tone: 'live', text: 'Starting up…' }
      case 'thinking':
        return { icon: 'neurology', tone: 'live', text: 'Thinking…' }
      case 'writing':
        return { icon: 'edit_note', tone: 'live', text: 'Writing its report…' }
      case 'tool':
        return { icon: 'build', tone: 'live', text: a.label, spin: false }
    }
  }
  if (outcome === 'failed') {
    return { icon: 'error', tone: 'bad', text: `Failed · ${firstLine(v.error) ?? 'the run errored'}` }
  }
  if (outcome === 'stopped') return { icon: 'block', tone: 'muted', text: `Stopped · ${toolsSummary(v)}` }
  if (outcome === 'truncated') {
    return { icon: 'content_cut', tone: 'warn', text: `Cut off at the output limit · ${toolsSummary(v)}` }
  }
  return { icon: 'check', tone: 'ok', text: `Done · ${toolsSummary(v)}` }
}

/** The last non-blank line of a command's output — what it is "saying" right now. */
export function lastOutputLine(output: string): string {
  const lines = output.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]?.trim()
    if (l) return l
  }
  return ''
}

/** The status line for a background job row (its span, like an agent's, sits on the title line). */
export function jobStatus(job: BgJobView): StatusLine {
  if (job.running) {
    const tail = lastOutputLine(job.output)
    return { icon: 'terminal', tone: 'live', text: tail ? tail : 'Running · no output yet' }
  }
  const lines = outputLineCount(job.output)
  const output = lines === 0 ? 'no output' : `${lines} ${lines === 1 ? 'line' : 'lines'}`
  if (job.status === 'done') return { icon: 'check', tone: 'ok', text: `Finished · exit 0 · ${output}` }
  if (job.status === 'failed') {
    return { icon: 'error', tone: 'bad', text: `Failed · exit ${job.exitCode ?? 1} · ${output}` }
  }
  return { icon: 'block', tone: 'muted', text: `Stopped · ${output}` }
}

/** Number of lines of output a job has produced so far. */
export function outputLineCount(output: string): number {
  if (!output) return 0
  return output.split('\n').filter((l) => l.trim()).length
}

/**
 * A model id short enough for a 320px column: the last path segment of a routed id
 * ("openrouter/minimax/minimax-m3:free" → "minimax-m3:free"); a bare id is returned as is.
 */
export function shortModel(id: string): string {
  const i = id.lastIndexOf('/')
  return i >= 0 && i < id.length - 1 ? id.slice(i + 1) : id
}

/** Trim a possibly multi-line message to its first line. */
export function firstLine(s: string | undefined): string | undefined {
  if (!s) return undefined
  const line = s.split('\n').find((l) => l.trim())?.trim()
  return line || undefined
}

/** How many finished rows the panel shows before folding the rest behind "Show older". */
export const FINISHED_PREVIEW = 4
