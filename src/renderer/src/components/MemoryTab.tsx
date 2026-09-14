import React from 'react'
import type { MemoryBulkAction, MemoryDuplicatePair, MemoryItem, MemorySweepReport } from '@shared/types'
import { I } from './Icon'
import { relativeTime } from './usageStats'

/**
 * The Memory inspector tab: the curation surface the memory system depends on. Everything the
 * model can only get from here lives here — pinning (the one field that puts a memory into every
 * prompt), inline editing, review of proposals, bulk actions, and merging near-duplicates. The
 * list uses `content-visibility: auto` so a thousand rows lay out lazily instead of on every
 * render, and a search box that runs through the same full-text ranker the model's recall uses.
 */

type StatusFilter = 'all' | 'proposed' | 'approved' | 'pinned' | 'expired' | 'rejected'
type OriginFilter = 'all' | 'learned' | 'saved' | 'user' | 'claude-code' | 'hermes'
type ScopeFilter = 'all' | 'user' | 'workspace' | 'thread'
type View = 'list' | 'duplicates'

/** Which external store an imported memory came from (mirrors the main-process bridge id scheme). */
export function memoryOrigin(id: string): 'Claude Code' | 'Hermes' | null {
  if (id.startsWith('mem:cc:')) return 'Claude Code'
  if (id.startsWith('mem:hermes:')) return 'Hermes'
  return null
}

function originKey(m: MemoryItem): OriginFilter {
  if (m.id.startsWith('mem:cc:')) return 'claude-code'
  if (m.id.startsWith('mem:hermes:')) return 'hermes'
  if (m.author === 'user') return 'user'
  // A model row with a source event came from `memory_save` mid-run; distilled rows have none.
  return m.sourceEventId ? 'saved' : 'learned'
}

/** Pure filter over the loaded rows; exported for tests. */
export function filterMemories(
  items: MemoryItem[],
  f: { status: StatusFilter; origin: OriginFilter; scope: ScopeFilter }
): MemoryItem[] {
  return items.filter((m) => {
    if (f.status === 'pinned' ? !m.pinned : f.status !== 'all' && m.status !== f.status) return false
    if (f.origin !== 'all' && originKey(m) !== f.origin) return false
    if (f.scope !== 'all' && m.scope !== f.scope && !(f.scope === 'workspace' && m.scope === 'project')) return false
    return true
  })
}

