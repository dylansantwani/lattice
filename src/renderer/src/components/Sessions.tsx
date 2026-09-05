import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionActivity, SessionActivitySummary, SessionMessage } from '@shared/types'
import { useStore } from '@/state/store'
import { I } from './Icon'
import { needsYouCount, relTime, sessionBadges, sortSessions, STATUS_LOOK, toolDuration } from './sessionView'

/**
 * The Sessions panel (Slice 9): every other session at a glance, and a read-only window onto any one
 * of them — what it is doing right now, its recent turns and tool calls, and whatever it is parked
 * on waiting for you. Plus the inbox and the send box, which were this panel's whole content before.
 *
 * Two tabs, one surface:
 *  - **Activity** — the live directory and the detail pane. Sessions that need you lead the list.
 *  - **Messages** — this session's inbox, and sending a message to another session.
 *
 * Self-contained, like the panel it replaces: it talks to the main process through `window.lattice.*`
 * and subscribes to the push channel itself, so the only store coupling is jumping to a thread. What
 * it shows is decided in `src/main/runtime/sessionActivity.ts`, which withholds hidden reasoning,
 * redacts secrets, summarizes tool arguments rather than dumping them, and honors per-thread privacy.
 */
export function Sessions({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const activeThreadId = useStore((s) => s.activeThreadId)
  const refreshUnread = useStore((s) => s.refreshSessionUnread)
  const selectThread = useStore((s) => s.selectThread)
  const flash = useStore((s) => s.flash)

  const [tab, setTab] = useState<'activity' | 'messages'>('activity')
  const [sessions, setSessions] = useState<SessionActivitySummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SessionActivity | null>(null)
  const [inbox, setInbox] = useState<SessionMessage[]>([])
  const [to, setTo] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  const ordered = useMemo(() => sortSessions(sessions), [sessions])
  const waiting = useMemo(() => needsYouCount(sessions), [sessions])

  // ---- loading ----

  const loadDirectory = useCallback(async () => {
    const list = await window.lattice.listSessionActivity(activeThreadId ?? undefined).catch(() => [])
    setSessions(list)
    // Stream live updates for everything on screen; the main process coalesces per session, and an
    // idle session emits nothing at all. The watch set is re-declared wholesale, so a reload of this
    // window can never leave a watch behind.
    void window.lattice.watchSessionActivity(list.map((s) => s.threadId)).catch(() => {})
    return list
  }, [activeThreadId])

  const loadDetail = useCallback(async (threadId: string) => {
    const activity = await window.lattice.getSessionActivity(threadId).catch(() => null)
    if (selectedRef.current === threadId) setDetail(activity)
  }, [])

  const loadInbox = useCallback(async () => {
    if (!activeThreadId) {
      setInbox([])
      return
    }
    const msgs = await window.lattice.listInbox(activeThreadId).catch(() => [] as SessionMessage[])
    setInbox(msgs)
    // Opening the panel is "reading" this session's inbox: clear its unread.
    const unread = msgs.filter((m) => !m.readAt)
    if (unread.length) {
      await Promise.all(unread.map((m) => window.lattice.markSessionMessageRead(m.id).catch(() => false)))
      await refreshUnread()
    }
  }, [activeThreadId, refreshUnread])

  useEffect(() => {
    if (!open) return
    void (async () => {
      const list = await loadDirectory()
      await loadInbox()
      // Land on whatever most wants attention, so the panel opens on something useful.
      const first = sortSessions(list)[0]
      if (first && !selectedRef.current) {
        setSelectedId(first.threadId)
        void loadDetail(first.threadId)
      }
    })()
  }, [open, loadDirectory, loadInbox, loadDetail])

  // Stop watching when the panel closes — nothing is redrawing, so nothing should be pushed.
  useEffect(() => {
    if (open) return
    setDetail(null)
    setSelectedId(null)
    void window.lattice.watchSessionActivity([]).catch(() => {})
  }, [open])

  // Live updates: a watched session's snapshot replaces its row, and the open detail pane with it.
  useEffect(() => {
    if (!open) return
    return window.lattice.onPush((event) => {
      if (event.kind === 'session.activity') {
        const activity = event.activity
        setSessions((list) => list.map((s) => (s.threadId === activity.threadId ? { ...s, ...activity } : s)))
        if (selectedRef.current === activity.threadId) setDetail(activity)
      } else if (event.kind === 'thread.updated' || event.kind === 'thread.deleted' || event.kind === 'session.message') {
        // A thread appeared, vanished, or got a message: the directory itself changed.
        void loadDirectory()
      }
    })
  }, [open, loadDirectory])

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

  // ---- actions ----

  const select = (threadId: string): void => {
    setSelectedId(threadId)
    setDetail(null)
    void loadDetail(threadId)
  }

  const openThread = (threadId: string): void => {
    void selectThread(threadId)
    onClose()
  }

  const messageThread = (threadId: string): void => {
    setTo(threadId)
    setTab('messages')
  }

  const togglePrivate = async (activity: SessionActivity): Promise<void> => {
    const next = !activity.isPrivate
    await window.lattice.updateThread(activity.threadId, { isPrivate: next }).catch(() => null)
    flash(
      next
        ? `“${activity.title}” is private — other sessions can see only whether it is busy.`
        : `“${activity.title}” is visible to your other sessions again.`
    )
    void loadDirectory()
    void loadDetail(activity.threadId)
  }

  const send = useCallback(async () => {
    if (!activeThreadId || !to.trim() || !body.trim() || sending) return
    setSending(true)
    try {
      const res = await window.lattice.sendSessionMessage({ fromThreadId: activeThreadId, to: to.trim(), body: body.trim() })
      if (res.ok) {
        const where =
          res.delivery === 'injected'
            ? 'delivered live'
            : res.delivery === 'woken'
              ? 'delivered — it was idle and has been woken'
              : 'left in the inbox'
        flash(`Message ${where} → ${res.toTitle ?? to}`)
        setBody('')
        await refreshUnread()
        await loadDirectory()
      } else {
        flash(res.error ?? 'Could not send message.', 'warn')
      }
    } finally {
      setSending(false)
    }
  }, [activeThreadId, to, body, sending, flash, refreshUnread, loadDirectory])

  if (!open) return null

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sessions-modal" role="dialog" aria-label="Sessions">
        <div className="sessions-head">
          <h3>
            <I name="forum" size={19} />
            Sessions
          </h3>
          <div className="sessions-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>
              Activity
              {waiting > 0 && <span className="sessions-tab-badge">{waiting}</span>}
            </button>
            <button role="tab" aria-selected={tab === 'messages'} className={tab === 'messages' ? 'active' : ''} onClick={() => setTab('messages')}>
              Messages
            </button>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (esc)">
            <I name="close" size={18} />
          </button>
        </div>

        {tab === 'activity' ? (
          <div className="sessions-body">
            <div className="sessions-list" role="listbox" aria-label="Sessions">
              {ordered.length === 0 && <p className="sessions-empty">No other sessions yet.</p>}
              {ordered.map((s) => {
                const look = STATUS_LOOK[s.status]
                const badges = sessionBadges(s)
                return (
                  <button
                    key={s.threadId}
                    className={`session-row ${s.threadId === selectedId ? 'selected' : ''}`}
                    role="option"
                    aria-selected={s.threadId === selectedId}
                    onClick={() => select(s.threadId)}
                  >
                    <I name={look.icon} size={16} className={`session-status tone-${look.tone}`} />
                    <span className="session-row-main">
                      <span className="session-row-title">{s.title}</span>
                      <span className="session-row-status">{s.statusText}</span>
                      {badges.length > 0 && <span className="session-row-badges">{badges.join(' · ')}</span>}
                    </span>
                    <span className="session-row-when">{relTime(s.updatedAt)}</span>
                  </button>
                )
              })}
            </div>

            <div className="session-detail">
              {!detail ? (
                <p className="sessions-empty">{selectedId ? 'Loading…' : 'Pick a session to watch.'}</p>
              ) : (
                <SessionDetail
                  activity={detail}
                  onOpen={() => openThread(detail.threadId)}
                  onMessage={() => messageThread(detail.threadId)}
                  onTogglePrivate={() => void togglePrivate(detail)}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="sessions-messages">
            {!activeThreadId ? (
              <p className="sessions-empty">Open a chat to see its inbox and message other sessions.</p>
            ) : (
              <>
                <div className="sessions-inbox">
                  <div className="sessions-label">Inbox for this session</div>
                  {inbox.length === 0 ? (
                    <p className="sessions-empty">No messages yet.</p>
                  ) : (
                    inbox.map((m) => (
                      <div key={m.id} className="inbox-row">
                        <div className="inbox-row-head">
                          <span className="inbox-from">
                            {m.fromTitle}
                            {m.replyTo ? ' ↩' : ''}
                          </span>
                          <span className="inbox-when">{relTime(m.createdAt)}</span>
                          <button className="btn tiny" onClick={() => setTo(m.fromThreadId)} title="Reply to this session">
                            Reply
                          </button>
                        </div>
                        <div className="inbox-body">{m.body}</div>
                      </div>
                    ))
                  )}
                </div>
                <div className="sessions-send">
                  <div className="sessions-label">Send to a session</div>
                  <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Target session">
                    <option value="">Choose a session…</option>
                    {ordered.map((s) => (
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
                    placeholder="Message… (⌘↵ to send)"
                    rows={3}
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
        )}
      </div>
    </div>
  )
}

/** The read-only window onto one session. */
function SessionDetail({
  activity,
  onOpen,
  onMessage,
  onTogglePrivate
}: {
  activity: SessionActivity
  onOpen: () => void
  onMessage: () => void
  onTogglePrivate: () => void
}): React.JSX.Element {
  const look = STATUS_LOOK[activity.status]
  const pending = [
    ...activity.pending.approvals.map((a) => ({ key: a.id, icon: 'front_hand', text: `Approval: ${a.tool} — ${a.summary}` })),
    ...activity.pending.asks.map((a) => ({ key: a.id, icon: 'help', text: `Question: ${a.question}` }))
  ]
  return (
    <>
      <div className="session-detail-head">
        <div className="session-detail-title">
          <I name={look.icon} size={17} className={`session-status tone-${look.tone}`} />
          <span className="session-detail-name">{activity.title}</span>
        </div>
        <div className="session-detail-actions">
          <button className="btn tiny" onClick={onMessage} title="Send this session a message">
            Message
          </button>
          <button
            className={`btn tiny ${activity.isPrivate ? 'on' : ''}`}
            onClick={onTogglePrivate}
            title={
              activity.isPrivate
                ? 'Private: your other sessions can see only whether this one is busy. Click to make it visible again.'
                : 'Mark private: your other sessions (and their agents) will see only whether this one is busy, never its contents.'
            }
          >
            <I name={activity.isPrivate ? 'lock' : 'lock_open'} size={13} />
            {activity.isPrivate ? 'Private' : 'Visible'}
          </button>
          <button className="btn tiny primary" onClick={onOpen} title="Switch to this chat">
            Open
          </button>
        </div>
      </div>

      <div className="session-detail-meta">
        <span className={`session-status-text tone-${look.tone}`}>{activity.statusText}</span>
        <span>{activity.model}</span>
        <span>{activity.mode}</span>
        <span>{activity.permissionPreset}</span>
        <span>updated {relTime(activity.updatedAt)}</span>
      </div>

      {activity.goal && (
        <div className="session-goal">
          <I name="flag" size={13} /> {activity.goal}
        </div>
      )}

      {activity.withheld && (
        <div className="session-withheld" role="status">
          <I name="lock" size={14} />
          {activity.withheld} Only whether it is busy is shared with your other sessions — you can still open it yourself.
        </div>
      )}

      {pending.length > 0 && (
        <div className="session-pending" role="status">
          {pending.map((p) => (
            <div key={p.key} className="session-pending-row">
              <I name={p.icon} size={14} />
              <span>{p.text}</span>
            </div>
          ))}
          <button className="btn tiny primary" onClick={onOpen}>
            Go answer it
          </button>
        </div>
      )}

      {activity.tools.length > 0 && (
        <section className="session-section">
          <div className="sessions-label">Recent tool calls</div>
          {activity.tools
            .slice()
            .reverse()
            .map((t) => (
              <div key={t.callId} className={`session-tool ${t.status}`}>
                <I
                  name={t.status === 'running' ? 'pending' : t.status === 'ok' ? 'check' : t.status === 'denied' ? 'block' : 'close'}
                  size={13}
                />
                <span className="session-tool-name">{t.tool}</span>
                {t.agent && <span className="session-tool-agent">subagent</span>}
                {t.summary && <span className="session-tool-note">{t.summary}</span>}
                <span className="session-tool-time">{toolDuration(t)}</span>
              </div>
            ))}
        </section>
      )}

      {activity.messages.length > 0 && (
        <section className="session-section session-transcript">
          <div className="sessions-label">Recent turns</div>
          {activity.messages.map((m) => (
            <div key={m.id} className={`session-turn ${m.role}`}>
              <span className="session-turn-role">{m.from ?? (m.role === 'user' ? 'you' : 'assistant')}</span>
              <span className="session-turn-text">
                {m.text}
                {m.truncated && <span className="session-turn-more"> …</span>}
              </span>
            </div>
          ))}
        </section>
      )}

      <p className="session-foot">
        Read-only. Hidden reasoning is never shown here and credentials are redacted, in this panel and
        for any agent that looks at another session.
      </p>
    </>
  )
}
