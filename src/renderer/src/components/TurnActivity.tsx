/**
 * The activity side of an assistant turn: what the model did between the things it said.
 *
 * A turn's woven timeline (see runTimeline.ts) is split into a flow of prose passages, activity
 * blocks, and subagent cards (`flowOf` in turnFlow.ts). This file renders that flow:
 *
 *   - `RunTimeline` — the flow itself. Prose is unboxed text; a delegation is a SubagentCard; every
 *     stretch of reasoning + tool calls in between is one `ActivityBlock`.
 *   - `ActivityBlock` — one line while settled ("Ran 4 commands, edited 2 files, thought 21s"),
 *     open into a step list while live or when the reader opens it. Anything a reader must see
 *     regardless (an image the model showed) surfaces under the line even when folded.
 *   - `ToolStep` / `ThoughtStep` — one line each: what happened and how it went, with the detail
 *     (arguments, output, diff, reasoning text) one click down.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/state/store'
import { Markdown } from './Markdown'
import { I } from './Icon'
import { FileDiff } from './Diff'
import { SubagentCard } from './SubagentCard'
import { useElapsed, formatElapsed } from './useElapsed'
import { useSmoothText } from './useSmoothText'
import { bufferedByPipe } from '@shared/commandHints'
import { toolDetailView } from './toolResultView'
import { draftPreviewFor, findResultImages, type TimelineItem, type ToolCall, type ToolItem } from './runTimeline'
import {
  activityOutcome,
  editCounts,
  flowOf,
  fmtDuration,
  hasVisibleResult,
  stepLabel,
  stepStatus,
  summarizeActivity,
  thoughtMs,
  type ActivityItem,
  type ThinkItem
} from './turnFlow'

function pretty(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function clip(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + `\n… [${s.length - max} more chars]` : s
}

/**
 * A turn's flow, in order: prose where the model spoke, an activity block for every stretch of
 * work in between, a subagent card for each delegation. `fullText` is the live message body — the
 * still-streaming last passage renders from it (events lag the body by a coalescing window).
 */
export function RunTimeline({
  items,
  running,
  fullText,
  model
}: {
  items: TimelineItem[]
  running: boolean
  fullText: string
  model?: string
}): React.JSX.Element {
  const flow = useMemo(() => flowOf(items), [items])
  let lastProse: Extract<TimelineItem, { kind: 'output' }> | undefined
  for (const it of items) if (it.kind === 'output') lastProse = it

  const rows: React.ReactNode[] = []
  let outputChars = 0
  flow.forEach((node, i) => {
    const isLast = i === flow.length - 1
    if (node.kind === 'prose') {
      const live = running && node.item === lastProse && node.item.endTs === undefined
      const start = outputChars
      outputChars += node.item.text.length
      rows.push(<Prose key={`p-${node.item.seq}`} text={live ? fullText.slice(start) : node.item.text} live={live} />)
    } else if (node.kind === 'agent') {
      rows.push(<SubagentCard key={node.item.callId} callId={node.item.callId} call={node.item.call} live={running} />)
    } else {
      const first = node.items[0]!
      const key = first.kind === 'tool' ? `a-${first.callId}` : `a-${first.seq}`
      rows.push(<ActivityBlock key={key} items={node.items} live={running} pending={isLast && running} />)
    }
  })

  // Freshly started prose whose first delta hasn't flushed to events yet: the body already has the
  // characters, so show them rather than dead air.
  const lastOpen = lastProse !== undefined && lastProse.endTs === undefined
  const trailing =
    running && !lastOpen && fullText.length > outputChars ? <Prose key="p-live" text={fullText.slice(outputChars)} live /> : null

  return (
    <div className="run-flow" aria-label="Run activity" data-model={model}>
      {rows}
      {trailing}
    </div>
  )
}

/** One passage the model spoke, as plain text in the column. The live one reveals as it streams. */
function Prose({ text, live }: { text: string; live: boolean }): React.JSX.Element {
  const shown = useSmoothText(text, live)
  return (
    <div className={`turn-prose${live ? ' live' : ''}`}>
      <Markdown text={live ? shown : text} />
    </div>
  )
}