export function MemoryTab(): React.JSX.Element {
  const [items, setItems] = React.useState<MemoryItem[]>([])
  const [query, setQuery] = React.useState('')
  const [hits, setHits] = React.useState<MemoryItem[] | null>(null)
  const [status, setStatus] = React.useState<StatusFilter>('all')
  const [origin, setOrigin] = React.useState<OriginFilter>('all')
  const [scope, setScope] = React.useState<ScopeFilter>('all')
  const [view, setView] = React.useState<View>('list')
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [syncing, setSyncing] = React.useState(false)
  const [note, setNote] = React.useState<string | null>(null)
  const [dupes, setDupes] = React.useState<MemoryDuplicatePair[] | null>(null)

  const refresh = React.useCallback(() => {
    void window.lattice.listMemory().then(setItems)
    if (view === 'duplicates') void window.lattice.listMemoryDuplicates().then(setDupes)
  }, [view])
  React.useEffect(refresh, [refresh])
  React.useEffect(
    () => window.lattice.onPush((event) => event.kind === 'memory.updated' && refresh()),
    [refresh]
  )

  // Search runs through the main-process ranker (same FTS index the tool uses), debounced.
  React.useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      return
    }
    const t = setTimeout(() => void window.lattice.searchMemory(q).then(setHits), 150)
    return () => clearTimeout(t)
  }, [query])

  const sync = async (): Promise<void> => {
    setSyncing(true)
    setNote(null)
    try {
      const r = await window.lattice.syncMemory()
      const inPer = r.sources.map((s) => `${s.label} ${s.error ? '⚠' : s.found}`).join(' · ')
      const wrote = r.exported.reduce((a, e) => a + e.wrote, 0)
      setNote(`↓ ${inPer} (+${r.added} new, ${r.updated} upd, ${r.removed} pruned) · ↑ ${wrote} shared`)
      refresh()
    } catch (err) {
      setNote(`Sync failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSyncing(false)
    }
  }

  const sweep = async (): Promise<void> => {
    const r: MemorySweepReport = await window.lattice.sweepMemory()
    setNote(
      `Sweep: ${r.expired} expired, ${r.retired} retired (never used in 60 days), ` +
        `${r.deletedRejected + r.deletedExpired} purged.`
    )
    refresh()
  }

  const bulk = async (action: MemoryBulkAction, ids = [...selected]): Promise<void> => {
    if (ids.length === 0) return
    const n = await window.lattice.bulkMemory(ids, action)
    setNote(`${action === 'delete' ? 'Deleted' : action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : action === 'pin' ? 'Pinned' : 'Unpinned'} ${n}.`)
    setSelected(new Set())
    refresh()
  }

  const base = hits ?? items
  const visible = React.useMemo(() => filterMemories(base, { status, origin, scope }), [base, status, origin, scope])
  const counts = React.useMemo(
    () => ({
      proposed: items.filter((m) => m.status === 'proposed').length,
      pinned: items.filter((m) => m.pinned).length,
      imported: items.filter((m) => memoryOrigin(m.id)).length
    }),
    [items]
  )
  const allVisibleSelected = visible.length > 0 && visible.every((m) => selected.has(m.id))
  const toggleAll = (): void =>
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((m) => m.id)))
  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="mem">
      <div className="mem-head">
        <h4 style={{ margin: 0 }}>
          Memory <span className="mem-count">{items.length}</span>
        </h4>
        <div className="mem-head-actions">
          <button
            className={`btn tiny ${view === 'duplicates' ? 'on' : ''}`}
            onClick={() => setView(view === 'duplicates' ? 'list' : 'duplicates')}
            title="Find near-duplicate memories and merge them"
          >
            <I name="join_inner" size={13} /> Duplicates
          </button>
          <button className="btn tiny" onClick={() => void sweep()} title="Expire stale items and purge rejected ones now">
            <I name="cleaning_services" size={13} /> Sweep
          </button>
          <button className="btn tiny" onClick={() => void sync()} disabled={syncing} title="Re-read Claude Code & Hermes memory and write approved Lattice memories back">
            <I name={syncing ? 'autorenew' : 'sync'} size={13} className={syncing ? 'spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      </div>
      <div className="mem-note">
        {note ??
          `${counts.pinned} pinned ride in every prompt · ${counts.proposed} awaiting review · ${counts.imported} imported from Claude Code & Hermes.`}
      </div>

      {view === 'duplicates' ? (
        <DuplicatesView pairs={dupes} onChanged={refresh} />
      ) : (
        <>
          <div className="mem-search">
            <I name="search" size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memory (same ranker the model uses)"
              aria-label="Search memory"
            />
            {query && (
              <button className="icon-btn" onClick={() => setQuery('')} aria-label="Clear search">
                <I name="close" size={14} />
              </button>
            )}
          </div>
          <div className="mem-filters">
            <Seg
              value={status}
              onChange={setStatus}
              options={[
                ['all', 'All'],
                ['proposed', counts.proposed ? `Proposed (${counts.proposed})` : 'Proposed'],
                ['approved', 'Approved'],
                ['pinned', 'Pinned'],
                ['expired', 'Expired'],
                ['rejected', 'Rejected']
              ]}
            />
            <Seg
              value={origin}
              onChange={setOrigin}
              options={[
                ['all', 'Any source'],
                ['learned', 'Learned'],
                ['saved', 'Saved by model'],
                ['user', 'Written by you'],
                ['claude-code', 'Claude Code'],
                ['hermes', 'Hermes']
              ]}
            />
            <Seg
              value={scope}
              onChange={setScope}
              options={[
                ['all', 'Any scope'],
                ['user', 'User'],
                ['workspace', 'Workspace'],
                ['thread', 'Thread']
              ]}
            />
          </div>

          <div className="mem-bulk">
            <label className="mem-select-all">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="Select all visible" />
              <span>
                {selected.size ? `${selected.size} selected` : `${visible.length} shown`}
              </span>
            </label>
            {selected.size > 0 && (
              <div className="mem-bulk-actions">
                <button className="btn tiny" onClick={() => void bulk('approve')}>Approve</button>
                <button className="btn tiny" onClick={() => void bulk('reject')}>Reject</button>
                <button className="btn tiny" onClick={() => void bulk('pin')}>Pin</button>
                <button className="btn tiny" onClick={() => void bulk('unpin')}>Unpin</button>
                <button className="btn tiny danger" onClick={() => void bulk('delete')}>Delete</button>
              </div>
            )}
          </div>

          <div className="mem-list">
            {visible.map((m) => (
              <MemoryRow
                key={m.id}
                item={m}
                selected={selected.has(m.id)}
                onSelect={() => toggle(m.id)}
                onChanged={refresh}
                onNote={setNote}
              />
            ))}
            {visible.length === 0 && (
              <div className="mem-empty">
                {hits ? 'No memories match that search.' : items.length ? 'Nothing matches these filters.' : 'No memories saved yet.'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Seg<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (v: T) => void
  options: [T, string][]
}): React.JSX.Element {
  return (
    <div className="mem-seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button
          key={v}
          className={`seg-btn ${value === v ? 'on' : ''}`}
          onClick={() => onChange(v)}
          role="radio"
          aria-checked={value === v}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function MemoryRow({
  item: m,
  selected,
  onSelect,
  onChanged,
  onNote
}: {
  item: MemoryItem
  selected: boolean
  onSelect: () => void
  onChanged: () => void
  onNote: (s: string) => void
}): React.JSX.Element {
  const origin = memoryOrigin(m.id)
  const imported = !!origin
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(m.content)
  React.useEffect(() => {
    if (!editing) setDraft(m.content)
  }, [m.content, editing])

  const save = async (patch: Partial<MemoryItem>): Promise<void> => {
    await window.lattice.upsertMemory({ ...m, ...patch })
    onChanged()
  }
  const commitEdit = async (): Promise<void> => {
    const next = draft.trim()
    setEditing(false)
    if (!next || next === m.content) return
    await save({ content: next })
    onNote('Edited — the model sees the new wording on its next recall.')
  }
  const remove = async (): Promise<void> => {
    await window.lattice.deleteMemory(m.id)
    onChanged()
  }

  const expired = m.status === 'expired'
  const expiresSoon = m.expiresAt && m.status === 'approved' ? m.expiresAt - Date.now() < 14 * 24 * 3600_000 : false
  return (
    <div className={`mem-row ${m.status} ${m.pinned ? 'pinned' : ''} ${selected ? 'selected' : ''}`}>
      <div className="mem-row-head">
        <input type="checkbox" checked={selected} onChange={onSelect} aria-label="Select memory" />
        {origin && <span className="mem-badge origin">{origin}</span>}
        <span className="mem-meta">
          {m.scope === 'project' ? 'workspace' : m.scope} · {m.type} · {imported ? 'imported' : m.author === 'user' ? 'you' : m.sourceEventId ? 'saved by model' : 'learned'}
          {m.version > 1 && !imported ? ` · v${m.version}` : ''}
        </span>
        {m.status === 'proposed' && <span className="mem-badge proposed">proposed</span>}
        {expired && <span className="mem-badge expired">expired</span>}
        {m.status === 'rejected' && <span className="mem-badge rejected">rejected</span>}
        {m.useCount > 0 && (
          <span className="mem-badge used" title={m.lastUsedAt ? `Last recalled ${relativeTime(m.lastUsedAt)}` : undefined}>
            used {m.useCount}×
          </span>
        )}
        {!expired && m.expiresAt && (
          <span className={`mem-badge ttl ${expiresSoon ? 'soon' : ''}`} title={new Date(m.expiresAt).toLocaleString()}>
            lapses {untilTime(m.expiresAt)}
          </span>
        )}
        <span className="mem-spacer" />
        <button
          className={`icon-btn mem-pin ${m.pinned ? 'on' : ''}`}
          onClick={() => void save({ pinned: !m.pinned, ...(m.pinned ? {} : { status: 'approved' as const }) })}
          title={m.pinned ? 'Unpin — recalled on demand only' : 'Pin — ride in every prompt'}
          aria-label={m.pinned ? 'Unpin memory' : 'Pin memory'}
        >
          <I name="push_pin" size={14} />
        </button>
      </div>
      {editing ? (
        <textarea
          className="mem-edit"
          value={draft}
          rows={Math.min(10, Math.max(2, Math.ceil(draft.length / 60)))}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setEditing(false)
              setDraft(m.content)
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void commitEdit()
          }}
        />
      ) : (
        <div className="mem-content" onDoubleClick={() => !imported && setEditing(true)} title={imported ? undefined : 'Double-click to edit'}>
          {m.content}
        </div>
      )}
      <div className="mem-row-actions">
        {editing ? (
          <>
            <button className="btn tiny primary" onClick={() => void commitEdit()}>Save</button>
            <button className="btn tiny" onClick={() => { setEditing(false); setDraft(m.content) }}>Cancel</button>
          </>
        ) : (
          <>
            {!imported && (m.status === 'proposed' || m.status === 'expired' || m.status === 'rejected') && (
              <button className="btn tiny approve" onClick={() => void save({ status: 'approved' })}>
                {m.status === 'proposed' ? 'Approve' : 'Re-approve'}
              </button>
            )}
            {!imported && m.status === 'proposed' && (
              <button className="btn tiny" onClick={() => void save({ status: 'rejected' })}>Reject</button>
            )}
            {!imported && (
              <button className="btn tiny" onClick={() => setEditing(true)}>Edit</button>
            )}
            {!imported && (
              <button className="btn tiny danger" onClick={() => void remove()}>Delete</button>
            )}
            {imported && <span className="mem-imported-hint">Edit this in its source file; Sync mirrors it.</span>}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Near-duplicate pairs with one-click merge. "Keep" is the longer (more informative) row by
 * default; the other's usage, pin, and review state fold into it. The bulk button merges every
 * pair the finder is confident about (score ≥ 0.8) in one go.
 */
function DuplicatesView({
  pairs,
  onChanged
}: {
  pairs: MemoryDuplicatePair[] | null
  onChanged: () => void
}): React.JSX.Element {
  const [busy, setBusy] = React.useState(false)
  const merge = async (keep: MemoryItem, drop: MemoryItem): Promise<void> => {
    await window.lattice.mergeMemory(keep.id, [drop.id])
    onChanged()
  }
  const mergeConfident = async (): Promise<void> => {
    if (!pairs) return
    setBusy(true)
    try {
      // Union-find over confident pairs so a 5-way duplicate cluster collapses into one survivor.
      const parent = new Map<string, string>()
      const find = (id: string): string => {
        let r = id
        while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!
        return r
      }
      const items = new Map<string, MemoryItem>()
      for (const p of pairs.filter((p) => p.score >= 0.8)) {
        items.set(p.a.id, p.a)
        items.set(p.b.id, p.b)
        if (!parent.has(p.a.id)) parent.set(p.a.id, p.a.id)
        if (!parent.has(p.b.id)) parent.set(p.b.id, p.b.id)
        parent.set(find(p.a.id), find(p.b.id))
      }
      const clusters = new Map<string, MemoryItem[]>()
      for (const id of parent.keys()) {
        const root = find(id)
        clusters.set(root, [...(clusters.get(root) ?? []), items.get(id)!])
      }
      for (const members of clusters.values()) {
        if (members.length < 2) continue
        const keep = [...members].sort((x, y) => preferKeep(x, y))[0]!
        await window.lattice.mergeMemory(
          keep.id,
          members.filter((m) => m.id !== keep.id).map((m) => m.id)
        )
      }
      onChanged()
    } finally {
      setBusy(false)
    }
  }
  if (!pairs) return <div className="mem-empty">Looking for duplicates…</div>
  const confident = pairs.filter((p) => p.score >= 0.8).length
  return (
    <div>
      <div className="mem-bulk">
        <span>
          {pairs.length} near-duplicate pair{pairs.length === 1 ? '' : 's'}
        </span>
        {confident > 0 && (
          <button className="btn tiny primary" disabled={busy} onClick={() => void mergeConfident()}>
            Merge {confident} confident
          </button>
        )}
      </div>
      {pairs.length === 0 && <div className="mem-empty">No near-duplicates. The write-side dedupe is holding.</div>}
      <div className="mem-list">
        {pairs.map((p) => {
          const [keep, drop] = preferKeep(p.a, p.b) <= 0 ? [p.a, p.b] : [p.b, p.a]
          return (
            <div key={`${p.a.id}:${p.b.id}`} className="mem-pair">
              <div className="mem-pair-score">{Math.round(p.score * 100)}% alike</div>
              <div className="mem-pair-item keep">
                <span className="mem-badge">keep</span> {keep.content}
              </div>
              <div className="mem-pair-item drop">
                <span className="mem-badge">merge in</span> {drop.content}
              </div>
              <div className="mem-row-actions">
                <button className="btn tiny primary" onClick={() => void merge(keep, drop)}>Merge</button>
                <button className="btn tiny" onClick={() => void merge(drop, keep)}>Keep the other</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** "in 12d" / "in 3h" for a future timestamp (a past one reads "now"). Exported for tests. */
export function untilTime(ts: number, now: number = Date.now()): string {
  const sec = Math.round((ts - now) / 1000)
  if (sec <= 0) return 'now'
  if (sec < 3600) return `in ${Math.max(1, Math.round(sec / 60))}m`
  if (sec < 86400) return `in ${Math.round(sec / 3600)}h`
  return `in ${Math.round(sec / 86400)}d`
}

/** Sort comparator: which of two duplicates should survive a merge (negative ⇒ `a`). */
export function preferKeep(a: MemoryItem, b: MemoryItem): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if ((a.author === 'user') !== (b.author === 'user')) return a.author === 'user' ? -1 : 1
  if (!!a.reviewedAt !== !!b.reviewedAt) return a.reviewedAt ? -1 : 1
  if (a.content.length !== b.content.length) return b.content.length - a.content.length
  return a.createdAt - b.createdAt
}
