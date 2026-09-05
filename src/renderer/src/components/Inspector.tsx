import React from 'react'
import { useStore } from '@/state/store'
import { fmtTokens, RESERVED, SEGMENT_COLORS, SEGMENT_LABELS } from './ContextOrbit'
import { I } from './Icon'
import { FilesTab } from './FilesTab'
import { TerminalTab } from './TerminalTab'
import { BrowserTab } from './BrowserTab'
import { TasksPanel } from './TasksPanel'
import { AgentsPanel } from './AgentsPanel'
import { useSubagentIndex } from './useSubagentIndex'
import { explainCache } from './cacheInsight'
import { summarizeToolCalls } from './toolStats'
import type { ToolInventoryEntry } from '@shared/types'
import {
  buildTurnUsage,
  cacheRatePct,
  fmtCost,
  modelLabel,
  relativeTime,
  sumTurns,
  totalInputTokens,
  type TurnUsage
} from './usageStats'

const TABS = ['run', 'context', 'files', 'terminal', 'browser', 'tasks', 'memory', 'agents', 'tools', 'mcp'] as const
type Tab = (typeof TABS)[number]

export function Inspector(): React.JSX.Element {
  const tab = useStore((s) => s.ui.inspectorTab) as Tab
  const setUi = useStore((s) => s.setUi)

  // Count only *running* subagents for the live "Agents (N)" tab badge — a finished agent
  // contributes 0, so a quiet panel just reads "agents". Same folded index the panel itself uses.
  const subagents = useSubagentIndex()
  const runningAgents = React.useMemo(() => {
    let n = 0
    for (const a of subagents.byId.values()) if (a.running) n += 1
    return n
  }, [subagents])

  // Background shell jobs live in the same tab: the badge counts everything still working there.
  const runningJobs = useStore((s) => s.jobs.filter((j) => j.running).length)
  const working = runningAgents + runningJobs
  // Open checklist items badge the Tasks tab the same way, so a plan in flight is visible from any tab.
  const openTasks = useStore((s) => s.todos.filter((t) => t.status !== 'done' && t.status !== 'canceled').length)
  const tabLabel = (t: Tab): string => {
    if (t === 'agents') return working > 0 ? `agents (${working})` : 'agents'
    if (t === 'tasks') return openTasks > 0 ? `tasks (${openTasks})` : 'tasks'
    return t
  }

  return (
    <aside className="inspector">
      <div className="pane-header">
        <div className="inspector-title">
          <span className="t">Inspector</span>
          <span className="s">{tabLabel(tab)}</span>
        </div>
        <button
          className="icon-btn"
          onClick={() => setUi({ inspectorOpen: false })}
          aria-label="Collapse inspector"
        >
          <I name="chevron_right" size={19} />
        </button>
      </div>
      <div className="inspector-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={`inspector-tab ${tab === t ? 'active' : ''}`}
            onClick={() => setUi({ inspectorTab: t })}
          >
            {tabLabel(t)}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {tab === 'context' && <ContextTab />}
        {tab === 'run' && <RunTab />}
        {tab === 'files' && <FilesTab />}
        {tab === 'terminal' && <TerminalTab />}
        {tab === 'browser' && <BrowserTab />}
        {tab === 'tasks' && <TasksPanel />}
        {tab === 'memory' && <MemoryTab />}
        {tab === 'agents' && <AgentsPanel />}
        {tab === 'tools' && <ToolsTab />}
        {tab === 'mcp' && <McpTab />}
      </div>
    </aside>
  )
}

