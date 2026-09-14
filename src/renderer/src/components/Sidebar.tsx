import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { AutoGroupBy, SidebarGrouping, ThreadGroup, ThreadMeta, ThreadSearchHit } from '@shared/types'
import { useStore } from '@/state/store'
import { activeThreads, describeActivity } from './sidebarActivity'
import { I } from './Icon'
import { autoBucket, GROUP_COLORS, resolveThreadDrop, runningFirst } from './threadGroups'

interface MenuState {
  id: string
  x: number
  y: number
}

const COLLAPSE_KEY = 'lattice.collapsedGroups'

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function Sidebar(): React.JSX.Element {
  const allThreads = useStore((s) => s.threads)
  // Fleet agents are real threads but live on the Agent Fleet screen, not in the chat list; the
  // phone/texting thread (Telegram, iMessage, calls) is the assistant's one standing conversation
  // and gets its own entry above the list instead of sitting among the chats.
  const threads = useMemo(() => allThreads.filter((t) => !t.isAgent && t.replyStyle !== 'texting'), [allThreads])
  const textingThread = useMemo(() => allThreads.find((t) => t.replyStyle === 'texting' && !t.archived), [allThreads])
  const groups = useStore((s) => s.groups)
  const activeId = useStore((s) => s.activeThreadId)
  const completedThreads = useStore((s) => s.completedThreads)
  const failedThreads = useStore((s) => s.failedThreads)
  // Threads with an approval or a question parked on the user — the model there is stuck until
  // they look, so it outranks the finished/failed marks.
  const approvals = useStore((s) => s.approvals)
  const asks = useStore((s) => s.asks)
  const waitingThreads = React.useMemo(
    () => new Set([...approvals.map((a) => a.threadId), ...asks.map((a) => a.threadId)]),
    [approvals, asks]
  )
  const settings = useStore((s) => s.settings)
  const selectThread = useStore((s) => s.selectThread)
  const stopThreadWork = useStore((s) => s.stopThreadWork)
  // The activity strip: every thread with something going on, in one place, with Stop.
  const activity = React.useMemo(
    () => activeThreads(threads, waitingThreads, failedThreads),
    [threads, waitingThreads, failedThreads]
  )
  const [activityOpen, setActivityOpen] = useState(true)
  const newThread = useStore((s) => s.newThread)
  const renameThread = useStore((s) => s.renameThread)
  const setThreadPinned = useStore((s) => s.setThreadPinned)
  const setThreadArchived = useStore((s) => s.setThreadArchived)
  const deleteThread = useStore((s) => s.deleteThread)
  const createGroup = useStore((s) => s.createGroup)
  const renameGroup = useStore((s) => s.renameGroup)
  const setGroupColor = useStore((s) => s.setGroupColor)
  const deleteGroup = useStore((s) => s.deleteGroup)
  const assignThreadGroup = useStore((s) => s.assignThreadGroup)
  const saveSettings = useStore((s) => s.saveSettings)
  const setUi = useStore((s) => s.setUi)
  const openModelPicker = useStore((s) => s.openModelPicker)

  const grouping: SidebarGrouping = settings?.sidebarGrouping ?? 'flat'
  const autoGroupBy: AutoGroupBy = settings?.autoGroupBy ?? 'date'

  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  // group/bucket ids the user has collapsed (persisted locally; auto buckets and manual groups share the store)
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  // id of the group whose header is being renamed inline (manual mode)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [groupRenameValue, setGroupRenameValue] = useState('')
  const [groupMenu, setGroupMenu] = useState<MenuState | null>(null)
  // in-thread content matches from the backend, keyed by thread id (empty when not searching)
  const [contentHits, setContentHits] = useState<Map<string, ThreadSearchHit>>(new Map())
  // drag-to-file: id of the thread being dragged, and the group block currently hovered as a drop
  // target ('__ungrouped' for the un-file zone). Both null when no drag is in flight.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const toggleCollapsed = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
      } catch {
        /* collapse state is a convenience, not load-bearing */
      }
      return next
    })
  }

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

  const startGroupRename = (g: ThreadGroup): void => {
    setGroupMenu(null)
    setRenamingGroupId(g.id)
    setGroupRenameValue(g.name)
  }
  const commitGroupRename = (): void => {
    if (renamingGroupId) {
      const value = groupRenameValue.trim()
      if (value) void renameGroup(renamingGroupId, value)
    }
    setRenamingGroupId(null)
  }

  const openMenu = (e: React.MouseEvent, id: string): void => {
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setGroupMenu(null)
    setMenu((m) => (m?.id === id ? null : { id, x: r.right, y: r.bottom + 4 }))
  }
  const openGroupMenu = (e: React.MouseEvent, id: string): void => {
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu(null)
    setGroupMenu((m) => (m?.id === id ? null : { id, x: r.right, y: r.bottom + 4 }))
  }

  // Finish a drag by filing the dragged thread into `groupId` (null un-files it). No-op when the
  // thread is already there. Always clears the drag state, even on a rejected/duplicate drop.
  const dropThreadOnGroup = (groupId: string | null): void => {
    const id = draggingId
    setDraggingId(null)
    setDropTargetId(null)
    if (!id) return
    const decision = resolveThreadDrop(threads.find((t) => t.id === id)?.groupId, groupId)
    if (decision) void assignThreadGroup(id, decision.groupId)
  }
  // The dragged thread can be un-filed only when it actually sits in a group — otherwise there's
  // nothing to remove it from, so we don't offer an empty "Ungrouped" drop zone.
  const draggingThread = draggingId ? threads.find((t) => t.id === draggingId) ?? null : null
  const canDropUngrouped = !!draggingThread?.groupId

  const menuThread = menu ? threads.find((t) => t.id === menu.id) ?? null : null
  const menuGroup = groupMenu ? groups.find((g) => g.id === groupMenu.id) ?? null : null

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
      } ${showSnippet ? 'has-snippet' : ''} ${draggingId === t.id ? 'dragging' : ''}`}
      // Draggable so it can be filed into a group by dropping onto a header. Disabled mid-rename so
      // the parent's drag doesn't swallow text selection in the rename input.
      draggable={renamingId !== t.id}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/lattice-thread', t.id)
        e.dataTransfer.effectAllowed = 'move'
        setDraggingId(t.id)
      }}
      onDragEnd={() => {
        setDraggingId(null)
        setDropTargetId(null)
      }}
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
            {waitingThreads.has(t.id) && t.id !== activeId ? (
              <span className="attention-dot" aria-label="waiting on you" title="An approval or a question is waiting on you here" />
            ) : t.running ? (
              <span className="run-spinner" role="status" aria-label="running" />
            ) : failedThreads.has(t.id) ? (
              <span className="fail-dot" aria-label="failed" title="Something failed here while you were away" />
            ) : (
              completedThreads.has(t.id) && (
                <span className="done-dot" aria-label="completed" />
              )
            )}
          </span>
          {showSnippet && hit && (
            <span className="thread-snippet">
              <I name={hit.role === 'user' ? 'person' : 'auto_awesome'} size={12} />
              <span className="snippet-text">{highlight(hit.snippet, q)}</span>
            </span>
          )}
        </button>
      )}
      {!t.archived && (
        <button
          className={`thread-pin ${t.pinned ? 'on' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            void setThreadPinned(t.id, !t.pinned)
          }}
          aria-label={t.pinned ? 'Unpin thread' : 'Pin thread'}
          aria-pressed={t.pinned}
          title={t.pinned ? 'Unpin' : 'Pin to top'}
        >
          <I name="keep" size={15} />
        </button>
      )}
      <button
        className="thread-archive"
        onClick={(e) => {
          e.stopPropagation()
          void setThreadArchived(t.id, !t.archived)
        }}
        aria-label={t.archived ? 'Unarchive thread' : 'Archive thread'}
        aria-pressed={t.archived}
        title={t.archived ? 'Unarchive' : 'Archive'}
      >
        <I name={t.archived ? 'unarchive' : 'archive'} size={15} />
      </button>
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

  const renderSectionBody = (): React.JSX.Element => {
    // A live search is a cross-cutting view: fall back to the flat list so results aren't hidden
    // inside collapsed groups. Grouping resumes when the query clears.
    if (q) return <FlatBody active={active} renderItem={renderItem} />
    if (grouping === 'manual') {
      return (
        <ManualBody
          active={active}
          groups={groups}
          collapsed={collapsed}
          toggleCollapsed={toggleCollapsed}
          renderItem={renderItem}
          renamingGroupId={renamingGroupId}
          groupRenameValue={groupRenameValue}
          setGroupRenameValue={setGroupRenameValue}
          commitGroupRename={commitGroupRename}
          cancelGroupRename={() => setRenamingGroupId(null)}
          openGroupMenu={openGroupMenu}
          groupMenuId={groupMenu?.id ?? null}
          onNewGroup={() => void createGroup('New group')}
          dragging={draggingId !== null}
          dropTargetId={dropTargetId}
          setDropTarget={setDropTargetId}
          onDropThread={dropThreadOnGroup}
          canDropUngrouped={canDropUngrouped}
        />
      )
    }
    if (grouping === 'auto') {
      return (
        <AutoBody
          active={active}
          by={autoGroupBy}
          collapsed={collapsed}
          toggleCollapsed={toggleCollapsed}
          renderItem={renderItem}
        />
      )
    }
    return <FlatBody active={active} renderItem={renderItem} />
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

      {textingThread && (
        <button
          className={`sidebar-texting${textingThread.id === activeId ? ' current' : ''}`}
          onClick={() => void selectThread(textingThread.id)}
          title="Your phone assistant — Telegram, iMessage and calls land here (lattice channels)"
          aria-label="Open the phone assistant conversation"
        >
          <I name="smartphone" size={16} />
          <span className="sidebar-texting-title">Phone assistant</span>
          {waitingThreads.has(textingThread.id) ? (
            <span className="attention-dot" aria-label="waiting on you" />
          ) : textingThread.running ? (
            <span className="run-spinner" aria-label="running" />
          ) : null}
        </button>
      )}

      {activity.length > 0 && (
        <div className={`sidebar-activity${activityOpen ? ' open' : ''}`} role="region" aria-label="Active work">
          <button className="sidebar-activity-head" onClick={() => setActivityOpen((v) => !v)} aria-expanded={activityOpen}>
            <I name="bolt" size={14} />
            <span>{describeActivity(activity)}</span>
            <I name={activityOpen ? 'expand_less' : 'expand_more'} size={14} className="chev" />
          </button>
          {activityOpen && (
            <ul className="sidebar-activity-list">
              {activity.map((e) => (
                <li key={e.threadId} className={`sidebar-activity-item ${e.state}${e.threadId === activeId ? ' current' : ''}`}>
                  <button className="sidebar-activity-open" onClick={() => void selectThread(e.threadId)} title={e.title}>
                    {e.state === 'waiting' ? (
                      <span className="attention-dot" aria-label="waiting on you" />
                    ) : e.state === 'running' ? (
                      <span className="run-spinner" aria-label="running" />
                    ) : (
                      <span className="fail-dot" aria-label="failed" />
                    )}
                    <span className="sidebar-activity-title">{e.title}</span>
                  </button>
                  {e.state !== 'failed' && (
                    <button
                      className="sidebar-activity-stop"
                      onClick={() => void stopThreadWork(e.threadId)}
                      aria-label={`Stop everything on ${e.title}`}
                      title="Stop the run, its subagents, and its jobs"
                    >
                      <I name="stop" size={13} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Organization control: flat recency, user folders, or automatic buckets. Hidden while
          searching, since search always shows a flat result list. */}
      {!q && (
        <div className="group-controls">
          <div className="seg" role="tablist" aria-label="Organize threads">
            {(['flat', 'manual', 'auto'] as SidebarGrouping[]).map((mode) => (
              <button
                key={mode}
                role="tab"
                aria-selected={grouping === mode}
                className={`seg-btn ${grouping === mode ? 'on' : ''}`}
                onClick={() => void saveSettings({ sidebarGrouping: mode })}
                title={
                  mode === 'flat'
                    ? 'Flat list, most recent first'
                    : mode === 'manual'
                      ? 'Your own groups'
                      : 'Grouped automatically'
                }
              >
                <I name={mode === 'flat' ? 'list' : mode === 'manual' ? 'folder' : 'auto_awesome'} size={15} />
                {mode === 'flat' ? 'Recent' : mode === 'manual' ? 'Groups' : 'Auto'}
              </button>
            ))}
          </div>
          {grouping === 'auto' && (
            <div className="auto-by">
              <span className="auto-by-label">Group by</span>
              {(['date', 'model', 'mode'] as AutoGroupBy[]).map((by) => (
                <button
                  key={by}
                  className={`auto-by-btn ${autoGroupBy === by ? 'on' : ''}`}
                  onClick={() => void saveSettings({ autoGroupBy: by })}
                >
                  {by === 'date' ? 'Date' : by === 'model' ? 'Model' : 'Mode'}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="sidebar-list">
        {renderSectionBody()}

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
        <button className="sys-env-item" onClick={() => openModelPicker()}>
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
          groups={groups}
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
          onAssignGroup={(groupId) => {
            void assignThreadGroup(menuThread.id, groupId)
            setMenu(null)
          }}
          onCreateGroup={(name) => {
            void createGroup(name, { assign: menuThread.id })
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

      {groupMenu && menuGroup && (
        <GroupMenu
          x={groupMenu.x}
          y={groupMenu.y}
          group={menuGroup}
          onClose={() => setGroupMenu(null)}
          onRename={() => startGroupRename(menuGroup)}
          onColor={(color) => {
            void setGroupColor(menuGroup.id, color)
          }}
          onDelete={() => {
            setGroupMenu(null)
            const count = threads.filter((t) => t.groupId === menuGroup.id).length
            const note = count
              ? `Delete group “${menuGroup.name}”? Its ${count} thread${count === 1 ? '' : 's'} will be kept and un-filed.`
              : `Delete group “${menuGroup.name}”?`
            if (window.confirm(note)) void deleteGroup(menuGroup.id)
          }}
        />
      )}
    </aside>
  )
}

// ---------- section bodies ----------

/** The classic flat list: pinned first, then everything else by recency. */
function FlatBody({
  active,
  renderItem
}: {
  active: ThreadMeta[]
  renderItem: (t: ThreadMeta) => React.JSX.Element
}): React.JSX.Element {
  const pinned = active.filter((t) => t.pinned)
  const rest = active.filter((t) => !t.pinned)
  return (
    <>
      {pinned.length > 0 && (
        <>
          <div className="label-caps">Pinned</div>
          {pinned.map(renderItem)}
        </>
      )}
      {rest.length > 0 && <div className="label-caps">Recent threads</div>}
      {rest.map(renderItem)}
    </>
  )
}

/** User-defined folders. Threads with no group land under "Ungrouped" at the bottom. */
function ManualBody({
  active,
  groups,
  collapsed,
  toggleCollapsed,
  renderItem,
  renamingGroupId,
  groupRenameValue,
  setGroupRenameValue,
  commitGroupRename,
  cancelGroupRename,
  openGroupMenu,
  groupMenuId,
  onNewGroup,
  dragging,
  dropTargetId,
  setDropTarget,
  onDropThread,
  canDropUngrouped
}: {
  active: ThreadMeta[]
  groups: ThreadGroup[]
  collapsed: Set<string>
  toggleCollapsed: (key: string) => void
  renderItem: (t: ThreadMeta) => React.JSX.Element
  renamingGroupId: string | null
  groupRenameValue: string
  setGroupRenameValue: (v: string) => void
  commitGroupRename: () => void
  cancelGroupRename: () => void
  openGroupMenu: (e: React.MouseEvent, id: string) => void
  groupMenuId: string | null
  onNewGroup: () => void
  dragging: boolean
  dropTargetId: string | null
  setDropTarget: React.Dispatch<React.SetStateAction<string | null>>
  onDropThread: (groupId: string | null) => void
  canDropUngrouped: boolean
}): React.JSX.Element {
  // Shared drop-zone wiring for a group block. `key` is the group id (or '__ungrouped'); `groupId`
  // is what a dropped thread gets filed into (null un-files). preventDefault in dragOver is what
  // marks the element as a valid drop target; the relatedTarget check keeps the highlight from
  // flickering as the cursor moves between the block's children.
  const dropZone = (
    key: string,
    groupId: string | null
  ): React.HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (e) => {
      if (!dragging) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropTarget((cur) => (cur === key ? cur : key))
    },
    onDragLeave: (e) => {
      if (!dragging) return
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setDropTarget((cur) => (cur === key ? null : cur))
      }
    },
    onDrop: (e) => {
      e.preventDefault()
      onDropThread(groupId)
    }
  })
  const byGroup = new Map<string, ThreadMeta[]>()
  for (const t of active) {
    if (!t.groupId) continue
    if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, [])
    byGroup.get(t.groupId)!.push(t)
  }
  const ungrouped = active.filter((t) => !t.groupId || !groups.some((g) => g.id === t.groupId))

  return (
    <>
      {groups.map((g) => {
        const members = byGroup.get(g.id) ?? []
        const isCollapsed = collapsed.has(g.id)
        return (
          <div
            className={`group-block ${dropTargetId === g.id ? 'drop-target' : ''}`}
            key={g.id}
            {...dropZone(g.id, g.id)}
          >
            <div className={`group-header ${groupMenuId === g.id ? 'menu-open' : ''}`}>
              <button
                className="group-toggle"
                onClick={() => toggleCollapsed(g.id)}
                aria-expanded={!isCollapsed}
              >
                <I name={isCollapsed ? 'chevron_right' : 'expand_more'} size={16} />
                <span className="group-dot" style={{ background: `var(--group-${g.color ?? 'violet'})` }} />
                {renamingGroupId === g.id ? (
                  <input
                    className="group-rename"
                    value={groupRenameValue}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setGroupRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitGroupRename()
                      else if (e.key === 'Escape') cancelGroupRename()
                    }}
                    onBlur={commitGroupRename}
                    aria-label="Rename group"
                  />
                ) : (
                  <span className="group-name">{g.name}</span>
                )}
                <span className="count">{members.length}</span>
              </button>
              <button
                className="group-kebab"
                onClick={(e) => openGroupMenu(e, g.id)}
                aria-label="Group actions"
                aria-haspopup="menu"
              >
                <I name="more_vert" size={16} />
              </button>
            </div>
            {!isCollapsed &&
              (members.length ? (
                runningFirst(members).map(renderItem)
              ) : (
                <div className="group-empty">Drag or use ⋮ → Move to group to add threads</div>
              ))}
          </div>
        )
      })}

      {(ungrouped.length > 0 || canDropUngrouped) && (
        <div
          className={`group-block ${dropTargetId === '__ungrouped' ? 'drop-target' : ''}`}
          {...dropZone('__ungrouped', null)}
        >
          <button
            className="group-header ungrouped"
            onClick={() => toggleCollapsed('__ungrouped')}
            aria-expanded={!collapsed.has('__ungrouped')}
          >
            <I name={collapsed.has('__ungrouped') ? 'chevron_right' : 'expand_more'} size={16} />
            <span className="group-name">Ungrouped</span>
            <span className="count">{ungrouped.length}</span>
          </button>
          {!collapsed.has('__ungrouped') &&
            (ungrouped.length ? (
              runningFirst(ungrouped).map(renderItem)
            ) : (
              <div className="group-empty">Drop here to remove from its group</div>
            ))}
        </div>
      )}

      <button className="new-group-btn" onClick={onNewGroup}>
        <I name="create_new_folder" size={16} />
        New group
      </button>
    </>
  )
}

/** Automatic buckets derived from the active threads (date / model / mode). */
function AutoBody({
  active,
  by,
  collapsed,
  toggleCollapsed,
  renderItem
}: {
  active: ThreadMeta[]
  by: AutoGroupBy
  collapsed: Set<string>
  toggleCollapsed: (key: string) => void
  renderItem: (t: ThreadMeta) => React.JSX.Element
}): React.JSX.Element {
  const buckets = useMemo(() => autoBucket(active, by, Date.now()), [active, by])
  return (
    <>
      {buckets.map((b) => {
        const key = `auto:${by}:${b.key}`
        const isCollapsed = collapsed.has(key)
        return (
          <div className="group-block" key={key}>
            <button
              className="group-header"
              onClick={() => toggleCollapsed(key)}
              aria-expanded={!isCollapsed}
            >
              <I name={isCollapsed ? 'chevron_right' : 'expand_more'} size={16} />
              <span className="group-name">{b.label}</span>
              <span className="count">{b.threads.length}</span>
            </button>
            {!isCollapsed && b.threads.map(renderItem)}
          </div>
        )
      })}
    </>
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
  groups,
  onClose,
  onRename,
  onTogglePin,
  onToggleArchive,
  onAssignGroup,
  onCreateGroup,
  onDelete
}: {
  x: number
  y: number
  thread: ThreadMeta
  groups: ThreadGroup[]
  onClose(): void
  onRename(): void
  onTogglePin(): void
  onToggleArchive(): void
  onAssignGroup(groupId: string | null): void
  onCreateGroup(name: string): void
  onDelete(): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // 'main' menu vs the "Move to group" picker view
  const [view, setView] = useState<'main' | 'group'>('main')
  const [newName, setNewName] = useState('')

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
        {view === 'main' ? (
          <>
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
            <button
              className="context-menu-item"
              role="menuitem"
              onClick={() => setView('group')}
              aria-haspopup="menu"
            >
              <I name="drive_file_move" size={16} />
              Move to group
              <I name="chevron_right" size={16} className="menu-chevron" />
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
          </>
        ) : (
          <>
            <button className="context-menu-item back" role="menuitem" onClick={() => setView('main')}>
              <I name="chevron_left" size={16} />
              Move to group
            </button>
            <div className="context-menu-sep" />
            {thread.groupId && (
              <button className="context-menu-item" role="menuitem" onClick={() => onAssignGroup(null)}>
                <I name="folder_off" size={16} />
                Remove from group
              </button>
            )}
            {groups.map((g) => (
              <button
                key={g.id}
                className={`context-menu-item ${thread.groupId === g.id ? 'checked' : ''}`}
                role="menuitem"
                onClick={() => onAssignGroup(g.id)}
              >
                <span className="group-dot" style={{ background: `var(--group-${g.color ?? 'violet'})` }} />
                <span className="menu-label">{g.name}</span>
                {thread.groupId === g.id && <I name="check" size={16} className="menu-chevron" />}
              </button>
            ))}
            <div className="context-menu-sep" />
            <div className="menu-newgroup">
              <input
                className="menu-newgroup-input"
                placeholder="New group…"
                value={newName}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) onCreateGroup(newName.trim())
                  else if (e.key === 'Escape') setView('main')
                }}
                aria-label="New group name"
              />
              <button
                className="menu-newgroup-add"
                disabled={!newName.trim()}
                onClick={() => newName.trim() && onCreateGroup(newName.trim())}
                aria-label="Create group and move here"
              >
                <I name="add" size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

function GroupMenu({
  x,
  y,
  group,
  onClose,
  onRename,
  onColor,
  onDelete
}: {
  x: number
  y: number
  group: ThreadGroup
  onClose(): void
  onRename(): void
  onColor(color: string): void
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
        <button className="context-menu-item" role="menuitem" onClick={onRename}>
          <I name="edit" size={16} />
          Rename group
        </button>
        <div className="menu-swatches" role="group" aria-label="Group color">
          {GROUP_COLORS.map((c) => (
            <button
              key={c}
              className={`swatch ${group.color === c || (!group.color && c === 'violet') ? 'on' : ''}`}
              style={{ background: `var(--group-${c})` }}
              onClick={() => onColor(c)}
              aria-label={`Color ${c}`}
              title={c}
            />
          ))}
        </div>
        <div className="context-menu-sep" />
        <button className="context-menu-item danger" role="menuitem" onClick={onDelete}>
          <I name="delete" size={16} />
          Delete group
        </button>
      </div>
    </>
  )
}
