import React, { useMemo, useState } from 'react'
import { useStore } from '@/state/store'
import { I } from './Icon'

export function Sidebar(): React.JSX.Element {
  const threads = useStore((s) => s.threads)
  const activeId = useStore((s) => s.activeThreadId)
  const selectThread = useStore((s) => s.selectThread)
  const newThread = useStore((s) => s.newThread)
  const setUi = useStore((s) => s.setUi)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return threads
    return threads.filter(
      (t) =>
        t.title.toLowerCase().includes(q) || (t.lastMessagePreview ?? '').toLowerCase().includes(q)
    )
  }, [threads, query])

  const pinned = filtered.filter((t) => t.pinned)
  const rest = filtered.filter((t) => !t.pinned)

  const renderItem = (t: (typeof threads)[number]): React.JSX.Element => (
    <button
      key={t.id}
      className={`thread-item ${t.id === activeId ? 'active' : ''}`}
      onClick={() => void selectThread(t.id)}
    >
      <span className="title">{t.title}</span>
      {t.running && <span className="running-dot" aria-label="running" />}
      {t.pinned && <I name="keep" size={15} />}
    </button>
  )

  return (
    <aside className="sidebar">
      <div className="pane-header">
        <div className="brand">
          <span className="tile">
            <I name="terminal" size={17} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="name">Lattice</div>
            <div className="status">
              <span className="running-dot" style={{ width: 5, height: 5 }} />
              local-first
            </div>
          </div>
        </div>
      </div>

      <div className="sidebar-tools">
        <div className="search-field">
          <I name="search" size={16} style={{ color: 'var(--text-faint)' }} />
          <input
            placeholder="Search threads…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search threads"
          />
        </div>
        <button className="new-session-btn" onClick={() => void newThread()}>
          <I name="add" size={16} />
          New session
        </button>
      </div>

      <div className="sidebar-list">
        {pinned.length > 0 && (
          <>
            <div className="label-caps">Pinned</div>
            {pinned.map(renderItem)}
          </>
        )}
        <div className="label-caps">Recent threads</div>
        {rest.map(renderItem)}
        {filtered.length === 0 && (
          <div style={{ padding: '8px 10px', color: 'var(--text-faint)', fontSize: 12.5 }}>
            {threads.length === 0 ? 'No threads yet.' : 'No matches.'}
          </div>
        )}
      </div>

      <div className="sys-env">
        <span className="label-caps">System environment</span>
        <button className="sys-env-item" onClick={() => setUi({ modelPickerOpen: true })}>
          <I name="account_tree" size={17} />
          Models
        </button>
        <button className="sys-env-item" onClick={() => setUi({ settingsOpen: true })}>
          <I name="hub" size={17} />
          MCP modules
        </button>
        <button className="sys-env-item" onClick={() => setUi({ settingsOpen: true })}>
          <I name="settings" size={17} />
          Settings
        </button>
      </div>
    </aside>
  )
}
