import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '@/state/store'
import { Markdown } from './Markdown'
import { I } from './Icon'

/**
 * The `/btw` quick aside: a narrow chat panel docked to the right edge that carries the current
 * thread's context (the model sees the parent history) but shows only the new by-the-way exchange.
 * It is ephemeral — closing it (X or Escape) discards the whole side conversation. Rendered only
 * when `store.aside` is set, so it fully unmounts on close.
 */
export function SideChat(): React.JSX.Element | null {
  const aside = useStore((s) => s.aside)
  const sendAside = useStore((s) => s.sendAside)
  const closeAside = useStore((s) => s.closeAside)
  const cancelAside = useStore((s) => s.cancelAside)
  const [draft, setDraft] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const count = aside?.messages.length ?? 0
  const running = aside?.running ?? false

  // Keep the newest turn in view as messages stream in.
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count, running])

  // Focus the composer when the aside opens.
  useEffect(() => {
    if (aside) inputRef.current?.focus()
  }, [aside?.threadId])

  if (!aside) return null

  const submit = (): void => {
    const text = draft.trim()
    if (!text || running) return
    setDraft('')
    void sendAside(text)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      void closeAside()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <aside className="side-chat" role="dialog" aria-label="Quick aside">
      <header className="side-chat-head">
        <div className="side-chat-title">
          <I name="quickreply" size={16} />
          <div className="side-chat-titles">
            <span className="side-chat-name">Aside</span>
            <span className="side-chat-sub" title={aside.parentTitle}>
              context from “{aside.parentTitle}”
            </span>
          </div>
        </div>
        <button
          className="icon-btn"
          onClick={() => void closeAside()}
          title="Close & discard (Esc)"
          aria-label="Close and discard aside"
        >
          <I name="close" size={16} />
        </button>
      </header>

      <div className="side-chat-body" ref={bodyRef}>
        {count === 0 && !running ? (
          <div className="side-chat-empty">
            Ask a by-the-way question. This side-chat can see “{aside.parentTitle}”, but closing it
            discards everything here.
          </div>
        ) : null}
        {aside.messages.map((m) => (
          <div key={m.id} className={`side-msg ${m.role}`}>
            {m.role === 'user' ? (
              <div className="side-msg-user">{m.text}</div>
            ) : (
              <div className="side-msg-assistant">
                {m.text ? <Markdown text={m.text} /> : <span className="side-chat-dim">…</span>}
              </div>
            )}
          </div>
        ))}
        {running ? (
          <div className="side-chat-working">
            <span className="side-chat-dot" /> Working…
          </div>
        ) : null}
      </div>

      <div className="side-chat-composer">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="By the way…"
          aria-label="Aside message"
        />
        {running ? (
          <button className="icon-btn" onClick={() => void cancelAside()} title="Stop" aria-label="Stop">
            <I name="stop" size={18} />
          </button>
        ) : (
          <button
            className="icon-btn"
            onClick={submit}
            disabled={!draft.trim()}
            title="Send (↵)"
            aria-label="Send aside message"
          >
            <I name="keyboard_return" size={18} />
          </button>
        )}
      </div>
    </aside>
  )
}
