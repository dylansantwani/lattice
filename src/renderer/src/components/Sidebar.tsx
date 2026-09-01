import React from 'react'
import { useStore } from '@/state/store'

export function Sidebar(): React.JSX.Element {
  const threads = useStore((s) => s.threads)
  const activeId = useStore((s) => s.activeThreadId)
  const selectThread = useStore((s) => s.selectThread)
  const newThread = useStore((s) => s.newThread)

  const pinned = threads.filter((t) => t.pinned)
  const active = threads.filter((t) => !t.pinned && t.running)
  const rest = threads.filter((t) => !t.pinned && !t.running)

  const renderItem = (t: (typeof threads)[number]): React.JSX.Element => (
    <button
      key={t.id}
      className={`thread-item ${t.id === activeId ? 'active' : ''}`}
      onClick={() => void selectThread(t.id)}
    >
      <span className="row">
        {t.running && <span className="running-dot" aria-label="running" />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t.title}
        </span>
      </span>
      {t.lastMessagePreview && <span className="preview">{t.lastMessagePreview}</span>}
    </button>
  )

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => void newThread()}>
          + New
        </button>
      </div>
      <div className="sidebar-list">
        {pinned.length > 0 && (
          <>
            <div className="side-section">Pinned</div>
            {pinned.map(renderItem)}
          </>
        )}
        {active.length > 0 && (
          <>
            <div className="side-section">Active</div>
            {active.map(renderItem)}
          </>
        )}
        <div className="side-section">Threads</div>
        {rest.map(renderItem)}
        {threads.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 12.5 }}>No threads yet.</div>
        )}
      </div>
    </aside>
  )
}
