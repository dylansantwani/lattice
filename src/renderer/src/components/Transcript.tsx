import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, RunEvent, TurnTelemetry } from '@shared/types'
import { useStore } from '@/state/store'
import { Markdown } from './Markdown'
import { fmtTokens } from './ContextOrbit'
import { I } from './Icon'

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
        {messages.map((msg) =>
          msg.role === 'user' ? (
            <div key={msg.id} className="turn-user">
              {msg.text}
              {msg.attachments?.map((a) => (
                <div key={a.id} style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 6 }}>
                  <I name="attach_file" size={13} /> {a.name}
                </div>
              ))}
            </div>
          ) : (
            <AssistantTurn
              key={msg.id}
              msg={msg}
              events={msg.runId ? (eventsByRun.get(msg.runId) ?? []) : []}
              reasoningVisibility={settings?.reasoningVisibility ?? 'auto'}
              showTelemetry={settings?.telemetryFooter ?? true}
            />
          )
        )}
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

function AssistantTurn({
  msg,
  events,
  reasoningVisibility,
  showTelemetry
}: {
  msg: ChatMessage
  events: RunEvent[]
  reasoningVisibility: 'expanded' | 'auto' | 'hidden'
  showTelemetry: boolean
}): React.JSX.Element {
  const running = msg.status === undefined
  const [copied, setCopied] = useState(false)
  const reasoning = useMemo(
    () =>
      events
        .filter((e) => e.body.type === 'reasoning.delta')
        .map((e) => (e.body.type === 'reasoning.delta' ? e.body.text : ''))
        .join(''),
    [events]
  )
  const errorEvent = events.find((e) => e.body.type === 'error')

  return (
    <>
      {reasoning.length > 0 && reasoningVisibility !== 'hidden' && (
        <ThinkingCard
          reasoning={reasoning}
          running={running && !msg.text}
          defaultOpen={reasoningVisibility === 'expanded' || (running && !msg.text)}
        />
      )}

      <div className="turn-assistant">
        <div className="turn-head">
          <span className="model">{msg.model}</span>
          {msg.effort && <span>· {msg.effort}</span>}
          {running && <span className="running-dot" />}
          {msg.status === 'interrupted' && (
            <span style={{ color: 'var(--brass)' }}>· interrupted</span>
          )}
        </div>

        {msg.text ? (
          <Markdown text={msg.text} />
        ) : running && !reasoning ? (
          <div style={{ color: 'var(--text-faint)', fontSize: 14 }}>…</div>
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

function ThinkingCard({
  reasoning,
  running,
  defaultOpen
}: {
  reasoning: string
  running: boolean
  defaultOpen: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState<boolean | null>(null)
  const isOpen = open ?? defaultOpen
  return (
    <div className="thinking-card">
      <div
        className="thinking-head"
        onClick={() => setOpen(!isOpen)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setOpen(!isOpen)}
      >
        <I name="sync" size={15} className={running ? 'spin' : ''} />
        <span className="label">{running ? 'Thinking…' : 'Reasoned'}</span>
        <span className="fidelity-badge">raw provider reasoning</span>
        {!isOpen && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-faint)' }}>
            ~{fmtTokens(Math.round(reasoning.length / 4))} tok
          </span>
        )}
        <I name={isOpen ? 'expand_less' : 'expand_more'} size={16} className="chev" />
      </div>
      {isOpen && <div className="thinking-log">{reasoning}</div>}
    </div>
  )
}

function Telemetry({ t }: { t: TurnTelemetry }): React.JSX.Element {
  const est = t.estimated ? '~' : ''
  const chips: { icon: string; label: string; title?: string }[] = []
  if (t.tps) chips.push({ icon: 'speed', label: `${t.tps} tok/s` })
  if (t.ttftMs !== undefined) chips.push({ icon: 'timer', label: `${(t.ttftMs / 1000).toFixed(1)}s TTFT` })
  if (t.wallMs !== undefined) chips.push({ icon: 'schedule', label: `${(t.wallMs / 1000).toFixed(1)}s` })
  if (t.tokensOut !== undefined) chips.push({ icon: 'tag', label: `${est}${fmtTokens(t.tokensOut)} out` })
  if (t.tokensReasoning) chips.push({ icon: 'psychology', label: `${fmtTokens(t.tokensReasoning)} think` })
  if (t.cacheReadTokens !== undefined && t.tokensIn)
    chips.push({ icon: 'memory', label: `${Math.round((t.cacheReadTokens / t.tokensIn) * 100)}% cached` })
  if (t.costUsd !== undefined) chips.push({ icon: 'paid', label: `$${t.costUsd.toFixed(4)}` })
  return (
    <div className="turn-telemetry">
      {chips.map((c, i) => (
        <span key={i} className="tchip" title={c.title}>
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
