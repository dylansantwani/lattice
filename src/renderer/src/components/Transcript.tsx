import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ChatMessage, RunEvent, TurnTelemetry } from '@shared/types'
import { computeCost, resolveCostRates } from '@shared/cost'
import { useStore } from '@/state/store'
import { Markdown } from './Markdown'
import { I } from './Icon'
import {
  incomingCollapsedByDefault,
  incomingDisplayText,
  incomingPreview,
  incomingSizeHint
} from './incomingDisplay'
import { buildTimeline, eventsForSegment } from './runTimeline'
import { flowOf, shortModel, turnStats } from './turnFlow'
import { RunTimeline } from './TurnActivity'
import { recoveryPlan } from './retryView'
import { isSilentReply } from '@shared/view/silentReply'
import { getSpeaker } from '@/speech/speaker'
import { useSpeakingStatus } from '@/speech/useSpeech'


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

  // Group each run's own (non-subagent) events, and — crucially — keep the SAME array reference for
  // any run whose slice is unchanged since the last render. A streamed delta lands on exactly one
  // run, so every settled turn keeps a stable `runEvents` prop and its memoized <AssistantTurn> skips
  // re-rendering while another run streams. Before this, the map rebuilt fresh on every token, handing
  // every turn a new array, so all 200+ turns reconciled on each streamed delta.
  const byRunCache = useRef(new Map<string, RunEvent[]>())
  const eventsByRun = useMemo(() => {
    const next = new Map<string, RunEvent[]>()
    for (const ev of events) {
      // Subagent events share the parent's runId (tagged with an `agent` id). Keep them out of
      // the parent bubble's timeline — otherwise a subagent's tool calls and reasoning render
      // inline as if the main model did them. Subagents have their own Inspector tab.
      if (ev.agent) continue
      const list = next.get(ev.runId)
      if (list) list.push(ev)
      else next.set(ev.runId, [ev])
    }
    // Reuse the prior array for any run whose slice didn't change (same length + same tail event), so
    // its consumer keeps a stable prop identity and the turn's memo holds.
    const prev = byRunCache.current
    for (const [runId, list] of next) {
      const old = prev.get(runId)
      if (old && old.length === list.length && old[old.length - 1]?.id === list[list.length - 1]?.id)
        next.set(runId, old)
    }
    byRunCache.current = next
    return next
  }, [events])

  // Every assistant segment's createdAt, grouped by runId. A steer splits a run into multiple
  // assistant messages that share one runId (see splitAssistantSegment); these boundaries let each
  // segment claim only its own slice of the run's events instead of the whole run (eventsForSegment).
  const segStartsCache = useRef(new Map<string, number[]>())
  const segmentStartsByRun = useMemo(() => {
    const next = new Map<string, number[]>()
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.runId) continue
      const list = next.get(m.runId)
      if (list) list.push(m.createdAt)
      else next.set(m.runId, [m.createdAt])
    }
    // Same identity-reuse as eventsByRun: a run's segment starts only change when a steer splits it,
    // so a streamed message.updated (every ~80ms) must not hand settled turns a fresh array.
    const prev = segStartsCache.current
    for (const [runId, list] of next) {
      const old = prev.get(runId)
      if (old && old.length === list.length && old[old.length - 1] === list[list.length - 1]) next.set(runId, old)
    }
    segStartsCache.current = next
    return next
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

  // A foreground subagent reports through an agent-tagged error event, but it has no assistant
  // message of its own for AssistantTurn to decorate. Keep those failures in the center transcript
  // as well as the Agents panel/notification. Background failures eventually get an attributed
  // incoming message; suppress the standalone card once that delivery arrives so the same failure
  // is not shown twice.
  const deliveredAgentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const msg of messages) {
      if (msg.origin?.kind === 'agent' && msg.origin.agentId) ids.add(msg.origin.agentId)
    }
    return ids
  }, [messages])
  const agentLabels = useMemo(() => {
    const labels = new Map<string, string>()
    for (const ev of events) {
      if (!ev.agent || ev.body.type !== 'run.started') continue
      labels.set(ev.agent, ev.body.name ?? ev.body.agentType ?? ev.body.model)
    }
    return labels
  }, [events])
  const agentErrors = useMemo(
    () =>
      events.filter(
        (ev) => ev.agent && ev.body.type === 'error' && !deliveredAgentIds.has(ev.agent)
      ),
    [events, deliveredAgentIds]
  )

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
                runEvents={msg.runId ? eventsByRun.get(msg.runId) : undefined}
                segStarts={msg.runId ? segmentStartsByRun.get(msg.runId) : undefined}
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
        {agentErrors.map((event) => (
          <AgentErrorTurn
            key={event.id}
            event={event}
            label={event.agent ? agentLabels.get(event.agent) : undefined}
          />
        ))}
        {messages.length === 0 && agentErrors.length === 0 && (
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
 * An agent-tagged failure has no standalone assistant message, so render it as a real chat card.
 * This is especially important for foreground subagents: their failure used to be visible only in
 * the Agents panel and the failure notification.
 */
function AgentErrorTurn({ event, label }: { event: RunEvent; label?: string }): React.JSX.Element | null {
  const setUi = useStore((s) => s.setUi)
  const openModelPicker = useStore((s) => s.openModelPicker)
  if (!event.agent || event.body.type !== 'error') return null

  const modelUnavailable = event.body.category === 'model_unavailable' || event.body.category === 'model_cooldown'
  return (
    <article className="turn-ai agent-error-turn" role="alert">
      <div className="turn-byline">
        <span className="model">{label ?? 'Subagent'}</span>
        <span className="turn-status failed">failed</span>
      </div>
      <div className="error-card">
        <div className="title">{categoryLabel(event.body.category)}</div>
        <div>{event.body.message}</div>
        {modelUnavailable && (
          <div className="actions">
            <button className="btn" onClick={() => openModelPicker()}>
              <I name="model_training" size={14} />
              Choose another model
            </button>
          </div>
        )}
      </div>
    </article>
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
      {msg.attachments?.length ? <MessageAttachments attachments={msg.attachments} /> : null}
    </div>
  )
}

/**
 * The images (and other files) a turn carried. An image is shown as a real thumbnail — the model saw
 * the picture, so the transcript should show it too, not just its filename — and opens full-size in
 * a new tab on click. Anything that is not an image stays a filename chip.
 */
function MessageAttachments({ attachments }: { attachments: Attachment[] }): React.JSX.Element {
  return (
    <div className="msg-attachments">
      {attachments.map((a) =>
        a.kind === 'image' && a.content ? (
          <a
            key={a.id}
            className="msg-attachment-image"
            href={a.content}
            target="_blank"
            rel="noreferrer"
            title={`${a.name} — open full size`}
          >
            <img src={a.content} alt={a.name} />
          </a>
        ) : (
          <span key={a.id} className="msg-attachment-file" title={a.name}>
            <I name="attach_file" size={13} /> {a.name}
          </span>
        )
      )}
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
  const attachments = msg.attachments?.length ? <MessageAttachments attachments={msg.attachments} /> : null
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

/**
 * One assistant turn. The model is named once in a byline; below it the turn's flow (see
 * TurnActivity.tsx): plain prose where the model spoke, one folded activity line for every stretch
 * of work in between, a card per subagent. Chrome that is not part of the flow — the stats line,
 * the copy action, an error, the recovery card — sits at the end.
 */
const AssistantTurn = React.memo(function AssistantTurn({
  msg,
  runEvents,
  segStarts,
  showTelemetry
}: {
  msg: ChatMessage
  runEvents: RunEvent[] | undefined
  segStarts: number[] | undefined
  showTelemetry: boolean
}): React.JSX.Element {
  const running = msg.status === undefined
  const [copied, setCopied] = useState(false)
  const speechStatus = useSpeakingStatus(msg.id)
  const speaking = speechStatus !== 'idle'

  // This segment's slice of its run's events. Memoized on the (identity-stable) run slice + segment
  // starts, so a settled turn recomputes nothing — and the React.memo wrapper skips it entirely —
  // while another run streams. `runEvents` already excludes subagent (`agent`-tagged) events.
  const events = useMemo(
    () => (msg.runId && runEvents ? eventsForSegment(runEvents, segStarts ?? [msg.createdAt], msg.createdAt) : []),
    [msg.runId, runEvents, segStarts, msg.createdAt]
  )
  const mainEvents = useMemo(() => events.filter((e) => !e.agent), [events])

  const errorEvent = mainEvents.find((e) => e.body.type === 'error')
  const askEvents = mainEvents.filter((event) => event.body.type.startsWith('ask.'))

  // Reasoning, spoken output, and tool calls woven into one seq-ordered timeline, so the reader sees
  // the real sequence — think → speak → call a tool → think → speak.
  // A silent acknowledgement of a background notice (see silentReply.ts) is kept for the model's
  // history but shown as a quiet marker, not as a reply reading "NO_REPLY".
  const silent = !running && isSilentReply(msg.text)
  const timeline = useMemo(() => {
    const items = buildTimeline(mainEvents)
    return silent ? items.filter((item) => !(item.kind === 'output' && isSilentReply(item.text))) : items
  }, [mainEvents, silent])
  const committedOutputChars = useMemo(
    () => timeline.reduce((n, i) => (i.kind === 'output' ? n + i.text.length : n), 0),
    [timeline]
  )
  // Whether the model's spoken output is (or is about to be) shown in the flow — committed output
  // events, or a live streaming tail that hasn't flushed to events yet.
  const outputShown = committedOutputChars > 0 || (running && msg.text.length > committedOutputChars)
  // Is the tail of the flow still moving? Live prose is; a subagent card carries its own state; a
  // trailing activity block of a running turn stays live through the gap before the next round.
  // When nothing is, the run is waiting on the provider and the working line stands in for it.
  const liveTail = useMemo(() => {
    if (msg.text.length > committedOutputChars) return true
    const flow = flowOf(timeline)
    const last = flow[flow.length - 1]
    if (!last) return false
    if (last.kind === 'prose') return last.item.endTs === undefined
    return true
  }, [timeline, msg.text.length, committedOutputChars])

  const hasErrorCard = !!errorEvent && errorEvent.body.type === 'error' && msg.status === 'error'
  // Legacy fallback: a completed turn with no output events (rows persisted before output was woven
  // into the timeline) still shows its text as prose.
  const legacyText = !running && !outputShown && !silent ? msg.text : ''

  const interrupted = msg.status === 'interrupted'
  // A failed reply (interrupted mid-stream, or an error) gets a Retry that re-runs its turn — but
  // only while it is still the thread's last reply; anything later would make a rewrite of history.
  const retryTurn = useStore((s) => s.retryTurn)
  const setEffort = useStore((s) => s.setEffort)
  const setUi = useStore((s) => s.setUi)
  const openModelPicker = useStore((s) => s.openModelPicker)
  const threadEffort = useStore((s) => s.threads.find((t) => t.id === s.activeThreadId)?.effort)
  const isLastMessage = useStore((s) => s.messages[s.messages.length - 1]?.id === msg.id)
  const canRetry = !running && (interrupted || msg.status === 'error') && isLastMessage
  // What the recovery card offers: Resume when the reply got somewhere, a plain retry when it did
  // not. Resuming continues the SAME message — nothing already written or already run is repeated.
  const plan = useMemo(() => recoveryPlan(msg), [msg])
  // Latched while a recovery is in flight so the buttons cannot be double-fired; it clears when the
  // message starts streaming again (`status` goes undefined) or the card goes away entirely.
  const [retrying, setRetrying] = useState(false)
  useEffect(() => {
    if (!canRetry) setRetrying(false)
  }, [canRetry])
  // The two output-shaped failures — an empty reply (the model spent its whole budget thinking) and
  // a reply cut off at the output limit — have a one-click fix each, offered right on the row.
  const errorCategory = errorEvent?.body.type === 'error' ? errorEvent.body.category : undefined
  const outputShaped = errorCategory === 'malformed_stream' || errorCategory === 'truncated_output'
  const modelUnavailable = errorCategory === 'model_unavailable' || errorCategory === 'model_cooldown'
  const thinkingOn = !!threadEffort && threadEffort !== 'off' && threadEffort !== 'none'

  return (
    <article className={`turn-ai${running ? ' live' : ''}${msg.status === 'error' ? ' errored' : ''}`}>
      <div className="turn-byline">
        <span className="model" title={msg.model}>
          {shortModel(msg.model) || 'assistant'}
        </span>
        {msg.effort && msg.effort !== 'off' && msg.effort !== 'none' && (
          <span className="turn-effort" title="Thinking effort">
            {msg.effort}
          </span>
        )}
        {interrupted && <span className="turn-status interrupted">interrupted</span>}
        {silent && <span className="turn-status silent" title="The notice needed no reply">no reply needed</span>}
        {hasErrorCard && <span className="turn-status failed">failed</span>}
      </div>

      {timeline.length > 0 && <RunTimeline items={timeline} running={running} fullText={msg.text} model={msg.model} />}
      {legacyText && (
        <div className="turn-prose">
          <Markdown text={legacyText} />
        </div>
      )}

      {askEvents.length > 0 && <AskLog events={askEvents} />}

      {/* Any moment the run is waiting on the model with nothing to show: the start of a turn, and
          the gap after each tool result while the next round is in flight. */}
      {running && !liveTail && (
        <div className="working-line pending">
          <I name="autorenew" size={15} className="spin" />
          Working…
        </div>
      )}

      {hasErrorCard && errorEvent.body.type === 'error' && (
        <div className="error-card">
          <div className="title">{categoryLabel(errorEvent.body.category)}</div>
          <div>{errorEvent.body.message}</div>
          {modelUnavailable && (
            <div className="actions">
              <button className="btn" onClick={() => openModelPicker()}>
                <I name="model_training" size={14} />
                Choose another model
              </button>
            </div>
          )}
          {msg.text && <div className="error-card-note">Partial output above was kept.</div>}
        </div>
      )}

      {showTelemetry && msg.telemetry && msg.status && <TurnStats t={msg.telemetry} model={msg.model} />}

      {!running && msg.text && !silent && (
        <div className={`turn-actions${speaking ? ' speaking' : ''}`}>
          <button
            className={`icon-btn${speaking ? ' active' : ''}`}
            title={speaking ? 'Stop reading' : 'Read aloud'}
            aria-pressed={speaking}
            onClick={() => void getSpeaker().toggle(msg.id, msg.text, useStore.getState().settings?.speech)}
          >
            <I name={speechStatus === 'loading' ? 'more_horiz' : speaking ? 'stop_circle' : 'volume_up'} size={14} />
          </button>
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
      )}

      {canRetry && (
        <div className={`turn-recovery ${plan.canResume ? 'resumable' : ''}`} role="status">
          <I name={interrupted ? 'do_not_disturb_on' : 'error'} size={17} className="turn-recovery-mark" />
          <div className="turn-recovery-body">
            <div className="turn-recovery-title">{plan.title}</div>
            <div className="turn-recovery-detail">{plan.detail}</div>
            {(outputShaped || modelUnavailable) && (
              <div className="turn-recovery-extras">
                {outputShaped && thinkingOn && (
                  <button
                    className="link"
                    disabled={retrying}
                    onClick={() => {
                      setRetrying(true)
                      void setEffort('off').then(() => retryTurn(msg.id, 'restart'))
                    }}
                    title="Turn thinking off for this chat and run the turn again from the top"
                  >
                    <I name="neurology" size={13} />
                    Start over without thinking
                  </button>
                )}
                {outputShaped && (
                  <button className="link" onClick={() => setUi({ settingsOpen: true })} title="Raise the max output tokens in Settings → Model">
                    <I name="tune" size={13} />
                    Raise the output limit…
                  </button>
                )}
                {modelUnavailable && (
                  <button className="link" onClick={() => openModelPicker()} title="Pick a different model for this chat">
                    <I name="model_training" size={13} />
                    Choose another model
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="turn-recovery-actions">
            {plan.canResume && (
              <button
                className="btn"
                disabled={retrying}
                onClick={() => {
                  setRetrying(true)
                  void retryTurn(msg.id, 'restart')
                }}
                title="Discard this partial reply and run the turn again from the beginning"
              >
                <I name="restart_alt" size={14} />
                Start over
              </button>
            )}
            <button
              className="btn primary"
              disabled={retrying}
              onClick={() => {
                setRetrying(true)
                void retryTurn(msg.id, plan.canResume ? 'resume' : 'restart')
              }}
              title={
                plan.canResume
                  ? 'Continue this reply from where it stopped, keeping what it already wrote and already ran'
                  : 'Run this turn again'
              }
            >
              <I name={retrying ? 'autorenew' : plan.primaryIcon} size={14} className={retrying ? 'spin' : ''} />
              {retrying ? 'Working…' : plan.primaryLabel}
            </button>
          </div>
        </div>
      )}
    </article>
  )
})


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

/**
 * The turn's one quiet line of numbers: wall time, output tokens, cache hit rate, cost. Everything
 * else the telemetry knows (throughput, time to first token, reasoning tokens, cache writes) is in
 * the hover text. A locally priced cost is click-to-edit, as everywhere else in the app.
 */
function TurnStats({ t, model }: { t: TurnTelemetry; model?: string }): React.JSX.Element | null {
  const models = useStore((s) => s.models)
  const overrides = useStore((s) => s.settings?.costOverrides)
  const setUi = useStore((s) => s.setUi)
  // Priority: provider-reported cost → the user's override (exact) → list price (estimated).
  let cost: { usd: number; estimated: boolean } | undefined
  let editable = false
  if (t.costUsd === undefined) {
    const resolved = resolveCostRates(model, models, overrides)
    if (resolved) {
      const cached = (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0)
      const reasoning = t.tokensReasoning ?? 0
      const usd = computeCost(resolved.rates, {
        freshInput: Math.max(0, (t.tokensIn ?? 0) - cached),
        cachedInput: cached,
        output: Math.max(0, (t.tokensOut ?? 0) - reasoning),
        reasoning
      })
      if (usd > 0) {
        cost = { usd, estimated: resolved.estimated }
        editable = !!model
      }
    }
  }
  const { text, title } = turnStats(t, cost)
  if (!text) return null
  if (editable) {
    return (
      <button type="button" className="turn-stats turn-stats-btn" title={`${title}\n\nClick to set your own rates for this model`} onClick={() => setUi({ costEditorModel: model! })}>
        {text}
      </button>
    )
  }
  return (
    <div className="turn-stats" title={title}>
      {text}
    </div>
  )
}


function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    auth: 'Authentication failed',
    rate_limit: 'Rate limited',
    model_cooldown: 'Model cooling down',
    provider_unavailable: 'Provider unavailable',
    route_failure: 'Route failed',
    model_unavailable: 'Model unavailable',
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
