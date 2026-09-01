import React, { useCallback, useEffect, useState } from 'react'
import type { SessionMessage, SessionSummary } from '@shared/types'
import { useStore } from '@/state/store'
import { I } from './Icon'

/**
 * The inter-session messaging panel (Slice 9). It surfaces the messages other sessions have sent to
 * the current thread (its inbox) and lets you send a message to another session (the directory).
 *
 * Self-contained on purpose: like Settings/Inspector it talks to the main process directly through
 * `window.lattice.*` rather than routing every call through the store, so the only store coupling is
 * the unread badge (`sessionUnread`) that lives in the header trigger. Opening the panel marks the
 * current thread's unread messages read.
 */
export function Inbox({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const activeThreadId = useStore((s) => s.activeThreadId)
  const refreshUnread = useStore((s) => s.refreshSessionUnread)
  const flash = useStore((s) => s.flash)

  const [inbox, setInbox] = useState<SessionMessage[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [to, setTo] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    if (!activeThreadId) {
      setInbox([])
      setSessions([])
      return
    }
    const [msgs, dir] = await Promise.all([
      window.lattice.listInbox(activeThreadId).catch(() => [] as SessionMessage[]),
      window.lattice.listSessions(activeThreadId).catch(() => [] as SessionSummary[])
    ])
    setInbox(msgs)
    setSessions(dir)
    // Opening the panel is "reading" the current thread's inbox: clear its unread.
    const unread = msgs.filter((m) => !m.readAt)
    if (unread.length) {
      await Promise.all(unread.map((m) => window.lattice.markSessionMessageRead(m.id).catch(() => false)))
      await refreshUnread()
    }
  }, [activeThreadId, refreshUnread])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const send = useCallback(async () => {
    if (!activeThreadId || !to.trim() || !body.trim() || sending) return
    setSending(true)
    try {
      const res = await window.lattice.sendSessionMessage({
        fromThreadId: activeThreadId,
        to: to.trim(),
        body: body.trim()
      })
      if (res.ok) {
        const where = res.delivery === 'injected' ? 'delivered live' : 'left in inbox'
        flash(`Message ${where} → ${res.toTitle ?? to}`)
        setBody('')
        await refreshUnread()
      } else {
        flash(res.error ?? 'Could not send message.', 'warn')
      }
    } finally {
      setSending(false)
    }
  }, [activeThreadId, to, body, sending, flash, refreshUnread])

  if (!open) return null

  const rowStyle: React.CSSProperties = {
    padding: '9px 0',
    borderBottom: '1px solid var(--hairline)',
    fontSize: 13
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Session messages" style={{ width: 520, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <I name="forum" size={19} />
          Session messages
        </h3>

        {!activeThreadId ? (
          <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>Open a thread to see its inbox and message other sessions.</p>
        ) : (
          <>
            <div style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)', margin: '4px 0 2px' }}>
                Inbox for this session
              </div>
              {inbox.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '6px 0 12px' }}>No messages yet.</p>
              ) : (
                <div style={{ marginBottom: 10 }}>
                  {inbox.map((m) => (
                    <div key={m.id} style={rowStyle}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <span style={{ fontWeight: 600, color: 'var(--text)' }}>
                          {m.fromTitle}
                          {m.replyTo ? ' ↩' : ''}
                        </span>
                        <button
                          className="btn"
                          style={{ padding: '1px 8px', fontSize: 11 }}
                          onClick={() => {
                            setTo(m.fromThreadId)
                          }}
                          title="Reply to this session"
                        >
                          Reply
                        </button>
                      </div>
                      <div style={{ color: 'var(--text-dim)', marginTop: 3, whiteSpace: 'pre-wrap' }}>{m.body}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 10, marginTop: 2 }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-faint)', marginBottom: 6 }}>
                Send to a session
              </div>
              <select
                value={to}
                onChange={(e) => setTo(e.target.value)}
                style={{ width: '100%', marginBottom: 6 }}
                aria-label="Target session"
              >
                <option value="">Choose a session…</option>
                {sessions.map((s) => (
                  <option key={s.threadId} value={s.threadId}>
                    {s.title}
                    {s.running ? ' • running' : ''}
                    {s.unread ? ` • ${s.unread} unread` : ''}
                  </option>
                ))}
              </select>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Message…"
                rows={3}
                style={{ width: '100%', resize: 'vertical' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <div className="row">
                <button className="btn" onClick={onClose}>
                  Close
                </button>
                <button className="btn primary" onClick={() => void send()} disabled={!to || !body.trim() || sending}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
