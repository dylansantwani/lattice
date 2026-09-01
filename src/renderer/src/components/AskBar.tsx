import React, { useEffect, useRef, useState } from 'react'
import type { AskRequest } from '@shared/types'
import { useStore } from '@/state/store'
import { I } from './Icon'

/**
 * Questions the model has put to the user via the `ask_user` tool. The run is parked
 * on the main-process ask broker until the user answers here; the answer is returned to
 * the model as the tool result. One card per pending question for the active thread.
 */
export function AskBar(): React.JSX.Element | null {
  const activeThreadId = useStore((s) => s.activeThreadId)
  const asks = useStore((s) => s.asks)
  const pending = asks.filter((a) => a.threadId === activeThreadId)
  // Answer one at a time (oldest first) — stacking multiple open questions is confusing.
  const current = pending[0]
  if (!current) return null
  return (
    <div className="ask-stack">
      <AskCard key={current.id} req={current} extra={pending.length - 1} />
    </div>
  )
}

function AskCard({ req, extra }: { req: AskRequest; extra: number }): React.JSX.Element {
  const respond = useStore((s) => s.respondAsk)
  const [text, setText] = useState('')
  // For a 'choice' question the user can pick "Other" to type a free-form answer instead.
  const [other, setOther] = useState(false)
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)

  // A free-text field is shown for kind:'text', or for a 'choice' once "Other" is chosen.
  const typing = req.kind === 'text' || (req.kind === 'choice' && other)

  useEffect(() => {
    // Focus the field as soon as one appears so the user can just start typing.
    if (typing) inputRef.current?.focus()
  }, [req.id, typing])

  const answer = (value: string): void => {
    void respond({ requestId: req.id, answer: value })
  }
  const cancel = (): void => {
    void respond({ requestId: req.id, answer: '', canceled: true })
  }
  const submitText = (): void => {
    const value = text.trim()
    if (value) answer(value)
  }

  return (
    <div className="ask-card">
      <div className="ask-head">
        <span className="ask-icon" aria-hidden>
          <I name="live_help" size={16} />
        </span>
        <span className="ask-label">Lattice is asking</span>
        {extra > 0 && <span className="ask-more">+{extra} more</span>}
        <button className="ask-dismiss" onClick={cancel} title="Dismiss without answering" aria-label="Dismiss">
          <I name="close" size={15} />
        </button>
      </div>

      <div className="ask-question">{req.question}</div>

      {req.kind === 'confirm' ? (
        <div className="ask-actions ask-confirm">
          <button className="btn" onClick={() => answer('no')}>
            No
          </button>
          <button className="btn primary" onClick={() => answer('yes')}>
            <I name="check" size={16} />
            Yes
          </button>
        </div>
      ) : req.kind === 'choice' && !other ? (
        <div className="ask-choices" role="group" aria-label="Choose an answer">
          {/* recommended option leads, so the suggested pick is always the first thing read */}
          {[...(req.options ?? [])]
            .sort((a, b) => Number(b.recommended ?? false) - Number(a.recommended ?? false))
            .map((opt) => (
            <button
              key={opt.label}
              className={`ask-choice${opt.recommended ? ' recommended' : ''}`}
              onClick={() => answer(opt.label)}
            >
              <span className="ask-choice-main">
                <span className="ask-choice-label">{opt.label}</span>
                {opt.recommended && <span className="ask-choice-badge">Recommended</span>}
              </span>
              {opt.description && <span className="ask-choice-desc">{opt.description}</span>}
            </button>
          ))}
          {/* Always offer an escape hatch to a free-form answer. */}
          <button className="ask-choice other" onClick={() => setOther(true)}>
            <span className="ask-choice-main">
              <span className="ask-choice-label">Other…</span>
            </span>
            <span className="ask-choice-desc">Type a different answer</span>
          </button>
        </div>
      ) : (
        <div className="ask-text">
          {req.multiline ? (
            <textarea
              ref={inputRef}
              className="ask-input"
              rows={3}
              placeholder={req.placeholder ?? 'Type your answer…'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  submitText()
                }
              }}
            />
          ) : (
            <input
              ref={inputRef}
              className="ask-input"
              placeholder={req.placeholder ?? 'Type your answer…'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitText()
                }
              }}
            />
          )}
          <div className="ask-actions">
            {other && (
              <button
                className="btn"
                onClick={() => {
                  setOther(false)
                  setText('')
                }}
              >
                Back
              </button>
            )}
            <button className="btn primary" onClick={submitText} disabled={!text.trim()}>
              <I name="send" size={15} />
              Answer
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