/**
 * A stretch of work between two passages. Folded to one line once settled; open while live so the
 * reader watches the steps land. A reader's own toggle is remembered so a block they opened stays
 * open when the turn finishes, and one they closed mid-run stays closed.
 */
export function ActivityBlock({
  items,
  live,
  pending
}: {
  items: ActivityItem[]
  live: boolean
  /** Last block of a running turn: keep it live through the gap before the next round's event. */
  pending: boolean
}): React.JSX.Element {
  const reasoningVisibility = useStore((s) => s.settings?.reasoningVisibility ?? 'auto')
  const outcome = useMemo(() => activityOutcome(items, live, pending), [items, live, pending])
  const running = outcome.status === 'running'
  const [open, setOpen] = useState(running || reasoningVisibility === 'expanded')
  const toggled = useRef(false)
  const wasRunning = useRef(running)
  useEffect(() => {
    // Settle: fold the block the moment the work finishes, unless the reader touched it.
    if (wasRunning.current && !running && !toggled.current && reasoningVisibility !== 'expanded') setOpen(false)
    if (!wasRunning.current && running && !toggled.current) setOpen(true)
    wasRunning.current = running
  }, [running, reasoningVisibility])

  const summary = useMemo(() => summarizeActivity(items), [items])
  const steps = useMemo(() => items.filter((it) => it.kind !== 'think' || reasoningVisibility !== 'hidden'), [items, reasoningVisibility])
  // The step in flight, for the folded header of a live block the reader closed.
  const current = useMemo(() => {
    if (!running) return null
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (it.kind === 'tool') {
        const s = stepStatus(it.call, live)
        if (s === 'running' || s === 'drafting') return stepLabel(it.call)
      } else if (it.kind === 'think' && it.endTs === undefined && it.durationMs === undefined) {
        return { verb: 'Thinking…', subject: '', mono: false }
      }
    }
    return null
  }, [items, running, live])
  // Results the reader must see even when the block is folded.
  const surfaced = useMemo(
    () =>
      open
        ? []
        : items.flatMap((it) =>
            it.kind === 'tool' && hasVisibleResult(it.call) && it.call.status === 'complete' && it.call.ok !== false
              ? findResultImages(it.call.result)
              : []
          ),
    [items, open]
  )

  const glyph = running ? 'autorenew' : outcome.status === 'failed' ? 'error' : outcome.status === 'interrupted' ? 'do_not_disturb_on' : 'check'
  const duration = fmtDuration(outcome.durationMs)
  const stepCount = steps.length

  return (
    <div className={`activity ${outcome.status}${open ? ' open' : ''}`}>
      <button
        className="activity-head"
        onClick={() => {
          toggled.current = true
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        title={open ? 'Fold this work' : 'Show each step'}
      >
        <I name={glyph} size={15} className={`activity-glyph${running ? ' spin' : ''}`} />
        <span className="activity-summary">
          {running && current && !open ? (
            <>
              <span className="activity-current">{current.verb}</span>
              {current.subject && <span className={`activity-current-subject${current.mono ? ' mono' : ''}`}> {current.subject}</span>}
            </>
          ) : (
            summary
          )}
        </span>
        <span className="activity-side">
          {outcome.failed > 0 && !running && (
            <span className="activity-failed">{outcome.failed === 1 ? '1 failed' : `${outcome.failed} failed`}</span>
          )}
          {running && outcome.calls > 1 && <span className="activity-progress">{outcome.done}/{outcome.calls}</span>}
          {!running && duration && outcome.durationMs >= 1000 && <span className="activity-duration">{duration}</span>}
          {!open && stepCount > 1 && <span className="activity-count">{stepCount} steps</span>}
          <I name={open ? 'expand_less' : 'expand_more'} size={15} className="activity-chev" />
        </span>
      </button>
      {open && (
        <ol className="steps">
          {steps.map((it, i) => {
            if (it.kind === 'tool') return <ToolStep key={it.callId} call={it.call} live={live} />
            if (it.kind === 'think') return <ThoughtStep key={`t-${it.seq}`} item={it} live={live} />
            return (
              <li key={`n-${i}`} className="step notice" role="note">
                <span className="step-glyph">↻</span>
                <span className="step-verb">{it.text}</span>
              </li>
            )
          })}
        </ol>
      )}
      {surfaced.length > 0 && (
        <div className="activity-results">
          {surfaced.map((img, i) => (
            <ResultImage key={i} url={img.url} caption={img.caption} />
          ))}
        </div>
      )}
    </div>
  )
}

/** A bout of reasoning: "Thought for 21s", opening onto the reasoning text when there is any. */
function ThoughtStep({ item, live }: { item: ThinkItem; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hasText = item.text.length > 0
  const running = live && item.endTs === undefined && item.durationMs === undefined
  const ticking = useElapsed(running, item.startTs)
  const settled = thoughtMs(item)
  const ms = running ? ticking : settled
  const tokens = item.silent && item.tokenCount ? ` · ${item.tokenCount.toLocaleString()} tokens` : ''
  // Under a second the number is noise; the line still says the model thought before acting.
  const label = running ? 'Thinking…' : settled !== undefined && settled >= 1000 ? `Thought for ${formatElapsed(settled)}` : 'Thought'
  const shown = useSmoothText(item.text, running && open)
  return (
    <li className={`step thought${running ? ' running' : ''}${open ? ' open' : ''}`}>
      <button
        className={`step-line${hasText ? ' expandable' : ''}`}
        onClick={hasText ? () => setOpen((v) => !v) : undefined}
        disabled={!hasText}
        aria-expanded={hasText ? open : undefined}
        title={item.silent ? 'This model reports its thinking only as a token count; the text is never sent.' : undefined}
      >
        <span className="step-glyph">
          <I name={running ? 'autorenew' : 'neurology'} size={13} className={running ? 'spin' : ''} />
        </span>
        <span className="step-verb">{label}</span>
        {tokens && <span className="step-subject">{tokens}</span>}
        {running && ms !== undefined && ms >= 1000 && <span className="step-side">{formatElapsed(ms)}</span>}
        {hasText && <I name={open ? 'expand_less' : 'expand_more'} size={14} className="step-chev" />}
      </button>
      {open && hasText && (
        <div className="step-reasoning thinking-log">
          <Markdown text={running ? shown : item.text} />
        </div>
      )}
    </li>
  )
}

/**
 * One tool call as one line: what it did, how it went. Below the line, only what the reader needs
 * without asking: the arguments still streaming in, a running command's live output, a file edit's
 * diff, an image the call produced. Everything else (arguments, output, raw JSON) is one click down.
 */
function ToolStep({ call, live }: { call: ToolCall; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const setUi = useStore((s) => s.setUi)
  const label = stepLabel(call)
  const status = stepStatus(call, live)
  const argsText = call.args !== undefined ? pretty(call.args) : (call.draftArgs ?? '')
  const resultText = call.reason ? call.reason : pretty(call.result)
  const argsRecord = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? (call.args as Record<string, unknown>) : undefined
  // Live output: a running foreground command streams its buffer (tool.progress); a background or
  // promoted job is looked up in the thread's jobs by the id in this call's result.
  const resultRecord = call.result && typeof call.result === 'object' && !Array.isArray(call.result) ? (call.result as Record<string, unknown>) : undefined
  const jobId = typeof resultRecord?.jobId === 'string' ? resultRecord.jobId : undefined
  const job = useStore((s) => (jobId ? s.jobs.find((j) => j.id === jobId) : undefined))
  const liveOutput = status === 'running' ? call.liveOutput : job?.running ? job.output : undefined
  const liveTail = liveOutput ? liveOutput.split('\n').slice(-60).join('\n').trimEnd() : ''
  const canExpand = !!(argsText || resultText || liveOutput)
  // A job row's time is the job's, not the 1 ms it took to start it: tick while it runs, then its span.
  const jobStartedAt = typeof resultRecord?.startedAt === 'number' ? (resultRecord.startedAt as number) : job?.startedAt
  const jobTicking = useElapsed(!!job?.running, jobStartedAt)
  const jobSpanMs = job ? (job.running ? jobTicking : (job.endedAt ?? job.startedAt) - job.startedAt) : undefined
  const commandText = typeof argsRecord?.command === 'string' ? argsRecord.command : ''
  const bufferedBy = !liveTail && commandText ? bufferedByPipe(commandText) : null
  const diff = fileDiffFor(call)
  const counts = diff ? editCounts(call) : null
  const images = call.status === 'complete' && call.ok !== false ? findResultImages(call.result) : []
  const drafting = status === 'drafting'
  const draftPreview = drafting ? draftPreviewFor(call) : null
  const view = useMemo(() => (open ? toolDetailView(call.tool, call.args, call.result, call.reason) : null), [open, call.tool, call.args, call.result, call.reason])

  // The right-hand outcome: a problem in words, otherwise the time when it was long enough to matter.
  let side = ''
  if (status === 'blocked') side = 'denied'
  else if (status === 'failed') side = view?.status ?? 'failed'
  else if (status === 'interrupted') side = 'interrupted'
  else if (job?.running) side = `in background · ${formatElapsed(jobSpanMs ?? 0)}`
  else if (jobSpanMs !== undefined) side = formatElapsed(jobSpanMs)
  else if (status === 'complete' && call.durationMs !== undefined && call.durationMs >= 1000) side = fmtDuration(call.durationMs)
  else if (status === 'complete' && view?.status && view.status !== 'exit 0') side = view.status

  const glyph = drafting ? 'more_horiz' : status === 'running' ? 'autorenew' : status === 'failed' || status === 'blocked' ? 'error' : status === 'interrupted' ? 'do_not_disturb_on' : 'check'

  return (
    <li className={`step tool ${status}${open ? ' open' : ''}`}>
      <button className={`step-line${canExpand ? ' expandable' : ''}`} onClick={canExpand ? () => setOpen((v) => !v) : undefined} disabled={!canExpand} aria-expanded={canExpand ? open : undefined}>
        <span className="step-glyph">
          <I name={glyph} size={13} className={status === 'running' ? 'spin' : drafting ? 'pulse' : ''} />
        </span>
        <span className="step-verb">{label.verb}</span>
        {label.subject && (
          <span className={`step-subject${label.mono ? ' mono' : ''}`} title={label.subject}>
            {label.subject}
          </span>
        )}
        {label.server && <span className="step-server">{label.server}</span>}
        {counts && (counts.added > 0 || counts.removed > 0) && (
          <span className="step-counts">
            {counts.added > 0 && <span className="add">+{counts.added}</span>}
            {counts.removed > 0 && <span className="del">−{counts.removed}</span>}
          </span>
        )}
        {side && <span className="step-side">{side}</span>}
        {drafting && !side && <span className="step-side drafting">…</span>}
        {canExpand && <I name={open ? 'expand_less' : 'expand_more'} size={14} className="step-chev" />}
      </button>
      {draftPreview && draftPreview.text && (
        <div className="step-body tool-draft-preview" aria-live="polite">
          <div className="tool-draft-head">
            <span className="tool-draft-action">
              <I name={call.tool === 'shell' || call.tool === 'start_job' ? 'terminal' : call.tool === 'fs_write' ? 'edit_note' : 'edit'} size={13} />
              {draftPreview.label}
            </span>
            {draftPreview.target && (
              <span className="tool-draft-target" title={draftPreview.target}>
                {draftPreview.target}
              </span>
            )}
          </div>
          <pre>{clip(draftPreview.text, 3200)}</pre>
        </div>
      )}
      {diff && (
        <div className="step-body step-diff">
          <FileDiff path={diff.path} before={diff.before} after={diff.after} kind={diff.kind} onActivate={() => setUi({ inspectorOpen: true, inspectorTab: 'run' })} />
        </div>
      )}
      {images.length > 0 && (
        <div className="step-body tool-result-images">
          {images.map((img, i) => (
            <ResultImage key={i} url={img.url} caption={img.caption} />
          ))}
        </div>
      )}
      {liveOutput !== undefined && (
        <div className="step-body tool-live-output inline" aria-live="polite">
          <div className="tool-detail-label">
            <I name="autorenew" size={12} className="spin" />
            Live output
            {commandText && (
              <span className="tool-live-cmd" title={commandText}>
                {commandText}
              </span>
            )}
          </div>
          <pre>
            {liveTail ||
              (bufferedBy
                ? `(no output yet — the command pipes through \`${bufferedBy}\`, which holds everything until it finishes)`
                : '(no output yet)')}
          </pre>
        </div>
      )}
      {open && view && (argsText || resultText) && (
        <div className="step-body">
          <ToolDetail call={call} argsText={argsText} view={view} />
        </div>
      )}
    </li>
  )
}

/**
 * The expanded body of a tool step. Known tools get a readable shape (a command line, an output
 * block with an exit chip, one status line per job or agent) via `toolDetailView`; the prose the
 * runtime addresses to the model is kept behind a "note to the model" disclosure; anything else
 * falls back to the raw arguments/result JSON.
 */
function ToolDetail({ call, argsText, view }: { call: ToolCall; argsText: string; view: ReturnType<typeof toolDetailView> }): React.JSX.Element {
  const [rawOpen, setRawOpen] = useState(false)
  const showRawArgs = view.argsSummary === null && !view.argsCode && !!argsText
  return (
    <div className="tool-detail">
      {(view.argsCode || view.argsSummary) && (
        <div className="tool-detail-args">
          <div className="tool-detail-label">Arguments{view.argsSummary ? <span className="tool-detail-sub"> · {view.argsSummary}</span> : null}</div>
          {view.argsCode && <pre className="tool-detail-code">{clip(view.argsCode, 2000)}</pre>}
        </div>
      )}
      {showRawArgs && (
        <>
          <div className="tool-detail-label">Arguments</div>
          <pre>{clip(argsText)}</pre>
        </>
      )}
      {view.status && <div className="tool-detail-status">{view.status}</div>}
      {view.sections.map((sec, i) => (
        <div key={i} className="tool-detail-section">
          <div className="tool-detail-label">{sec.label}</div>
          {sec.kind === 'text' ? <div className="tool-detail-text">{clip(sec.text)}</div> : <pre>{clip(sec.text)}</pre>}
        </div>
      ))}
      {view.modelNotes.length > 0 && (
        <details className="tool-detail-notes">
          <summary>Note to the model</summary>
          {view.modelNotes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </details>
      )}
      {(view.argsCode || view.argsSummary !== null || view.sections.length > 0) && (
        <button className="tool-detail-raw" onClick={() => setRawOpen((v) => !v)}>
          {rawOpen ? 'Hide raw' : 'Raw'}
        </button>
      )}
      {rawOpen && (
        <>
          {argsText && (
            <>
              <div className="tool-detail-label">Arguments (raw)</div>
              <pre>{clip(argsText)}</pre>
            </>
          )}
          {call.result !== undefined && (
            <>
              <div className="tool-detail-label">Result (raw)</div>
              <pre>{clip(pretty(call.result))}</pre>
            </>
          )}
        </>
      )}
    </div>
  )
}

/** One image a tool call surfaced, shown at a comfortable preview size; click to view full-size. */
function ResultImage({ url, caption }: { url: string; caption?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="tool-result-image">
      <img src={url} alt={caption ?? 'Image from tool call'} className={expanded ? 'expanded' : ''} onClick={() => setExpanded((v) => !v)} />
      {caption && <div className="tool-result-image-caption">{caption}</div>}
    </div>
  )
}

/** Extract before/after text for file-mutating tools so the step can render a diff. */
function fileDiffFor(call: ToolCall): { path: string; before: string; after: string; kind: 'edit' | 'write' } | null {
  if (call.status === 'blocked' || call.ok === false) return null
  const a = call.args
  if (!a || typeof a !== 'object') return null
  const args = a as Record<string, unknown>
  if (typeof args.path !== 'string') return null
  if (call.tool === 'fs_edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
    return { path: args.path, before: args.old_string, after: args.new_string, kind: 'edit' }
  }
  if (call.tool === 'fs_write' && typeof args.content === 'string') {
    return { path: args.path, before: '', after: args.content, kind: 'write' }
  }
  return null
}

export type { ToolItem }