function ContextTab(): React.JSX.Element {
  const budget = useStore((s) => s.budget)
  const events = useStore((s) => s.events)
  const models = useStore((s) => s.models)
  const overrides = useStore((s) => s.settings?.costOverrides)
  const cache = React.useMemo(() => {
    const turns = buildTurnUsage(events, models, overrides)
    return explainCache(turns, events)
  }, [events, models, overrides])
  if (!budget) return <div style={{ color: 'var(--text-faint)' }}>No context data yet.</div>
  const all = Object.entries(budget.segments).filter(([, v]) => v > 0)
  const consumed = all.filter(([k]) => !RESERVED.has(k))
  const reserved = all.filter(([k]) => RESERVED.has(k))
  return (
    <div>
      <h4>Occupancy</h4>
      <div className="kv">
        <span className="k">Model</span>
        <span className="v">{budget.model}</span>
      </div>
      <div className="kv">
        <span className="k">Window</span>
        <span className="v">{fmtTokens(budget.contextLength)}</span>
      </div>
      <div className="kv">
        <span className="k">Usable room</span>
        <span className="v">{fmtTokens(budget.usableTokens)}</span>
      </div>
      <div className="kv">
        <span className="k">Used</span>
        <span className="v">
          {fmtTokens(budget.usedTokens)} ({Math.round(budget.occupancy * 100)}%)
        </span>
      </div>
      <div className="seg-bar">
        {consumed.map(([k, v]) => (
          <div
            key={k}
            style={{ width: `${(v / budget.usableTokens) * 100}%`, background: SEGMENT_COLORS[k] }}
            title={`${SEGMENT_LABELS[k]}: ${fmtTokens(v)}`}
          />
        ))}
      </div>
      <h4>What&rsquo;s used</h4>
      {consumed.map(([k, v]) => (
        <SegmentRow key={k} k={k} v={v} />
      ))}
      {reserved.length > 0 && (
        <>
          <h4>Held back (not used)</h4>
          {reserved.map(([k, v]) => (
            <SegmentRow key={k} k={k} v={v} />
          ))}
          <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-faint)' }}>
            Carved off the top of the window — kept free for the reply and a compaction cushion — so
            they shrink usable room rather than counting as used.
          </div>
        </>
      )}
      {budget.prunedTokens ? (
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-faint)' }}>
          Reclaimed {fmtTokens(budget.prunedTokens)} by pruning stale tool results from far-back turns.
        </div>
      ) : null}
      <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-faint)' }}>
        Counts are {budget.exact ? 'provider-exact' : 'a real-tokenizer estimate (BPE, not chars÷4)'}.
      </div>
      {cache && (
        <>
          <h4>Prompt cache (last turn)</h4>
          <div className={`cache-verdict ${cache.verdict}`}>
            <I
              name={
                cache.verdict === 'hit' ? 'bolt' : cache.verdict === 'partial' ? 'bolt' : cache.verdict === 'off' ? 'power_settings_new' : 'ac_unit'
              }
              size={14}
            />
            <span>
              {cache.verdict === 'hit'
                ? 'Hit'
                : cache.verdict === 'partial'
                  ? 'Partial hit'
                  : cache.verdict === 'cold'
                    ? 'Cold — written, not read'
                    : cache.verdict === 'none'
                      ? 'No cache activity'
                      : cache.verdict === 'off'
                        ? 'Caching off'
                        : 'No data yet'}
              {cache.hitRatePct !== null ? ` · ${cache.hitRatePct}% of input from cache` : ''}
            </span>
          </div>
          <div className="kv">
            <span className="k">Read from cache</span>
            <span className="v">{fmtTokens(cache.readTokens)}</span>
          </div>
          <div className="kv">
            <span className="k">Written to cache</span>
            <span className="v">{fmtTokens(cache.writeTokens)}</span>
          </div>
          <div className="kv">
            <span className="k">Fresh (uncached)</span>
            <span className="v">{fmtTokens(cache.freshTokens)}</span>
          </div>
          <ul className="cache-reasons">
            {cache.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function SegmentRow({ k, v }: { k: string; v: number }): React.JSX.Element {
  return (
    <div className="kv">
      <span className="k">
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: 2,
            background: SEGMENT_COLORS[k],
            marginRight: 6
          }}
        />
        {SEGMENT_LABELS[k]}
      </span>
      <span className="v">{fmtTokens(v)}</span>
    </div>
  )
}

function StatTile({
  icon,
  label,
  value,
  accent,
  onClick,
  title
}: {
  icon: string
  label: string
  value: React.ReactNode
  accent?: boolean
  onClick?: () => void
  title?: string
}): React.JSX.Element {
  const cls = `usage-stat${accent ? ' accent' : ''}${onClick ? ' editable' : ''}`
  const body = (
    <>
      <span className="usage-stat-label">
        <I name={icon} size={13} />
        {label}
        {onClick && <I name="edit" size={11} />}
      </span>
      <span className="usage-stat-value">{value}</span>
    </>
  )
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} title={title}>
      {body}
    </button>
  ) : (
    <div className={cls} title={title}>
      {body}
    </div>
  )
}

