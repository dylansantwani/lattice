import React, { useRef, useState } from 'react'
import { useStore, activeThread } from '@/state/store'
import { ContextOrbit } from './ContextOrbit'
import { I } from './Icon'

const PRESETS = [
  { key: 'manual', label: 'Manual' },
  { key: 'workspace', label: 'Auto' },
  { key: 'full', label: 'Full' }
] as const

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
  const setPreset = useStore((s) => s.setPreset)
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
      <div className="composer-inner">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="perm-seg" role="radiogroup" aria-label="Permission preset">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                className={`${thread?.permissionPreset === p.key ? 'active' : ''} ${p.key === 'full' ? 'full' : ''}`}
                role="radio"
                aria-checked={thread?.permissionPreset === p.key}
                onClick={() => void setPreset(p.key)}
                title={
                  p.key === 'manual'
                    ? 'Ask before each side effect'
                    : p.key === 'workspace'
                      ? 'Allow reads/writes in approved roots; ask for the rest'
                      : 'Full local access'
                }
              >
                {p.label}
              </button>
            ))}
          </div>
          <select
            className={`mini-select ${thread?.mode === 'plan' ? 'brass' : ''}`}
            value={thread?.mode ?? 'act'}
            onChange={(e) => void setMode(e.target.value as 'plan' | 'act' | 'review')}
            title="Mode"
            aria-label="Mode"
          >
            <option value="plan">Plan</option>
            <option value="act">Act</option>
            <option value="review">Review</option>
          </select>
        </div>

        <div className="composer">
          <textarea
            ref={taRef}
            rows={1}
            placeholder={
              running
                ? 'Steer the run… (Enter steers, ⌘Enter queues)'
                : "Command agent or type message…"
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              autoGrow()
            }}
            onKeyDown={onKeyDown}
          />
          <div className="composer-row">
            <button
              className="model-chip"
              onClick={() => setUi({ modelPickerOpen: true })}
              title="Change model (⌘M)"
            >
              <I name="model_training" size={15} />
              <span className="id">{thread?.model ?? '—'}</span>
              <I name="expand_more" size={14} />
            </button>
            {effortTiers.length > 0 && (
              <select
                className="mini-select"
                value={thread?.effort ?? ''}
                onChange={(e) => void setEffort(e.target.value)}
                title="Reasoning effort"
                aria-label="Reasoning effort"
              >
                {effortTiers.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
            <button className="icon-btn" title="Attach files (coming soon)">
              <I name="add_circle" size={17} />
            </button>
            <div className="spacer" />
            <ContextOrbit
              budget={budget}
              onClick={() => setUi({ inspectorOpen: true, inspectorTab: 'context' })}
            />
            {running ? (
              <button className="execute-btn stop" onClick={() => void cancel()}>
                Stop
                <I name="stop" size={15} />
              </button>
            ) : (
              <button className="execute-btn" onClick={() => doSend('send')} disabled={!text.trim()}>
                Execute
                <I name="keyboard_return" size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
