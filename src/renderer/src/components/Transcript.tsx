import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, ReasoningFidelity, RunEvent, TurnTelemetry } from '@shared/types'
import { useStore } from '@/state/store'
import { Markdown } from './Markdown'
import { fmtTokens } from './ContextOrbit'
import { useElapsed, formatElapsed } from './useElapsed'
import { I } from './Icon'
import { FileDiff } from './Diff'
import { buildTimeline, type TimelineItem, type ToolCall } from './runTimeline'

export function Transcript(): React.JSX.Element {
  const messages = useStore((s) => s.messages)
  const events = useStore((s) => s.events)
  const settings = useStore((s) => s.settings)
  const scroller = useRef<HTMLDivElement>(null)
  const [stickBottom, setStickBottom] = useState(true)

  useEffect(() => {
    if (stickBottom && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight
    }
  }, [messages, events, stickBottom])

  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    setStickBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  const eventsByRun = useMemo(() => {
    const map = new Map<string, RunEvent[]>()
    for (const ev of events) {
      const list = map.get(ev.runId) ?? []
      list.push(ev)
      map.set(ev.runId, list)
    }
    return map
  }, [events])

  return (
    <div className="transcript" ref={scroller} onScroll={onScroll}>
      <div className="turns">
        {messages.map((msg) => {
          if (msg.role === 'system') return <CompactionSummary key={msg.id} msg={msg} />
          const turn =
            msg.role === 'user' ? (
              <UserTurn msg={msg} />
            ) : (
              <AssistantTurn
                msg={msg}
                events={msg.runId ? (eventsByRun.get(msg.runId) ?? []) : []}
                showTelemetry={settings?.telemetryFooter ?? true}
              />
            )
          // Compacted turns stay in the transcript for the reader but are dimmed — they are
          // no longer sent to the model in full; the summary below stands in for them.
          return msg.compacted ? (
            <div key={msg.id} className="compacted-turn">
              {turn}
            </div>
          ) : (
            <React.Fragment key={msg.id}>{turn}</React.Fragment>
          )
        })}
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="big">Lattice</div>
            <div>A control room for long-running agentic work.</div>
          </div>
        )}
      </div>
    </div>
  )
}

/** A compacted-history marker persisted as a system message in the transcript. */
function CompactionSummary({ msg }: { msg: ChatMessage }): React.JSX.Element {
  return (
    <div className="compaction-summary">
      <div className="compaction-summary-head">
        <I name="compress" size={14} /> Conversation compacted
      </div>
      <Markdown text={msg.text} />
    </div>
  )
}

/**
 * A user message. When it is still queued (composed during an active run, waiting its turn) it
 * renders with a "Queued" badge and inline edit / remove controls; those disappear the moment the
 * turn starts running and the message becomes a normal, immutable part of the transcript.
 */