/** The eight usage/cost metrics for one turn, grouped into an Input breakdown and an
 * Output/activity breakdown, each its own scannable stat-tile grid. Shared by the total and
 * per-turn views (per-turn cards render it slightly smaller via `.usage-turn-card` CSS). */
function TurnMetrics({
  t,
  onEditCost,
  editableModelId
}: {
  t: TurnUsage
  onEditCost?: (modelId: string) => void
  /** Used by the aggregate tile when exactly one locally-priced route contributes to the total. */
  editableModelId?: string | null
}): React.JSX.Element {
  const rate = cacheRatePct(t)
  // The cost is user-adjustable only when it was computed locally (no provider-billed cost) and we
  // know which single route to attribute it to. Mixed-model totals intentionally stay unattributed.
  const editableModel = t.costLocal ? t.model ?? editableModelId ?? null : null
  return (
    <>
      <div className="usage-group-label">Input</div>
      <div className="usage-stat-grid">
        <StatTile icon="functions" label="Total input" value={fmtTokens(totalInputTokens(t))} />
        <StatTile icon="percent" label="Cache rate" value={rate === null ? '—' : `${rate}%`} />
        <StatTile icon="arrow_downward" label="Non-cached" value={fmtTokens(t.freshInputTokens)} />
        <StatTile icon="bolt" label="Cached" value={fmtTokens(t.cachedInputTokens)} />
      </div>
      <div className="usage-group-label">Output &amp; activity</div>
      <div className="usage-stat-grid">
        <StatTile icon="arrow_upward" label="Output" value={fmtTokens(t.outputTokens)} />
        <StatTile icon="neurology" label="Reasoning" value={fmtTokens(t.reasoningTokens)} />
        <StatTile icon="build" label="Tool calls" value={t.toolCalls} />
        <StatTile
          icon="paid"
          label={t.costEstimated ? 'Est. cost' : 'Cost'}
          value={t.costUsd > 0 ? fmtCost(t.costUsd, t.costEstimated) : '—'}
          accent
          onClick={editableModel && onEditCost ? () => onEditCost(editableModel) : undefined}
          title={editableModel ? 'Edit the cost model for this route' : undefined}
        />
      </div>
      {t.rounds > 0 && (
        <>
          <div className="usage-group-label">Where the time went</div>
          <div className="usage-stat-grid">
            <StatTile icon="repeat" label="Rounds" value={t.rounds} />
            <StatTile
              icon="hourglass_top"
              label="First-token waits"
              value={fmtDuration(t.ttftMs)}
              title="Summed time from each round's request to its first token — the cost of every extra round"
            />
            <StatTile icon="smart_toy" label="Model time" value={fmtDuration(t.modelMs)} title="Request to finish, summed over rounds" />
            <StatTile icon="build" label="Tool time" value={t.toolMs > 0 ? fmtDuration(t.toolMs) : '—'} />
          </div>
          <div className="usage-time-note">
            {t.rounds > 1
              ? `${Math.round(t.ttftMs / t.rounds / 100) / 10}s waiting per round × ${t.rounds} rounds. Fewer rounds (more tool calls per response) is the lever.`
              : 'One round.'}
          </div>
        </>
      )}
    </>
  )
}

/** "4.2s" / "1m 05s" for summed timings. */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
}

