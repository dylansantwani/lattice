import type { ErrorCategory, RunEvent, RunId, TurnFlowNode, TurnImage, TurnStep, TurnSummary } from '../types'
import { buildTimeline, findResultImages, type ToolCall } from './runTimeline'
import { activityOutcome, editCounts, flowOf, fmtDuration, hasVisibleResult, stepLabel, stepStatus, summarizeActivity, thoughtMs } from './turnFlow'
import { toolDetailStatus } from './toolStatus'

/**
 * Fold one run's events into the flow a transcript renders — the same tiers the desktop shows
 * (prose · one-line activity with steps · subagent card) — so a remote client can draw a settled
 * turn from a few hundred bytes instead of re-deriving it from thousands of events. Pure.
 */
export interface SummarizeOptions {
  /** Clip a thought's text to this many characters (default 400 — a preview; the full text is one
   *  on-demand fetch away, and thought previews were half the bytes of a 40-message view). */
  maxThoughtChars?: number
  /** Clip a subagent report to this many characters (default 2400). */
  maxReportChars?: number
  /** Leave out any image whose data URL is longer than this (default 200 000 chars). */
  maxImageChars?: number
  /** Whether the run is still live (its trailing block stays "running"). */
  live?: boolean
  model?: string
}

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + '…' : s)
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

export function summarizeTurn(runId: RunId, events: RunEvent[], opts: SummarizeOptions = {}): TurnSummary {
  const live = opts.live ?? false
  const main = events.filter((e) => e.runId === runId && !e.agent)
  const timeline = buildTimeline(main)
  const flow = flowOf(timeline)
  const nodes: TurnFlowNode[] = []
  flow.forEach((node, i) => {
    const isLast = i === flow.length - 1
    if (node.kind === 'prose') {
      if (node.item.text.trim()) nodes.push({ kind: 'prose', text: node.item.text })
      return
    }
    if (node.kind === 'agent') {
      const call = node.item.call
      const args = rec(call.args)
      const result = rec(call.result)
      const role = typeof args?.agent_type === 'string' ? args.agent_type : undefined
      const name = (typeof args?.name === 'string' && args.name) || (role ? role[0]!.toUpperCase() + role.slice(1) : 'Subagent')
      const report = typeof result?.result === 'string' ? clip(result.result, opts.maxReportChars ?? 2400) : undefined
      nodes.push({ kind: 'agent', callId: node.item.callId, name, role, status: stepStatus(call, live), report })
      return
    }
    const outcome = activityOutcome(node.items, live, isLast && live)
    const steps: TurnStep[] = []
    const images: TurnImage[] = []
    for (const it of node.items) {
      if (it.kind === 'think') {
        const ms = thoughtMs(it)
        steps.push({
          kind: 'thought',
          verb: ms !== undefined && ms >= 1000 ? `Thought for ${fmtDuration(ms)}` : 'Thought',
          status: it.endTs === undefined && it.durationMs === undefined && live ? 'running' : 'complete',
          durationMs: ms,
          text: it.text ? clip(it.text, opts.maxThoughtChars ?? 400) : undefined
        })
        continue
      }
      if (it.kind === 'notice') {
        steps.push({ kind: 'notice', verb: it.text, status: 'complete' })
        continue
      }
      const call = it.call
      const label = stepLabel(call)
      const status = stepStatus(call, live)
      const counts = editCounts(call)
      steps.push({
        kind: 'tool',
        callId: it.callId,
        verb: label.verb,
        subject: label.subject || undefined,
        mono: label.mono || undefined,
        server: label.server,
        status,
        side: stepSide(call, status) || undefined,
        durationMs: call.durationMs,
        added: counts?.added || undefined,
        removed: counts?.removed || undefined
      })
      if (hasVisibleResult(call) && call.status === 'complete' && call.ok !== false) {
        for (const img of findResultImages(call.result)) {
          if (img.url.length <= (opts.maxImageChars ?? 200_000)) images.push(img)
        }
      }
    }
    nodes.push({
      kind: 'activity',
      summary: summarizeActivity(node.items),
      status: outcome.status,
      failed: outcome.failed,
      calls: outcome.calls,
      durationMs: outcome.durationMs,
      steps,
      images: images.length ? images : undefined
    })
  })

  const errorEv = main.find((e) => e.body.type === 'error')
  const error = errorEv && errorEv.body.type === 'error' ? { category: errorEv.body.category as ErrorCategory, message: errorEv.body.message } : undefined
  const completed = main.find((e) => e.body.type === 'run.completed')
  const status: TurnSummary['status'] = live
    ? 'running'
    : error
      ? 'failed'
      : completed && completed.body.type === 'run.completed' && completed.body.reason === 'canceled'
        ? 'interrupted'
        : 'complete'
  return { runId, model: opts.model, status, flow: nodes, error, eventCount: events.length }
}

/** The step's right-hand text: a problem in words, else the time when it was long enough to matter. */
function stepSide(call: ToolCall, status: TurnStep['status']): string {
  if (status === 'blocked') return 'denied'
  if (status === 'failed') return toolDetailStatus(call.tool, call.result) ?? 'failed'
  if (status === 'interrupted') return 'interrupted'
  if (status === 'complete') {
    const exit = toolDetailStatus(call.tool, call.result)
    if (exit && exit !== 'exit 0') return exit
    if (call.durationMs !== undefined && call.durationMs >= 1000) return fmtDuration(call.durationMs)
  }
  return ''
}
