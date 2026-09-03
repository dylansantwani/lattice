import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, RunEvent, TurnTelemetry } from '@shared/types'
import { computeCost, resolveCostRates } from '@shared/cost'
import { useStore } from '@/state/store'
import { Markdown } from './Markdown'
import { fmtTokens } from './ContextOrbit'
import { useElapsed, formatElapsed } from './useElapsed'
import { bufferedByPipe } from '@shared/commandHints'
import { toolDetailView } from './toolResultView'
import { I } from './Icon'
import { FileDiff } from './Diff'
import {
  incomingCollapsedByDefault,
  incomingDisplayText,
  incomingPreview,
  incomingSizeHint
} from './incomingDisplay'
import {
  buildTimeline,
  draftPreviewFor,
  eventsForSegment,
  findResultImages,
  groupTimeline,
  isDelegationCall,
  type TimelineItem,
  type ToolCall,
  type ToolItem
} from './runTimeline'
import { SubagentCard } from './SubagentCard'

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
      // Subagent events share the parent's runId (tagged with an `agent` id). Keep them out of
      // the parent bubble's timeline — otherwise a subagent's tool calls and reasoning render
      // inline as if the main model did them. Subagents have their own Inspector tab.
      if (ev.agent) continue
      const list = map.get(ev.runId) ?? []
      list.push(ev)
      map.set(ev.runId, list)
    }
    return map
  }, [events])

  // Every assistant segment's createdAt, grouped by runId. A steer splits a run into multiple
  // assistant messages that share one runId (see splitAssistantSegment); these boundaries let each
  // segment claim only its own slice of the run's events instead of the whole run (eventsForSegment).
  const segmentStartsByRun = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.runId) continue
      const list = map.get(m.runId) ?? []
      list.push(m.createdAt)
      map.set(m.runId, list)
    }
    return map
  }, [messages])

  // Messages the user injected into a live run as a steer, keyed by id. A `steer.injected`
  // event is emitted for each, so the badge survives reloads without a schema change.
  const steeredIds = useMemo(() => {
    const set = new Set<string>()
    for (const ev of events) {
      if (ev.body.type === 'steer.injected') set.add(ev.body.messageId)
    }
    return set
  }, [events])

  return (
    <div className="transcript" ref={scroller} onScroll={onScroll}>
      <div className="turns">
        {messages.map((msg) => {
          if (msg.role === 'system') return <CompactionSummary key={msg.id} msg={msg} />
          const turn =
            msg.role === 'user' ? (
              msg.origin ? <IncomingTurn msg={msg} /> : <UserTurn msg={msg} steered={steeredIds.has(msg.id)} />
            ) : (
              <AssistantTurn
                msg={msg}
                events={
                  msg.runId
                    ? eventsForSegment(
                        eventsByRun.get(msg.runId) ?? [],
                        segmentStartsByRun.get(msg.runId) ?? [msg.createdAt],
                        msg.createdAt
                      )
                    : []
                }
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

/**
 * A compaction summary — a `system`-role message inserted when the thread's history is folded
 * down (via `/compact` or an auto-compaction). The folded originals stay in the transcript above,
 * dimmed; this card stands in for them as the live context the model actually sees.
 */
function CompactionSummary({ msg }: { msg: ChatMessage }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="compaction-summary">
      <button
        className="compaction-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? 'Hide summary' : 'Show summary'}
      >
        <I name="compress" size={14} />
        <span className="compaction-label">Context compacted</span>
        <span className="compaction-hint">
          {open ? 'Hide summary' : 'Show summary'}
        </span>
        <I name={open ? 'expand_less' : 'expand_more'} size={16} />
      </button>
      {open && (
        <div className="compaction-body">
          <Markdown text={msg.text} />
        </div>
      )}
    </div>
  )
}

/**
 * A user message. When it is still queued (composed during an active run, waiting its turn) it
 * renders with a "Queued" badge and inline edit / remove controls; those disappear the moment the
 * turn starts running and the message becomes a normal, immutable part of the transcript.
 */
function UserTurn({ msg, steered }: { msg: ChatMessage; steered?: boolean }): React.JSX.Element {
  const dequeueMessage = useStore((s) => s.dequeueMessage)
  const editQueuedMessage = useStore((s) => s.editQueuedMessage)
  const steerQueuedMessage = useStore((s) => s.steerQueuedMessage)
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
    <div className={`turn-user${queued ? ' queued' : ''}${steered ? ' steered' : ''}`}>
      {steered && !queued && (
        <div className="steer-head">
          <span className="badge steer" title="Sent mid-run and folded into the turn in progress">
            <I name="alt_route" size={11} /> Steered
          </span>
        </div>
      )}
      {queued && (
        <div className="queued-head">
          <span className="badge">
            <I name="schedule" size={11} /> Queued
          </span>
          {!editing && (
            <div className="queued-actions">
              <button
                className="icon-btn steer-now"
                title="Send now — interrupt the reply in progress and fold this in as a steer"
                onClick={() => void steerQueuedMessage(msg.id)}
              >
                <I name="alt_route" size={14} />
              </button>
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

/**
 * A user-role turn delivered by another session or subagent. It is deliberately a distinct card:
 * the model needs ordinary user-role context, but the person reading the transcript should never
 * mistake an automated message or completion for something they typed themselves.
 */
function IncomingTurn({ msg }: { msg: ChatMessage }): React.JSX.Element {
  const origin = msg.origin!
  const kindLabel =
    origin.kind === 'agent' ? 'Subagent' : origin.kind === 'shell' ? 'Background command' : 'Session'
  const kindIcon =
    origin.kind === 'agent' ? 'smart_toy' : origin.kind === 'shell' ? 'terminal' : 'forum'
  const text = useMemo(() => incomingDisplayText(msg.text), [msg.text])
  // Long results arrive folded so they never shove the conversation off-screen the moment they
  // land; the header carries a one-line preview and the reader opens the full body on demand.
  const foldable = useMemo(() => incomingCollapsedByDefault(text), [text])
  const [open, setOpen] = useState(!foldable)
  const preview = useMemo(() => (foldable ? incomingPreview(text) : ''), [foldable, text])
  const attachments = msg.attachments?.map((a) => (
    <div key={a.id} className="incoming-attachment">
      <I name="attach_file" size={13} /> {a.name}
    </div>
  ))
  const head = (
    <>
      <span className="incoming-sender">
        <I name={kindIcon} size={14} />
        From {origin.label}
      </span>
      <span className="incoming-kind">{kindLabel}</span>
    </>
  )
  return (
    <div className={`turn-incoming ${origin.kind}${open ? '' : ' folded'}`}>
      {foldable ? (
        <button
          className="incoming-head incoming-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? 'Collapse' : 'Expand'}
        >
          {head}
          {!open && <span className="incoming-preview">{preview}</span>}
          <span className="incoming-hint">{open ? 'Collapse' : incomingSizeHint(text)}</span>
          <I name={open ? 'expand_less' : 'expand_more'} size={16} />
        </button>
      ) : (
        <div className="incoming-head">{head}</div>
      )}
      {open && (
        <>
          <Markdown text={text} />
          {attachments}
        </>
      )}
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

  // Subagent events share the parent run's id but carry an `agent` tag. They belong to the
  // live agents panel (the inspector), not the center transcript — so the main turn only ever
  // renders its own reasoning, tools, and delegation rows, never a subagent's inner work.
  const mainEvents = useMemo(() => events.filter((e) => !e.agent), [events])

  const errorEvent = mainEvents.find((e) => e.body.type === 'error')
  const askEvents = mainEvents.filter((event) => event.body.type.startsWith('ask.'))
  const hasReasoning = mainEvents.some((e) => e.body.type === 'reasoning.delta')

  // Reasoning, spoken output, and tool calls are woven into one seq-ordered timeline so the reader
  // sees the real sequence — think → speak → call a tool → think → speak — instead of every spoken
  // passage collapsing into a single block pinned at the bottom of the turn. Each spoken passage
  // renders as its own model-name bubble (see OutputSegment) at the point it was said.
  const timeline = useMemo(() => buildTimeline(mainEvents), [mainEvents])
  const committedOutputChars = useMemo(
    () => timeline.reduce((n, i) => (i.kind === 'output' ? n + i.text.length : n), 0),
    [timeline]
  )
  // Whether the model's spoken output is (or is about to be) attributed in its own timeline bubble —
  // either committed output events, or a live streaming tail that hasn't flushed to events yet. When
  // true the footer omits the model name and any fallback text, since an output bubble already
  // carries them.
  const outputShown = committedOutputChars > 0 || (running && msg.text.length > committedOutputChars)

  const hasErrorCard = !!errorEvent && errorEvent.body.type === 'error' && msg.status === 'error'
  // Legacy fallback: a completed turn with no output events (rows persisted before output was woven
  // into the timeline) still shows its text, in the footer. A live turn never hits this path — its
  // streaming tail renders as an output bubble in the timeline above.
  const bubbleText = !running && !outputShown ? msg.text : ''
  const smoothBubbleText = useSmoothText(bubbleText, false)

  const interrupted = msg.status === 'interrupted'
  // A failed reply (interrupted mid-stream, or an error) gets a Retry that re-runs its turn — but
  // only while it is still the thread's last reply; anything later would make a rewrite of history.
  const retryTurn = useStore((s) => s.retryTurn)
  const setEffort = useStore((s) => s.setEffort)
  const setUi = useStore((s) => s.setUi)
  const threadEffort = useStore((s) => s.threads.find((t) => t.id === s.activeThreadId)?.effort)
  const isLastMessage = useStore((s) => s.messages[s.messages.length - 1]?.id === msg.id)
  const canRetry = !running && (interrupted || msg.status === 'error') && isLastMessage
  // The two output-shaped failures — an empty reply (the model spent its whole budget thinking) and
  // a reply cut off at the output limit — have a one-click fix each, offered right on the row.
  const errorCategory = errorEvent?.body.type === 'error' ? errorEvent.body.category : undefined
  const outputShaped = errorCategory === 'malformed_stream' || errorCategory === 'truncated_output'
  const thinkingOn = !!threadEffort && threadEffort !== 'off' && threadEffort !== 'none'
  // The footer carries per-turn chrome that isn't part of the spoken flow: telemetry, the copy
  // action, error, and — only when no output bubble already named the model — its name. It settles
  // in once the turn is done (or errors); while a turn runs, the woven timeline is the live view.
  const showFooter = hasErrorCard || (!running && (!!msg.text || !!msg.telemetry))
  const showFooterHead = !outputShown || interrupted

  return (
    <>
      {timeline.length > 0 && (
        <RunTimeline items={timeline} running={running} fullText={msg.text} model={msg.model} />
      )}

      {askEvents.length > 0 && <AskLog events={askEvents} />}

      {/* Pre-output moment: a run has started but there's no reasoning, no tools, and no text yet.
          A lightweight standalone indicator keeps the start of a turn from being dead air, without
          committing to the full model-name bubble. */}
      {running && !hasReasoning && timeline.length === 0 && !msg.text && (
        <div className="working-line pending">
          <I name="autorenew" size={15} className="spin" />
          Working…
        </div>
      )}

      {showFooter && (
      <div className="turn-assistant turn-footer">
        {showFooterHead && (
          <div className="turn-head">
            {!outputShown && <span className="model">{msg.model}</span>}
            {interrupted && <span style={{ color: 'var(--brass)' }}>· interrupted</span>}
          </div>
        )}

        {bubbleText ? <Markdown text={smoothBubbleText} /> : null}

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

        {showTelemetry && msg.telemetry && msg.status && <Telemetry t={msg.telemetry} model={msg.model} />}

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
      )}

      {canRetry && (
        <div className="turn-retry-row" role="status">
          <I name={interrupted ? 'do_not_disturb_on' : 'error'} size={14} />
          <span>{interrupted ? 'This reply was interrupted.' : 'This reply failed.'}</span>
          <button className="btn turn-retry-btn" onClick={() => void retryTurn(msg.id)} title="Run this turn again">
            <I name="replay" size={14} />
            Retry
          </button>
          {outputShaped && thinkingOn && (
            <button
              className="btn turn-retry-btn"
              onClick={() => {
                void setEffort('off').then(() => retryTurn(msg.id))
              }}
              title="Turn thinking off for this chat and run the turn again"
            >
              <I name="neurology" size={14} />
              Retry without thinking
            </button>
          )}
          {outputShaped && (
            <button
              className="btn turn-retry-btn"
              onClick={() => setUi({ settingsOpen: true })}
              title="Raise the max output tokens in Settings → Model"
            >
              <I name="tune" size={14} />
              Output limit…
            </button>
          )}
        </div>
      )}
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
  // The last output block is the one still streaming while the run is live. Its event-sourced text
  // lags the message body (events are coalesced ~750ms; msg.text flushes ~80ms), so we render its
  // fresh tail straight from fullText, sliced past the characters already shown in earlier output
  // blocks. Earlier, closed blocks render their own settled text. We track it by identity (not
  // index) because grouping consecutive tool calls collapses several items into one node.
  let lastOutput: Extract<TimelineItem, { kind: 'output' }> | undefined
  for (const it of items) if (it.kind === 'output') lastOutput = it

  // Fold back-to-back tool calls into one expandable group so a burst of calls reads as a single
  // block; interleaved thinking/output still breaks a run, and a lone call stays a plain row.
  const nodes = groupTimeline(items)

  let outputChars = 0
  const rows = nodes.map((item, i) => {
    if (item.kind === 'think') {
      return (
        <ThinkingSegment
          key={`think-${i}`}
          text={item.text}
          startTs={item.startTs}
          endTs={item.endTs}
          durationMs={item.durationMs}
          running={running}
        />
      )
    }
    if (item.kind === 'tool') {
      // A delegation is the subagent it spawned, not a tool call: it gets a card that shows who the
      // agent is, what it is doing live, and its report — never a bare "run_agent · running" row.
      if (isDelegationCall(item)) {
        return <SubagentCard key={item.callId} callId={item.callId} call={item.call} live={running} />
      }
      return <ToolRow key={item.callId} call={item.call} live={running} />
    }
    if (item.kind === 'tool-group') {
      // The last node in the woven timeline is still ambiguous while the turn is live: the model
      // may be mid-thought on another call whose event just hasn't landed yet. Only a group that's
      // been superseded by later activity (more output, more tools) is unambiguously finished.
      const isLast = i === nodes.length - 1
      return (
        <ToolGroupRow key={`tg-${item.calls[0]!.callId}`} calls={item.calls} live={running} pending={isLast && running} />
      )
    }
    if (item.kind === 'notice') {
      // A run-loop self-recovery (retry event): a quiet inline row so the extra round is legible.
      return (
        <div key={`notice-${i}`} className="timeline-notice" role="note">
          <span className="timeline-notice-icon" aria-hidden>
            ↻
          </span>
          {item.text}
        </div>
      )
    }
    const live = running && item === lastOutput && item.endTs === undefined
    const start = outputChars
    outputChars += item.text.length
    return (
      <OutputSegment
        key={`out-${i}`}
        model={model}
        text={live ? fullText.slice(start) : item.text}
        live={live}
      />
    )
  })

  // Freshly-started output whose first delta event hasn't flushed yet: the message body already has
  // the characters but no output block exists to hold them. Show them live at the end so the start
  // of a spoken passage isn't dead air. (Skipped when the last output block is still open — it
  // already renders the live tail above.)
  const lastOpen = lastOutput?.endTs === undefined && lastOutput !== undefined
  const trailing =
    running && !lastOpen && fullText.length > outputChars ? (
      <OutputSegment key="out-live" model={model} text={fullText.slice(outputChars)} live />
    ) : null

  return (
    <div className="run-timeline" aria-label="Run activity">
      {rows}
      {trailing}
    </div>
  )
}

/**
 * One spoken passage from the model, rendered as its own assistant bubble (model name over the
 * text) at the position in the run where it was said — so a turn that alternates speaking and tool
 * calls shows each passage attributed to the model, rather than collapsing them into one block.
 * The live (still-streaming) block reveals its text a few characters per frame and flags itself as
 * generating; closed blocks render their settled text immediately.
 */
function OutputSegment({
  model,
  text,
  live
}: {
  model?: string
  text: string
  live: boolean
}): React.JSX.Element {
  const shown = useSmoothText(text, live)
  return (
    <div className="turn-assistant output-turn">
      <div className="turn-head">
        {model && <span className="model">{model}</span>}
        {live && (
          <span className="work-badge">
            <I name="autorenew" size={12} className="spin" />
            Generating…
          </span>
        )}
      </div>
      <Markdown text={live ? shown : text} />
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
  startTs,
  endTs,
  durationMs,
  running
}: {
  text: string
  startTs: number
  endTs?: number
  durationMs?: number
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
  // Prefer the run loop's measured span; fall back to endTs − startTs only for events that predate it.
  const durationKnown = durationMs !== undefined || endTs !== undefined
  const settledMs = durationMs ?? (endTs !== undefined ? Math.max(0, endTs - startTs) : 0)
  const durMs = live ? ticking : settledMs
  const label = live ? 'Thinking…' : durationKnown ? `Thought for ${formatElapsed(durMs)}` : 'Thought'
  const shown = useSmoothText(text, live && open)

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
        {hasText && <I name={open ? 'expand_less' : 'expand_more'} size={16} className="chev" />}
      </div>
      {open && hasText && (
        <div className="thinking-log">
          <Markdown text={live ? shown : text} />
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

/** Deduped "fs_read ×3, shell, fs_edit" summary of a group's tool names for the collapsed header. */
function summarizeTools(calls: ToolItem[]): string {
  const counts = new Map<string, number>()
  for (const c of calls) {
    // A command with a purpose is listed by that purpose, not as another anonymous "shell".
    const args = c.call.args && typeof c.call.args === 'object' && !Array.isArray(c.call.args) ? (c.call.args as Record<string, unknown>) : undefined
    const purpose = typeof args?.purpose === 'string' ? args.purpose.trim() : ''
    const label = purpose || prettyTool(c.call.tool).label
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(', ')
}

/**
 * A run of consecutive tool calls, compacted into one row. Collapsed, it shows the count, a deduped
 * summary of the tools involved, and an aggregate status (with live progress while the run is going);
 * expanded, it reveals each call as its own full ToolRow. Any failure or block tints the whole group
 * so a problem in the batch is never hidden behind the fold.
 */
function ToolGroupRow({
  calls,
  live,
  pending
}: {
  calls: ToolItem[]
  live: boolean
  /** This group is the last thing in the timeline and the turn is still live — even once every
   *  known call has resolved, the model may already be drafting the next one whose events just
   *  haven't landed yet. Keeps the header spinning through that gap instead of flashing "complete". */
  pending?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const records = calls.map((c) => c.call)
  const draft = live
    ? calls
        .filter((c) => c.call.status === 'requested')
        .map((c) => draftPreviewFor(c.call))
        .find((preview) => preview !== null) ?? null
    : null
  const done = records.filter((c) => c.status === 'complete' || c.status === 'failed' || c.status === 'blocked')
  const anyActive = records.some((c) => c.status === 'running' || c.status === 'requested')
  const running = live && (anyActive || !!pending)
  const bad = records.some((c) => c.ok === false || c.status === 'blocked' || c.status === 'failed')
  const status = running ? 'running' : bad ? 'failed' : 'complete'
  const totalMs = records.reduce((n, c) => n + (c.durationMs ?? 0), 0)
  const statusText = running
    ? anyActive
      ? `${done.length}/${records.length} done`
      : 'working…'
    : bad
      ? `${records.filter((c) => c.ok === false || c.status === 'blocked' || c.status === 'failed').length} failed`
      : 'complete'

  return (
    <div className={`tool-group ${status} ${open ? 'open' : ''}`}>
      <button className="tool-row-head tool-group-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <I name={running ? 'autorenew' : bad ? 'error' : 'build'} size={14} className={running ? 'spin' : ''} />
        <span className="tool-name">{records.length} tool calls</span>
        {/* Keyed on the live label so a change in the active call re-mounts the span and replays
            the swap animation — the group visibly "moves on" from one call to the next. */}
        <span
          key={draft ? `${draft.label}:${draft.target ?? ''}` : 'summary'}
          className={`tool-args-inline tool-group-live${draft ? ' tool-group-draft' : ''}`}
        >
          {draft ? `${draft.label}: ${draft.text || draft.target || '…'}` : summarizeTools(calls)}
        </span>
        <span className="tool-status">{statusText}</span>
        {!running && totalMs > 0 && <span className="tool-duration">{totalMs}ms</span>}
        <I name={open ? 'expand_less' : 'expand_more'} size={14} className="tool-chev" />
      </button>
      {open && (
        <div className="tool-group-body">
          {calls.map((c) => (
            <ToolRow key={c.callId} call={c.call} live={live} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolRow({ call, live }: { call: ToolCall; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const setUi = useStore((s) => s.setUi)
  const { label, server } = prettyTool(call.tool)
  const argsText = pretty(call.args)
  const resultText = call.reason ? call.reason : pretty(call.result)
  // The model's own label for a command ("Benchmark the 3 hosts") leads the row; the tool name dims.
  const argsRecord = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? (call.args as Record<string, unknown>) : undefined
  const purpose = typeof argsRecord?.purpose === 'string' ? argsRecord.purpose.trim() : ''
  // Live output: a running foreground command streams its buffer (tool.progress); a background or
  // promoted job is looked up in the thread's jobs by the id in this call's result.
  const resultRecord = call.result && typeof call.result === 'object' && !Array.isArray(call.result) ? (call.result as Record<string, unknown>) : undefined
  const jobId = typeof resultRecord?.jobId === 'string' ? resultRecord.jobId : undefined
  const job = useStore((s) => (jobId ? s.jobs.find((j) => j.id === jobId) : undefined))
  const liveOutput = call.status === 'running' && live ? call.liveOutput : job?.running ? job.output : undefined
  const liveTail = liveOutput ? liveOutput.split('\n').slice(-60).join('\n').trimEnd() : ''
  const canExpand = !!(argsText || resultText || liveOutput)
  // A job row's time is the job's, not the 1 ms it took to start it: tick while it runs, then its span.
  const jobStartedAt = typeof resultRecord?.startedAt === 'number' ? (resultRecord.startedAt as number) : job?.startedAt
  const jobTicking = useElapsed(!!job?.running, jobStartedAt)
  const jobSpanMs = job ? (job.running ? jobTicking : (job.endedAt ?? job.startedAt) - job.startedAt) : undefined
  const commandText = typeof argsRecord?.command === 'string' ? argsRecord.command : ''
  const bufferedBy = !liveTail && commandText ? bufferedByPipe(commandText) : null
  const diff = fileDiffFor(call)
  const images =
    call.status === 'complete' && call.ok !== false ? findResultImages(call.result) : []
  // A call still "running" once the run is no longer live never got its result — the run was
  // interrupted (e.g. the app quit mid-call). Show it as interrupted rather than spinning forever.
  const status = call.status === 'running' && !live ? 'interrupted' : call.status
  const spinning = status === 'running'
  // A proposed-but-not-yet-started call while the run is live: the model has drafted this call and
  // it is about to be submitted (or is waiting on approval). Keep the pulse as a fallback, but show
  // the meaningful argument as soon as its partial JSON contains one.
  const drafting = status === 'requested' && live
  const draftPreview = drafting ? draftPreviewFor(call) : null
  const draftStatus = draftPreview ? draftPreview.label.toLowerCase() : 'preparing'

  return (
    <div className={`tool-activity-row ${status} ${drafting ? 'drafting' : ''} ${open ? 'open' : ''}`}>
      <button className="tool-row-head" onClick={() => canExpand && setOpen((v) => !v)} disabled={!canExpand}>
        <I
          name={drafting ? 'more_horiz' : spinning ? 'autorenew' : call.ok === false || status === 'blocked' ? 'error' : status === 'interrupted' ? 'do_not_disturb_on' : 'build'}
          size={14}
          className={spinning ? 'spin' : drafting ? 'pulse' : ''}
        />
        {server && <span className="tool-server">{server}</span>}
        {/* A command's purpose IS its name; the tool ("shell") becomes a dim chip after it. */}
        <span className={purpose ? 'tool-name tool-purpose' : 'tool-name'} title={purpose ? `${purpose} — ${label}` : undefined}>
          {purpose || label}
        </span>
        {purpose && <span className="tool-kind-chip">{label}</span>}
        {/* The args used to preview inline here as grey key=value text; it was redundant with the
            expandable detail below, so the row now stays clean and the user opens it to see args. */}
        <span className="tool-status">
          {drafting ? draftStatus : liveOutput !== undefined ? (job?.running ? 'running in background' : 'running · live') : status}
        </span>
        {jobSpanMs !== undefined ? (
          <span className="tool-duration" title={job?.running ? 'Running for' : 'Ran for'}>
            {formatElapsed(jobSpanMs)}
          </span>
        ) : (
          call.durationMs !== undefined && <span className="tool-duration">{call.durationMs}ms</span>
        )}
        {canExpand && <I name={open ? 'expand_less' : 'expand_more'} size={14} className="tool-chev" />}
      </button>
      {draftPreview && (
        <div className="tool-draft-preview" aria-live="polite">
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
          {draftPreview.text && <pre>{clip(draftPreview.text, 3200)}</pre>}
        </div>
      )}
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
      {images.length > 0 && (
        <div className="tool-result-images">
          {images.map((img, i) => (
            <ResultImage key={i} url={img.url} caption={img.caption} />
          ))}
        </div>
      )}
      {/* A running command's output streams inline, like a file edit's diff — no click needed. It
          folds away once the command finishes (the full output then lives in the Result below). */}
      {liveOutput !== undefined && (
        <div className="tool-live-output inline" aria-live="polite">
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
      {open && <ToolDetail call={call} argsText={argsText} />}
    </div>
  )
}

/**
 * The expanded body of a tool row. Known tools get a readable shape (a command line, an output
 * block with an exit chip, one status line per job or agent) via `toolDetailView`; the prose the
 * runtime addresses to the model is kept behind a "note to the model" disclosure; anything else
 * falls back to the raw arguments/result JSON.
 */
function ToolDetail({ call, argsText }: { call: ToolCall; argsText: string }): React.JSX.Element {
  const [rawOpen, setRawOpen] = useState(false)
  const view = useMemo(() => toolDetailView(call.tool, call.args, call.result, call.reason), [call.tool, call.args, call.result, call.reason])
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
      <img
        src={url}
        alt={caption ?? 'Image from tool call'}
        className={expanded ? 'expanded' : ''}
        onClick={() => setExpanded((v) => !v)}
      />
      {caption && <div className="tool-result-image-caption">{caption}</div>}
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

function Telemetry({ t, model }: { t: TurnTelemetry; model?: string }): React.JSX.Element {
  const models = useStore((s) => s.models)
  const overrides = useStore((s) => s.settings?.costOverrides)
  const setUi = useStore((s) => s.setUi)
  const est = t.estimated ? '~' : ''
  const chips: { icon: string; label: string; title?: string; tone?: 'write'; onClick?: () => void }[] = []
  if (t.tps) chips.push({ icon: 'speed', label: `${t.tps} tok/s` })
  // Cache activity, right beside throughput — the two numbers explain each other (a warm prefix
  // is why a turn started fast/cheap). A read means the stable prefix was reused (the win); a
  // write with no read is a cold/priming turn whose benefit lands next turn. We never render a
  // bare "0% cached": zero reads and no write means there was no cache activity to show.
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
  if (t.ttftMs !== undefined) chips.push({ icon: 'timer', label: `${(t.ttftMs / 1000).toFixed(1)}s TTFT` })
  if (t.wallMs !== undefined)
    chips.push({
      icon: 'schedule',
      label: t.wallMs >= 60000 ? formatElapsed(t.wallMs) : `${(t.wallMs / 1000).toFixed(1)}s`,
      title: 'Total wall-clock time for this run'
    })
  if (t.tokensOut !== undefined) chips.push({ icon: 'tag', label: `${est}${fmtTokens(t.tokensOut)} out` })
  if (t.tokensReasoning) chips.push({ icon: 'neurology', label: `${fmtTokens(t.tokensReasoning)} think` })
  if (t.costUsd !== undefined) {
    // Provider-reported (authoritative) — exact, not editable.
    chips.push({ icon: 'paid', label: `$${t.costUsd.toFixed(4)}` })
  } else {
    // No billed cost — price it locally from the user's override (exact) or list price (estimated),
    // and let the chip open the cost editor for this route.
    const resolved = resolveCostRates(model, models, overrides)
    if (resolved) {
      const cached = (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0)
      const reasoning = t.tokensReasoning ?? 0
      const cost = computeCost(resolved.rates, {
        freshInput: Math.max(0, (t.tokensIn ?? 0) - cached),
        cachedInput: cached,
        output: Math.max(0, (t.tokensOut ?? 0) - reasoning),
        reasoning
      })
      if (cost > 0) {
        chips.push({
          icon: 'paid',
          label: `$${cost.toFixed(4)}`,
          title: resolved.estimated
            ? 'Estimated from list price — click to set your own rates and make it exact'
            : 'From your cost override — click to edit',
          onClick: model ? () => setUi({ costEditorModel: model }) : undefined
        })
      }
    }
  }
  return (
    <div className="turn-telemetry">
      {chips.map((c, i) => {
        const cls = c.tone === 'write' ? 'tchip tchip-write' : 'tchip'
        return c.onClick ? (
          <button key={i} type="button" className={`${cls} tchip-btn`} title={c.title} onClick={c.onClick}>
            <I name={c.icon} size={12} />
            {c.label}
          </button>
        ) : (
          <span key={i} className={cls} title={c.title}>
            <I name={c.icon} size={12} />
            {c.label}
          </span>
        )
      })}
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
    truncated_output: 'Reply truncated',
    tool_failure: 'Tool failed',
    permission_denied: 'Permission denied',
    process_crash: 'Process crashed',
    browser_failure: 'Browser failure',
    canceled: 'Canceled',
    unknown: 'Something went wrong'
  }
  return labels[cat] ?? 'Error'
}