function RunTab(): React.JSX.Element {
  const events = useStore((s) => s.events)
  const models = useStore((s) => s.models)
  const overrides = useStore((s) => s.settings?.costOverrides)
  const setUi = useStore((s) => s.setUi)
  const [usageView, setUsageView] = React.useState<'total' | 'last' | 'turns'>('total')

  const editCost = React.useCallback((modelId: string) => setUi({ costEditorModel: modelId }), [setUi])
  const turns = React.useMemo(() => buildTurnUsage(events, models, overrides), [events, models, overrides])
  const total = React.useMemo(() => sumTurns(turns), [turns])
  const last = turns[0]
  const editableTotalModel = React.useMemo(() => singleLocalModel(turns), [turns])

  const headLabel =
    usageView === 'total'
      ? 'this thread'
      : usageView === 'last'
        ? 'last message'
        : `${turns.length} turn${turns.length === 1 ? '' : 's'}`

  return (
    <div>
      {turns.length > 0 && (
        <>
          <h4>Usage ({headLabel})</h4>
          <div className="seg" role="tablist" aria-label="Usage view" style={{ marginBottom: 8 }}>
            <button
              className={`seg-btn ${usageView === 'total' ? 'on' : ''}`}
              onClick={() => setUsageView('total')}
            >
              Total
            </button>
            <button
              className={`seg-btn ${usageView === 'last' ? 'on' : ''}`}
              onClick={() => setUsageView('last')}
            >
              Last
            </button>
            <button
              className={`seg-btn ${usageView === 'turns' ? 'on' : ''}`}
              onClick={() => setUsageView('turns')}
            >
              Per turn
            </button>
          </div>
          {usageView === 'total' && <TurnMetrics t={total} onEditCost={editCost} editableModelId={editableTotalModel} />}
          {usageView === 'last' && last && (
            <div className="usage-turn-card">
              <div className="usage-turn-head">
                <span className="usage-turn-index">Turn {turns.length}</span>
                <span className="usage-turn-time" title={new Date(last.ts).toLocaleString()}>
                  {relativeTime(last.ts)}
                </span>
              </div>
              <div className="usage-turn-model">
                {modelLabel(last.model, models)}
                {last.effort ? ` · ${last.effort}` : ''}
              </div>
              <TurnMetrics t={last} onEditCost={editCost} />
            </div>
          )}
          {usageView === 'turns' && (
            <div>
              {turns.map((t, i) => (
                <div key={t.runId} className="usage-turn-card">
                  <div className="usage-turn-head">
                    <span className="usage-turn-index">Turn {turns.length - i}</span>
                    <span className="usage-turn-time" title={new Date(t.ts).toLocaleString()}>
                      {relativeTime(t.ts)}
                    </span>
                  </div>
                  <div className="usage-turn-model">
                    {modelLabel(t.model, models)}
                    {t.effort ? ` · ${t.effort}` : ''}
                  </div>
                  <TurnMetrics t={t} onEditCost={editCost} />
                </div>
              ))}
            </div>
          )}
          {(usageView === 'last' ? last?.costEstimated : total.costEstimated) && (
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
              Estimated cost is from list price; the route didn&rsquo;t report actual cost for at
              least one turn. Click a cost to set your own rates and make it exact.
            </div>
          )}
        </>
      )}
      {turns.length === 0 && <div style={{ color: 'var(--text-faint)' }}>No usage yet.</div>}
    </div>
  )
}

function singleLocalModel(turns: TurnUsage[]): string | null {
  const modelIds = new Set(turns.filter((turn) => turn.costLocal && turn.model).map((turn) => turn.model!))
  return modelIds.size === 1 ? modelIds.values().next().value ?? null : null
}

/** Which external store an imported memory came from (mirrors the main-process bridge id scheme). */
function memoryOrigin(id: string): 'Claude Code' | 'Hermes' | null {
  if (id.startsWith('mem:cc:')) return 'Claude Code'
  if (id.startsWith('mem:hermes:')) return 'Hermes'
  return null
}

