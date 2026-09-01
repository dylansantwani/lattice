import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, RunEvent, TurnTelemetry } from '@shared/types'
import { useStore } from '@/state/store'
import { Markdown } from './Markdown'
import { fmtTokens } from './ContextOrbit'

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
                  📎 {a.name}
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
          <div className="empty-state" style={{ minHeight: '50vh' }}>
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
  const reasoning = useMemo(
    () =>
      events
        .filter((e) => e.body.type === 'reasoning.delta')
        .map((e) => (e.body.type === 'reasoning.delta' ? e.body.text : ''))
        .join(''),
    [events]
  )
  const errorEvent = events.find((e) => e.body.type === 'error')
  const [reasoningOpen, setReasoningOpen] = useState<boolean | null>(null)
  const showReasoning =
    reasoning.length > 0 &&
    reasoningVisibility !== 'hidden' &&
    (reasoningOpen ?? (reasoningVisibility === 'expanded' || (running && !msg.text)))

  return (
    <div className="turn-assistant">
      <div className="turn-head">
        <span className="model">{msg.model}</span>
        {msg.effort && <span>· {msg.effort}</span>}
        {running && <span className="running-dot" />}
        {msg.status === 'interrupted' && <span style={{ color: 'var(--brass)' }}>· interrupted</span>}
      </div>

      {reasoning.length > 0 && reasoningVisibility !== 'hidden' && (
        <div className="spine">
          {showReasoning ? (
            <>
              <div
                className="reasoning-receipt"
                onClick={() => setReasoningOpen(false)}
                role="button"
                tabIndex={0}
              >
                ▾ reasoning<span className="fidelity-badge">raw provider reasoning</span>
              </div>
              <div className="reasoning-block">{reasoning}</div>
            </>
          ) : (
            <div
              className="reasoning-receipt"
              onClick={() => setReasoningOpen(true)}
              role="button"
              tabIndex={0}
            >
              ▸ reasoned for {fmtTokens(Math.round(reasoning.length / 4))} tokens
              <span className="fidelity-badge">raw provider reasoning</span>
            </div>
          )}
        </div>
      )}

      {msg.text ? <Markdown text={msg.text} /> : running && !reasoning ? <ThinkingDots /> : null}

      {errorEvent && errorEvent.body.type === 'error' && msg.status === 'error' && (
        <div className="error-card">
          <div className="title">{categoryLabel(errorEvent.body.category)}</div>
          <div>{errorEvent.body.message}</div>
          {msg.text && <div style={{ marginTop: 6, color: 'var(--text-faint)', fontSize: 12.5 }}>Partial output above was kept.</div>}
        </div>
      )}

      {showTelemetry && msg.telemetry && msg.status && <Telemetry t={msg.telemetry} />}
    </div>
  )
}

function Telemetry({ t }: { t: TurnTelemetry }): React.JSX.Element {
  const parts: string[] = []
  const est = t.estimated ? '~' : ''
  if (t.tps) parts.push(`${t.tps} tok/s`)
  if (t.ttftMs !== undefined) parts.push(`${(t.ttftMs / 1000).toFixed(1)}s TTFT`)
  if (t.wallMs !== undefined) parts.push(`${(t.wallMs / 1000).toFixed(1)}s wall`)
  if (t.tokensOut !== undefined) parts.push(`${est}${fmtTokens(t.tokensOut)} out`)
  if (t.tokensReasoning) parts.push(`${fmtTokens(t.tokensReasoning)} reasoning`)
  if (t.cacheReadTokens !== undefined && t.tokensIn) {
    parts.push(`${Math.round((t.cacheReadTokens / t.tokensIn) * 100)}% cached`)
  }
  if (t.costUsd !== undefined) parts.push(`$${t.costUsd.toFixed(4)}`)
  return (
    <div className="turn-telemetry">
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="sep">·</span>}
          <span>{p}</span>
        </React.Fragment>
      ))}
    </div>
  )
}

function ThinkingDots(): React.JSX.Element {
  return <div style={{ color: 'var(--text-faint)', fontSize: 14 }}>…</div>
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
