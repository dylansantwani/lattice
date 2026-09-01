import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ThreadMeta, ThreadSearchHit } from '@shared/types'
import { useStore } from '@/state/store'
import { I } from './Icon'

interface MenuState {
  id: string
  x: number
  y: number
}

export function Sidebar(): React.JSX.Element {
  const threads = useStore((s) => s.threads)
  const activeId = useStore((s) => s.activeThreadId)
  const completedThreads = useStore((s) => s.completedThreads)
  const selectThread = useStore((s) => s.selectThread)
  const newThread = useStore((s) => s.newThread)
  const renameThread = useStore((s) => s.renameThread)
  const setThreadPinned = useStore((s) => s.setThreadPinned)
  const setThreadArchived = useStore((s) => s.setThreadArchived)
  const deleteThread = useStore((s) => s.deleteThread)
  const setUi = useStore((s) => s.setUi)

  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  // in-thread content matches from the backend, keyed by thread id (empty when not searching)
  const [contentHits, setContentHits] = useState<Map<string, ThreadSearchHit>>(new Map())

  // Search message bodies (not just titles/previews) via the main process, debounced.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setContentHits(new Map())
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.lattice
        .searchThreads(q)
        .then((hits) => {
          if (!cancelled) setContentHits(new Map(hits.map((h) => [h.threadId, h])))
        })
        .catch(() => {
          if (!cancelled) setContentHits(new Map())
        })
    }, 160)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return threads
    return threads.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.lastMessagePreview ?? '').toLowerCase().includes(q) ||
        contentHits.has(t.id)
    )
  }, [threads, query, contentHits])

  const active = filtered.filter((t) => !t.archived)
  const pinned = active.filter((t) => t.pinned)
  const rest = active.filter((t) => !t.pinned)
  const archived = filtered.filter((t) => t.archived)

  const startRename = (t: ThreadMeta): void => {
    setMenu(null)
    setRenamingId(t.id)
    setRenameValue(t.title)
  }

  const commitRename = (): void => {
    if (renamingId) {
      const value = renameValue.trim()
      if (value) void renameThread(renamingId, value)
    }
    setRenamingId(null)
  }

  const openMenu = (e: React.MouseEvent, id: string): void => {
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu((m) => (m?.id === id ? null : { id, x: r.right, y: r.bottom + 4 }))
  }

  const menuThread = menu ? threads.find((t) => t.id === menu.id) ?? null : null

  const q = query.trim()

  const renderItem = (t: ThreadMeta): React.JSX.Element => {
    const hit = q ? contentHits.get(t.id) : undefined
    // only surface the snippet when the match is in the body, not already visible in the title
    const showSnippet = !!hit && !t.title.toLowerCase().includes(q.toLowerCase())
    return (
    <div
      key={t.id}
      className={`thread-item ${t.id === activeId ? 'active' : ''} ${
        menu?.id === t.id ? 'menu-open' : ''
      } ${showSnippet ? 'has-snippet' : ''}`}
      onContextMenu={(e) => openMenu(e, t.id)}
    >
      {renamingId === t.id ? (
        <input
          className="thread-rename"
          value={renameValue}
          autoFocus
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            else if (e.key === 'Escape') setRenamingId(null)
          }}
          onBlur={commitRename}
          aria-label="Rename thread"
        />
      ) : (
        <button
          className="thread-item-main"
          onClick={() => void selectThread(t.id)}
          onDoubleClick={() => startRename(t)}
        >
          <span className="thread-line">
            <span className="title">{highlight(t.title, q)}</span>
            {t.running ? (
              <span className="run-spinner" role="status" aria-label="running" />
            ) : (
              completedThreads.has(t.id) && (
                <span className="done-dot" aria-label="completed" />
              )
            )}
            {t.pinned && !t.archived && <I name="keep" size={15} />}
          </span>
          {showSnippet && hit && (
            <span className="thread-snippet">
              <I name={hit.role === 'user' ? 'person' : 'auto_awesome'} size={12} />
              <span className="snippet-text">{highlight(hit.snippet, q)}</span>
            </span>
          )}
        </button>
      )}
      <button
        className="thread-kebab"
        onClick={(e) => openMenu(e, t.id)}
        aria-label="Thread actions"
        aria-haspopup="menu"
      >
        <I name="more_vert" size={16} />
      </button>
    </div>
    )
  }

  return (
    <aside className="sidebar">
      <div className="pane-header">
        <div className="brand">
          <div className="name">Lattice</div>
        </div>
      </div>

      <div className="sidebar-tools">
        <div className="search-field">
          <I name="search" size={16} style={{ color: 'var(--text-faint)' }} />
          <input
            placeholder="Search threads & messages…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search threads and messages"
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
        {active.length === 0 && (
          <div style={{ padding: '8px 10px', color: 'var(--text-faint)', fontSize: 12.5 }}>
            {threads.filter((t) => !t.archived).length === 0 ? 'No threads yet.' : 'No matches.'}
          </div>
        )}

        {archived.length > 0 && (
          <>
            <button
              className="archived-toggle"
              onClick={() => setShowArchived((v) => !v)}
              aria-expanded={showArchived}
            >
              <I name={showArchived ? 'expand_more' : 'chevron_right'} size={16} />
              Archived
              <span className="count">{archived.length}</span>
            </button>
            {showArchived && archived.map(renderItem)}
          </>
        )}
      </div>

      <div className="sys-env">
        <span className="label-caps">System environment</span>
        <button className="sys-env-item" onClick={() => setUi({ modelPickerOpen: true })}>
          <I name="account_tree" size={17} />
          Models
        </button>
        <button
          className="sys-env-item"
          onClick={() => setUi({ inspectorOpen: true, inspectorTab: 'mcp' })}
        >
          <I name="hub" size={17} />
          MCP modules
        </button>
        <button className="sys-env-item" onClick={() => setUi({ settingsOpen: true })}>
          <I name="settings" size={17} />
          Settings
        </button>
      </div>

      {menu && menuThread && (
        <ThreadMenu
          x={menu.x}
          y={menu.y}
          thread={menuThread}
          onClose={() => setMenu(null)}
          onRename={() => startRename(menuThread)}
          onTogglePin={() => {
            void setThreadPinned(menuThread.id, !menuThread.pinned)
            setMenu(null)
          }}
          onToggleArchive={() => {
            void setThreadArchived(menuThread.id, !menuThread.archived)
            setMenu(null)
          }}
          onDelete={() => {
            setMenu(null)
            if (window.confirm(`Delete “${menuThread.title}”? This can't be undone.`)) {
              void deleteThread(menuThread.id)
            }
          }}
        />
      )}
    </aside>
  )
}