function MemoryTab(): React.JSX.Element {
  const [items, setItems] = React.useState<Awaited<ReturnType<typeof window.lattice.listMemory>>>([])
  const [syncing, setSyncing] = React.useState(false)
  const [note, setNote] = React.useState<string | null>(null)

  const refresh = React.useCallback(() => {
    void window.lattice.listMemory().then(setItems)
  }, [])
  React.useEffect(refresh, [refresh])
  React.useEffect(
    () => window.lattice.onPush((event) => event.kind === 'memory.updated' && refresh()),
    [refresh]
  )

  const sync = async (): Promise<void> => {
    setSyncing(true)
    setNote(null)
    try {
      const r = await window.lattice.syncMemory()
      const inPer = r.sources.map((s) => `${s.label} ${s.error ? '⚠' : s.found}`).join(' · ')
      const wrote = r.exported.reduce((a, e) => a + e.wrote, 0)
      setNote(`↓ ${inPer} (+${r.added} new, ${r.updated} upd, ${r.removed} pruned) · ↑ wrote ${wrote} back`)
      refresh()
    } catch (err) {
      setNote(`Sync failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSyncing(false)
    }
  }

  const setStatus = async (
    item: Awaited<ReturnType<typeof window.lattice.listMemory>>[number],
    status: 'approved' | 'rejected'
  ): Promise<void> => {
    await window.lattice.upsertMemory({ ...item, status })
    refresh()
  }

  const remove = async (id: string): Promise<void> => {
    await window.lattice.deleteMemory(id)
    refresh()
  }

  const imported = items.filter((m) => memoryOrigin(m.id))
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h4 style={{ margin: 0 }}>Curated memory ({items.length})</h4>
        <button className="btn" onClick={() => void sync()} disabled={syncing} title="Import Claude Code & Hermes memory">
          <I name={syncing ? 'autorenew' : 'sync'} size={14} className={syncing ? 'spin' : ''} />
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>
      <div style={{ color: 'var(--text-faint)', fontSize: 11, margin: '4px 0 10px' }}>
        {note ?? `${imported.length} imported from Claude Code & Hermes · Sync reads both and writes your Lattice memories back.`}
      </div>
      {items.map((m) => {
        const origin = memoryOrigin(m.id)
        return (
          <div
            key={m.id}
            style={{
              padding: '8px 10px',
              background: 'var(--raised)',
              border: '1px solid var(--hairline)',
              borderRadius: 8,
              marginBottom: 6,
              fontSize: 12.5
            }}
          >
            <div style={{ color: 'var(--text-faint)', fontSize: 10.5, marginBottom: 3, display: 'flex', gap: 6, alignItems: 'center' }}>
              {origin && (
                <span
                  style={{
                    color: 'var(--violet-soft)',
                    border: '1px solid color-mix(in srgb, var(--violet) 45%, var(--hairline))',
                    borderRadius: 6,
                    padding: '0 5px',
                    fontWeight: 600
                  }}
                >
                  {origin}
                </span>
              )}
              <span>
                {m.scope} · {m.type} · {origin ? 'imported' : m.author}
              </span>
              {m.status === 'proposed' && <span style={{ color: 'var(--brass)' }}>· proposed</span>}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', maxHeight: 140, overflow: 'auto' }}>{m.content}</div>
            {!origin && (
              <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                {m.status === 'proposed' && (
                  <>
                    <button className="btn" onClick={() => void setStatus(m, 'approved')}>Approve</button>
                    <button className="btn" onClick={() => void setStatus(m, 'rejected')}>Reject</button>
                  </>
                )}
                <button className="btn" onClick={() => void remove(m.id)}>Delete</button>
              </div>
            )}
          </div>
        )
      })}
      {items.length === 0 && <div style={{ color: 'var(--text-faint)' }}>No memories saved.</div>}
    </div>
  )
}

/**
 * Every tool the thread could use, with what the policy does with each call (run / ask / withheld),
 * MCP health and loaded state, this thread's call history per tool, and the schema on demand.
 * The model's actual request only carries the builtin core plus the MCP tools this thread has
 * loaded; the rest are discoverable through find_tools — the "loaded" chip shows which is which.
 */
function ToolsTab(): React.JSX.Element {
  const tools = useStore((s) => s.tools)
  const loadTools = useStore((s) => s.loadTools)
  const events = useStore((s) => s.events)
  const thread = useStore((s) => s.threads.find((t) => t.id === s.activeThreadId))
  const mcpServers = useStore((s) => s.mcpServers)
  const [query, setQuery] = React.useState('')
  const [open, setOpen] = React.useState<string | null>(null)
  React.useEffect(() => {
    void loadTools()
  }, [loadTools, thread?.id, thread?.mode, thread?.permissionPreset, mcpServers])
  const stats = React.useMemo(() => summarizeToolCalls(events), [events])

  const q = query.trim().toLowerCase()
  const visible = q
    ? tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || (t.serverLabel ?? '').toLowerCase().includes(q))
    : tools
  const groups: { label: string; healthy?: boolean; error?: string; tools: ToolInventoryEntry[] }[] = []
  const byKey = new Map<string, (typeof groups)[number]>()
  for (const t of visible) {
    const key = t.source === 'builtin' ? 'builtin' : (t.serverId ?? 'mcp')
    let g = byKey.get(key)
    if (!g) {
      g = { label: t.source === 'builtin' ? 'Built-in' : (t.serverLabel ?? 'MCP'), healthy: t.healthy, error: t.error, tools: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    g.tools.push(t)
  }
  const counts = {
    allow: tools.filter((t) => t.effect === 'allow').length,
    ask: tools.filter((t) => t.effect === 'ask').length,
    deny: tools.filter((t) => t.effect === 'deny').length
  }

  return (
    <div>
      <div className="mcp-tab-head">
        <h4 style={{ margin: 0 }}>Tools ({tools.length})</h4>
        <button className="mini-add" onClick={() => void loadTools()} title="Refresh">
          <I name="refresh" size={15} />
        </button>
      </div>
      <div className="tools-summary">
        <span className="tool-effect allow">{counts.allow} run freely</span>
        <span className="tool-effect ask">{counts.ask} ask first</span>
        <span className="tool-effect deny">{counts.deny} withheld</span>
        <span className="tools-summary-note">
          under {thread?.mode ?? 'act'} · {thread?.permissionPreset ?? 'workspace'}
        </span>
      </div>
      <div className="search-field tools-search">
        <I name="search" size={15} style={{ color: 'var(--text-faint)' }} />
        <input placeholder="Filter tools…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter tools" />
      </div>
      {groups.map((g) => (
        <div key={g.label} className="tools-group">
          <div className="tools-group-head">
            {g.healthy !== undefined && <span className={`mcp-dot ${g.healthy ? 'up' : 'err'}`} title={g.error ?? (g.healthy ? 'connected' : 'not connected')} />}
            <span>{g.label}</span>
            <span className="tools-group-count">{g.tools.length}</span>
            {g.error && <span className="tools-group-error" title={g.error}>{g.error}</span>}
          </div>
          {g.tools.map((t) => {
            const st = stats.get(t.name)
            const isOpen = open === t.name
            const short = t.name.replace(/^mcp__(.+?)__/, '')
            return (
              <div key={t.name} className={`tool-entry ${t.effect}${isOpen ? ' open' : ''}`}>
                <button className="tool-entry-head" onClick={() => setOpen(isOpen ? null : t.name)} aria-expanded={isOpen}>
                  <span className="tool-entry-name" title={t.name}>{short}</span>
                  <span className={`tool-effect ${t.effect}`}>{t.effect === 'allow' ? 'runs' : t.effect === 'ask' ? 'asks' : 'withheld'}</span>
                  {t.source === 'mcp' && <span className={`tool-loaded ${t.loaded ? 'on' : ''}`}>{t.loaded ? 'loaded' : 'discoverable'}</span>}
                  {st && (
                    <span className="tool-entry-stats" title={`${st.calls} call${st.calls === 1 ? '' : 's'} on this thread${st.failed ? `, ${st.failed} failed` : ''}${st.avgMs !== null ? `, avg ${st.avgMs} ms` : ''}`}>
                      {st.calls}×{st.failed ? ` · ${st.failed} failed` : ''}{st.avgMs !== null ? ` · ${st.avgMs} ms` : ''}
                    </span>
                  )}
                  <I name={isOpen ? 'expand_less' : 'expand_more'} size={14} className="tool-chev" />
                </button>
                {isOpen && (
                  <div className="tool-entry-body">
                    <div className="tool-entry-desc">{t.description}</div>
                    <div className="tool-entry-meta">
                      <span>{t.resource}</span>
                      <span>{t.action}</span>
                      <span>{t.riskTier}</span>
                      {t.source === 'mcp' && <span className="tool-entry-full">{t.name}</span>}
                    </div>
                    <div className="tool-detail-label">Schema</div>
                    <pre className="tool-entry-schema">{JSON.stringify(t.parameters, null, 2)}</pre>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
      {visible.length === 0 && <div className="agents-empty"><div className="title">No tools match.</div></div>}
    </div>
  )
}

function McpTab(): React.JSX.Element {
  const servers = useStore((s) => s.mcpServers)
  const setUi = useStore((s) => s.setUi)
  const refreshMcp = useStore((s) => s.refreshMcp)
  const [expanded, setExpanded] = React.useState<string | null>(null)

  const toggle = (id: string, enabled: boolean): void => {
    const config = servers.find((s) => s.config.id === id)?.config
    if (config) void window.lattice.upsertMcpServer({ ...config, enabled })
  }

  const totalTools = servers.reduce((n, s) => n + (s.config.enabled ? s.status.tools.length : 0), 0)

  return (
    <div>
      <div className="mcp-tab-head">
        <h4 style={{ margin: 0 }}>MCP servers ({servers.length})</h4>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="mini-add" onClick={() => void refreshMcp()} title="Refresh status">
            <I name="refresh" size={15} />
          </button>
          <button className="mini-add" onClick={() => setUi({ settingsOpen: true })} title="Add / edit servers">
            <I name="add" size={15} />
          </button>
        </div>
      </div>

      {servers.length === 0 && (
        <div className="agents-empty">
          <I name="hub" size={22} />
          <div className="title">No MCP servers</div>
          <div className="body">
            Connect a server to expose its tools to models. Add one from Settings — stdio (a local command) or
            streamable HTTP.
          </div>
          <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setUi({ settingsOpen: true })}>
            <I name="add" size={15} /> Add server
          </button>
        </div>
      )}

      {servers.map(({ config, status }) => {
        const open = expanded === config.id
        return (
          <div className="mcp-card" key={config.id}>
            <div className="mcp-card-head" onClick={() => setExpanded(open ? null : config.id)}>
              <span className={`mcp-dot ${status.connected ? 'up' : config.enabled ? 'err' : 'off'}`} />
              <div className="mcp-card-text">
                <div className="mcp-label">{config.label}</div>
                <div className="mcp-status">
                  {status.error
                    ? `error: ${status.error.slice(0, 48)}`
                    : status.connected
                      ? `${status.tools.length} tool${status.tools.length === 1 ? '' : 's'}${status.latencyMs ? ` · ${status.latencyMs}ms` : ''}`
                      : config.enabled
                        ? 'connecting…'
                        : 'disabled'}
                </div>
              </div>
              <button
                className={`mcp-toggle ${config.enabled ? 'on' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(config.id, !config.enabled)
                }}
              >
                {config.enabled ? 'On' : 'Off'}
              </button>
              <I name={open ? 'expand_less' : 'expand_more'} size={16} />
            </div>
            {open && status.tools.length > 0 && (
              <div className="mcp-tool-list">
                {status.tools.map((t) => (
                  <div className="mcp-tool" key={t.name} title={t.description}>
                    <I name="build" size={12} />
                    <span className="mcp-tool-name">{t.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {servers.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-faint)' }}>
          {totalTools} tool{totalTools === 1 ? '' : 's'} discoverable by models (via <code>find_tools</code>) in
          Auto and Full presets — schemas load into context only when a thread needs them.
        </div>
      )}
    </div>
  )
}