function UserTurn({ msg }: { msg: ChatMessage }): React.JSX.Element {
  const dequeueMessage = useStore((s) => s.dequeueMessage)
  const editQueuedMessage = useStore((s) => s.editQueuedMessage)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(msg.text)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const queued = !!msg.queued

  const beginEdit = (): void => {
    setDraft(msg.text)
    setEditing(true)
  }

  const commit = (): void => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== msg.text) void editQueuedMessage(msg.id, next)
  }

  useEffect(() => {
    if (editing && taRef.current) {
      const ta = taRef.current
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`
    }
  }, [editing])

  return (
    <div className={`turn-user${queued ? ' queued' : ''}`}>
      {queued && (
        <div className="queued-head">
          <span className="badge">
            <I name="schedule" size={11} /> Queued
          </span>
          {!editing && (
            <div className="queued-actions">
              <button className="icon-btn" title="Edit queued message" onClick={beginEdit}>
                <I name="edit" size={14} />
              </button>
              <button
                className="icon-btn"
                title="Remove from queue"
                onClick={() => void dequeueMessage(msg.id)}
              >
                <I name="close" size={14} />
              </button>
            </div>
          )}
        </div>
      )}
      {editing ? (
        <div className="queued-edit">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              const ta = e.target
              ta.style.height = 'auto'
              ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(false)
              }
            }}
          />
          <div className="queued-edit-actions">
            <button className="mini-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="mini-btn primary" onClick={commit} disabled={!draft.trim()}>
              Save
            </button>
          </div>
        </div>
      ) : (
        msg.text
      )}
      {msg.attachments?.map((a) => (
        <div key={a.id} style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 6 }}>
          <I name="attach_file" size={13} /> {a.name}
        </div>
      ))}
    </div>
  )
}

const REDUCED_MOTION =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false

/** Reveal streamed text a few characters per frame so it flows instead of jumping in chunks. */
function useSmoothText(target: string, streaming: boolean): string {
  const smooth = streaming && !REDUCED_MOTION
  const [shown, setShown] = useState(smooth ? '' : target)
  const shownLen = useRef(smooth ? 0 : target.length)

  useEffect(() => {
    if (!smooth) {
      shownLen.current = target.length
      setShown(target)
      return
    }
    // target shrank (shouldn't for a single message) — snap back
    if (shownLen.current > target.length) {
      shownLen.current = target.length
      setShown(target.slice(0, target.length))
    }
    let cancelled = false
    let raf = 0
    const step = (): void => {
      if (cancelled) return
      const cur = shownLen.current
      if (cur < target.length) {
        const remaining = target.length - cur
        // catch-up curve: bigger gaps reveal faster, so we never fall far behind
        const inc = Math.max(2, Math.ceil(remaining / 6))
        const next = Math.min(target.length, cur + inc)
        shownLen.current = next
        setShown(target.slice(0, next))
        raf = requestAnimationFrame(step)
      }
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [target, smooth])

  return shown
}

function AssistantTurn({
  msg,
  events,
  showTelemetry
}: {
  msg: ChatMessage
  events: RunEvent[]
  showTelemetry: boolean
}): React.JSX.Element {
  const running = msg.status === undefined
  const [copied, setCopied] = useState(false)
  const elapsed = useElapsed(running, msg.createdAt)

  const errorEvent = events.find((e) => e.body.type === 'error')
  const askEvents = events.filter((event) => event.body.type.startsWith('ask.'))
  const hasReasoning = events.some((e) => e.body.type === 'reasoning.delta')

  // Reasoning and tool calls are woven into one seq-ordered timeline so the reader sees the
  // real sequence — the model thinks, that thinking block closes, then the tools it triggered
  // follow below it — instead of tools and thinking pinned to fixed slots.
  const timeline = useMemo(() => buildTimeline(events), [events])

  const smoothText = useSmoothText(msg.text, running)

  return (
    <>
      {timeline.length > 0 && <RunTimeline items={timeline} running={running} />}

      {askEvents.length > 0 && <AskLog events={askEvents} />}

      <div className="turn-assistant">
        <div className="turn-head">
          <span className="model">{msg.model}</span>
          {running && !hasReasoning && (
            <span className="work-badge">
              <I name="autorenew" size={12} className="spin" />
              Working · {formatElapsed(elapsed)}
            </span>
          )}
          {msg.status === 'interrupted' && <span style={{ color: 'var(--brass)' }}>· interrupted</span>}
        </div>

        {msg.text ? (
          <Markdown text={smoothText} />
        ) : running && !hasReasoning ? (
          <div className="working-line">
            <I name="autorenew" size={15} className="spin" />
            Working…
          </div>
        ) : null}

        {errorEvent && errorEvent.body.type === 'error' && msg.status === 'error' && (
          <div className="error-card">
            <div className="title">{categoryLabel(errorEvent.body.category)}</div>
            <div>{errorEvent.body.message}</div>
            {msg.text && (
              <div style={{ marginTop: 6, color: 'var(--text-faint)', fontSize: 12.5 }}>
                Partial output above was kept.
              </div>
            )}
          </div>
        )}

        {showTelemetry && msg.telemetry && msg.status && <Telemetry t={msg.telemetry} />}

        <div className="turn-actions">
          <button
            className="icon-btn"
            title={copied ? 'Copied' : 'Copy message'}
            onClick={() => {
              void navigator.clipboard.writeText(msg.text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
          >
            <I name={copied ? 'check' : 'content_copy'} size={14} />
          </button>
        </div>
      </div>
    </>
  )
}

/** Render the model↔user Q&A from ask_user as a compact history block in the transcript. */
function AskLog({ events }: { events: RunEvent[] }): React.JSX.Element {
  const asked = new Map<string, { question: string }>()
  const answered = new Map<string, { answer: string; canceled?: boolean }>()
  const order: string[] = []
  for (const ev of events) {
    if (ev.body.type === 'ask.requested') {
      if (!asked.has(ev.body.callId)) order.push(ev.body.callId)
      asked.set(ev.body.callId, { question: ev.body.question })
    } else if (ev.body.type === 'ask.answered') {
      answered.set(ev.body.callId, { answer: ev.body.answer, canceled: ev.body.canceled })
    }
  }
  return (
    <div className="ask-log">
      {order.map((callId) => {
        const q = asked.get(callId)
        const a = answered.get(callId)
        if (!q) return null
        return (
          <div key={callId} className="ask-log-item">
            <div className="ask-log-q">
              <I name="live_help" size={14} />
              <span>{q.question}</span>
            </div>
            {a && (
              <div className={`ask-log-a ${a.canceled ? 'canceled' : ''}`}>
                <I name={a.canceled ? 'block' : 'reply'} size={14} />
                <span>{a.canceled ? 'Dismissed without answering' : a.answer}</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function RunTimeline({ items, running }: { items: TimelineItem[]; running: boolean }): React.JSX.Element {
  return (
    <div className="run-timeline" aria-label="Run activity">
      {items.map((item, i) =>
        item.kind === 'think' ? (
          <ThinkingSegment
            key={`think-${i}`}
            text={item.text}
            fidelity={item.fidelity}
            startTs={item.startTs}
            endTs={item.endTs}
            running={running}
          />
        ) : (
          <ToolRow key={item.callId} call={item.call} />
        )
      )}
    </div>
  )
}

/**
 * A single bout of reasoning. Live, it reads "Thinking…" with a ticking timer; once it closes it
 * flips to a static "Thought for 12s" — the label itself marks the end and carries the duration,
 * so the block's position above the tool rows makes the sequence unambiguous.
 */
function ThinkingSegment({
  text,
  fidelity,
  startTs,
  endTs,
  running
}: {
  text: string
  fidelity?: ReasoningFidelity
  startTs: number
  endTs?: number
  running: boolean
}): React.JSX.Element {
  // Reasoning visibility (Settings → Appearance): 'hidden' drops the block entirely,
  // 'expanded' shows the log open by default, 'auto' keeps it collapsed until clicked.
  const reasoningVisibility = useStore((s) => s.settings?.reasoningVisibility ?? 'auto')
  const [open, setOpen] = useState(reasoningVisibility === 'expanded')
  const hasText = text.length > 0
  // Live only while the run is going AND this segment hasn't been closed by a done/tool event.
  const live = running && endTs === undefined
  const ticking = useElapsed(live, startTs)
  const durationKnown = endTs !== undefined
  const durMs = live ? ticking : durationKnown ? Math.max(0, endTs - startTs) : 0
  const label = live ? 'Thinking…' : durationKnown ? `Thought for ${formatElapsed(durMs)}` : 'Thought'

  // Kept after the hooks above so hook order stays stable across renders.
  if (reasoningVisibility === 'hidden') return <></>

  return (
    <div className={`thinking-card ${live ? 'live' : 'done'}`}>
      <div
        className={`thinking-head ${!hasText ? 'no-toggle' : ''}`}
        role={hasText ? 'button' : undefined}
        tabIndex={hasText ? 0 : undefined}
        aria-expanded={hasText ? open : undefined}
        onClick={hasText ? () => setOpen((v) => !v) : undefined}
        onKeyDown={
          hasText
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setOpen((v) => !v)
                }
              }
            : undefined
        }
      >
        <I name={live ? 'autorenew' : 'neurology'} size={14} className={live ? 'spin' : ''} />
        <span className="label">{label}</span>
        {live && <span className="thinking-elapsed">{formatElapsed(durMs)}</span>}
        {!live && fidelity && <span className="fidelity-badge">{fidelity}</span>}
        {hasText && <I name={open ? 'expand_less' : 'expand_more'} size={16} className="chev" />}
      </div>
      {open && hasText && (
        <div className="thinking-log">
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}

/** Split "mcp__server__tool" into a server tag and bare tool name; leave builtins as-is. */
function prettyTool(name: string): { label: string; server?: string } {
  const m = name.match(/^mcp__(.+?)__(.+)$/)
  if (m) return { label: m[2]!, server: m[1] }
  return { label: name }
}

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

function ToolRow({ call }: { call: ToolCall }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const setUi = useStore((s) => s.setUi)
  const { label, server } = prettyTool(call.tool)
  const argsText = pretty(call.args)
  const resultText = call.reason ? call.reason : pretty(call.result)
  const canExpand = !!(argsText || resultText)
  const diff = fileDiffFor(call)

  return (
    <div className={`tool-activity-row ${call.status} ${open ? 'open' : ''}`}>
      <button className="tool-row-head" onClick={() => canExpand && setOpen((v) => !v)} disabled={!canExpand}>
        <I
          name={call.status === 'running' ? 'autorenew' : call.ok === false || call.status === 'blocked' ? 'error' : 'build'}
          size={14}
          className={call.status === 'running' ? 'spin' : ''}
        />
        {server && <span className="tool-server">{server}</span>}
        <span className="tool-name">{label}</span>
        {!!call.args && typeof call.args === 'object' && !diff && (
          <span className="tool-args-inline">{clip(compactArgs(call.args), 60)}</span>
        )}
        <span className="tool-status">{call.status}</span>
        {call.durationMs !== undefined && <span className="tool-duration">{call.durationMs}ms</span>}
        {canExpand && <I name={open ? 'expand_less' : 'expand_more'} size={14} className="tool-chev" />}
      </button>
      {/* A file mutation shows its +/− diff inline, like a desktop diff viewer. Clicking it also
          pops the inspector open on the run log, where the change is recorded in context. */}
      {diff && (
        <FileDiff
          path={diff.path}
          before={diff.before}
          after={diff.after}
          kind={diff.kind}
          onActivate={() => setUi({ inspectorOpen: true, inspectorTab: 'run' })}
        />
      )}
      {open && (
        <div className="tool-detail">
          {argsText && (
            <>
              <div className="tool-detail-label">Arguments</div>
              <pre>{clip(argsText)}</pre>
            </>
          )}
          {resultText && (
            <>
              <div className="tool-detail-label">{call.reason ? 'Reason' : 'Result'}</div>
              <pre>{clip(resultText)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Extract before/after text for file-mutating tools so the row can render a diff. */
function fileDiffFor(
  call: ToolCall
): { path: string; before: string; after: string; kind: 'edit' | 'write' } | null {
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

/** One-line "key=value" preview of an args object for the collapsed row. */
function compactArgs(args: object): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
}

function Telemetry({ t }: { t: TurnTelemetry }): React.JSX.Element {
  const est = t.estimated ? '~' : ''
  const chips: { icon: string; label: string; title?: string; tone?: 'write' }[] = []
  if (t.tps) chips.push({ icon: 'speed', label: `${t.tps} tok/s` })
  if (t.ttftMs !== undefined) chips.push({ icon: 'timer', label: `${(t.ttftMs / 1000).toFixed(1)}s TTFT` })
  if (t.wallMs !== undefined)
    chips.push({
      icon: 'schedule',
      label: t.wallMs >= 60000 ? formatElapsed(t.wallMs) : `${(t.wallMs / 1000).toFixed(1)}s`,
      title: 'Total wall-clock time for this run'
    })
  if (t.tokensOut !== undefined) chips.push({ icon: 'tag', label: `${est}${fmtTokens(t.tokensOut)} out` })
  if (t.tokensReasoning) chips.push({ icon: 'neurology', label: `${fmtTokens(t.tokensReasoning)} think` })
  // Cache activity. A read means the stable prefix was reused (the win); a write with no read
  // is a cold/priming turn whose benefit lands next turn. We never render a bare "0% cached":
  // when the backend reports zero reads and no write, there was simply no cache activity to show.
  if (t.cacheReadTokens && t.tokensIn) {
    const pct = Math.round((t.cacheReadTokens / t.tokensIn) * 100)
    chips.push({
      icon: 'memory',
      label: `${pct}% cached`,
      title: `${fmtTokens(t.cacheReadTokens)} of ${fmtTokens(t.tokensIn)} input tokens served from cache`
    })
  } else if (t.cacheWriteTokens) {
    chips.push({
      icon: 'memory',
      tone: 'write',
      label: `${fmtTokens(t.cacheWriteTokens)} primed`,
      title: `${fmtTokens(t.cacheWriteTokens)} tokens written to the prompt cache; reused on the next turn`
    })
  }
  if (t.costUsd !== undefined) chips.push({ icon: 'paid', label: `$${t.costUsd.toFixed(4)}` })
  return (
    <div className="turn-telemetry">
      {chips.map((c, i) => (
        <span key={i} className={c.tone === 'write' ? 'tchip tchip-write' : 'tchip'} title={c.title}>
          <I name={c.icon} size={12} />
          {c.label}
        </span>
      ))}
    </div>
  )
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    auth: 'Authentication failed',
    rate_limit: 'Rate limited',
    provider_unavailable: 'Provider unavailable',
    route_failure: 'Route failed',
    context_overflow: 'Context overflow',
    unsupported_param: 'Unsupported parameter',
    malformed_stream: 'Malformed stream',
    tool_failure: 'Tool failed',
    permission_denied: 'Permission denied',
    process_crash: 'Process crashed',
    browser_failure: 'Browser failure',
    canceled: 'Canceled',
    unknown: 'Something went wrong'
  }
  return labels[cat] ?? 'Error'
}
