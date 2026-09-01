import React, { useRef, useState } from 'react'
import { useStore, activeThread } from '@/state/store'
import { ContextOrbit } from './ContextOrbit'

export function Composer(): React.JSX.Element {
  const [text, setText] = useState('')
  const send = useStore((s) => s.send)
  const cancel = useStore((s) => s.cancel)
  const budget = useStore((s) => s.budget)
  const setUi = useStore((s) => s.setUi)
  const thread = useStore((s) => activeThread(s))
  const models = useStore((s) => s.models)
  const setEffort = useStore((s) => s.setEffort)
  const setMode = useStore((s) => s.setMode)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const running = !!thread?.running
  const model = models.find((m) => m.id === thread?.model)
  const effortTiers = model?.capabilities.effortTiers ?? []

  const doSend = (disposition: 'send' | 'steer' | 'queue'): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    void send({ text: trimmed, disposition })
    setText('')
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (e.metaKey) doSend('queue')
      else doSend(running ? 'steer' : 'send')
    }
  }

  const autoGrow = (): void => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          placeholder={running ? 'Steer the run… (Enter steers, ⌘Enter queues)' : 'Ask Lattice…'}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            autoGrow()
          }}
          onKeyDown={onKeyDown}
        />
        <div className="composer-row">
          <button className="chip violet" onClick={() => setUi({ modelPickerOpen: true })} title="Change model (⌘M)">
            <span className="mono">{thread?.model ?? '—'}</span>
          </button>
          {effortTiers.length > 0 && (
            <select
              className="chip"
              style={{ appearance: 'none', background: 'transparent' }}
              value={thread?.effort ?? ''}
              onChange={(e) => void setEffort(e.target.value)}
              title="Reasoning effort"
            >
              {effortTiers.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          <select
            className={`chip ${thread?.mode === 'plan' ? 'brass' : ''}`}
            style={{ appearance: 'none', background: 'transparent' }}
            value={thread?.mode ?? 'act'}
            onChange={(e) => void setMode(e.target.value as 'plan' | 'act' | 'review')}
            title="Mode"
          >
            <option value="plan">Plan</option>
            <option value="act">Act</option>
            <option value="review">Review</option>
          </select>
          <div className="spacer" />
          <ContextOrbit budget={budget} onClick={() => setUi({ inspectorOpen: true, inspectorTab: 'context' })} />
          {running ? (
            <button className="send-btn stop" onClick={() => void cancel()} title="Stop run" aria-label="Stop run">
              ■
            </button>
          ) : (
            <button className="send-btn" onClick={() => doSend('send')} disabled={!text.trim()} title="Send" aria-label="Send">
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