/** Wrap every case-insensitive occurrence of `query` in `text` with a <mark>. */
function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim()
  if (!q) return text
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  const parts: React.ReactNode[] = []
  let i = 0
  let key = 0
  while (i <= text.length) {
    const idx = lower.indexOf(ql, i)
    if (idx < 0) {
      parts.push(text.slice(i))
      break
    }
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(
      <mark key={key++} className="search-hit">
        {text.slice(idx, idx + q.length)}
      </mark>
    )
    i = idx + q.length
  }
  return parts
}

function ThreadMenu({
  x,
  y,
  thread,
  onClose,
  onRename,
  onTogglePin,
  onToggleArchive,
  onDelete
}: {
  x: number
  y: number
  thread: ThreadMeta
  onClose(): void
  onRename(): void
  onTogglePin(): void
  onToggleArchive(): void
  onDelete(): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div ref={ref} className="context-menu" style={{ top: y, left: x }} role="menu">
        {!thread.archived && (
          <button className="context-menu-item" role="menuitem" onClick={onTogglePin}>
            <I name={thread.pinned ? 'keep_off' : 'keep'} size={16} />
            {thread.pinned ? 'Unpin' : 'Pin'}
          </button>
        )}
        <button className="context-menu-item" role="menuitem" onClick={onRename}>
          <I name="edit" size={16} />
          Rename
        </button>
        <button className="context-menu-item" role="menuitem" onClick={onToggleArchive}>
          <I name={thread.archived ? 'unarchive' : 'archive'} size={16} />
          {thread.archived ? 'Unarchive' : 'Archive'}
        </button>
        <div className="context-menu-sep" />
        <button className="context-menu-item danger" role="menuitem" onClick={onDelete}>
          <I name="delete" size={16} />
          Delete
        </button>
      </div>
    </>
  )
}
