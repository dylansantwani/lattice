import React from 'react'
import { useStore } from '@/state/store'
import { fmtTokens, RESERVED, SEGMENT_COLORS, SEGMENT_LABELS } from './ContextOrbit'
import { I } from './Icon'
import type { RunEvent } from '@shared/types'

const TABS = ['context', 'run', 'tasks', 'memory', 'agents', 'mcp'] as const
type Tab = (typeof TABS)[number]

export function Inspector(): React.JSX.Element {
  const tab = useStore((s) => s.ui.inspectorTab) as Tab
  const setUi = useStore((s) => s.setUi)

  return (
    <aside className="inspector">
      <div className="pane-header">
        <div className="inspector-title">
          <span className="t">Inspector</span>
          <span className="s">{tab}</span>
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
            {t}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {tab === 'context' && <ContextTab />}
        {tab === 'run' && <RunTab />}
        {tab === 'tasks' && <TasksTab />}
        {tab === 'memory' && <MemoryTab />}
        {tab === 'agents' && <AgentsTab />}
        {tab === 'mcp' && <McpTab />}
      </div>
    </aside>
  )
}

function ContextTab(): React.JSX.Element {
  const budget = useStore((s) => s.budget)
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
      <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-faint)' }}>
        Counts are {budget.exact ? 'provider-exact' : 'estimated from the current conversation'}.
      </div>
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

function RunTab(): React.JSX.Element {
  const events = useStore((s) => s.events)
  const recent = events.slice(-200)

  // Reasoning is intentionally kept out of the transcript; surface it here for inspection.
  const lastRunId = [...events].reverse().find((e) => e.body.type === 'run.started')?.runId
  const reasoning = events
    .filter((e) => e.runId === lastRunId && e.body.type === 'reasoning.delta')
    .map((e) => (e.body.type === 'reasoning.delta' ? e.body.text : ''))
    .join('')

  // Aggregate prompt-cache performance across every usage event in the loaded thread, so the
  // hit rate is visible as a standing number, not just a per-turn chip in the transcript.
  let cacheIn = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const ev of events) {
    if (ev.body.type !== 'usage') continue
    cacheIn += ev.body.usage.tokensIn ?? 0
    cacheRead += ev.body.usage.cacheReadTokens ?? 0
    cacheWrite += ev.body.usage.cacheWriteTokens ?? 0
  }

  return (
    <div>
      {cacheIn > 0 && (
        <>
          <h4>Prompt cache (this thread)</h4>
          <div className="kv">
            <span className="k">Hit rate</span>
            <span className="v">{Math.round((cacheRead / cacheIn) * 100)}% of input</span>
          </div>
          <div className="kv">
            <span className="k">Read from cache</span>
            <span className="v">{fmtTokens(cacheRead)}</span>
          </div>
          <div className="kv">
            <span className="k">Written to cache</span>
            <span className="v">{fmtTokens(cacheWrite)}</span>
          </div>
          {cacheRead === 0 && cacheWrite === 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 8 }}>
              No cache activity reported. Check that prompt caching is enabled in Settings →
              Providers and that the routed model supports it.
            </div>
          )}
        </>
      )}
      {reasoning && (
        <>
          <h4>Reasoning (latest run)</h4>
          <div className="reasoning-view">{reasoning}</div>
        </>
      )}
      <h4>Event log ({events.length})</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {recent.map((ev) => (
          <EventRow key={ev.id} ev={ev} />
        ))}
        {events.length === 0 && <div style={{ color: 'var(--text-faint)' }}>No events yet.</div>}
      </div>
    </div>
  )
}

function EventRow({ ev }: { ev: RunEvent }): React.JSX.Element {
  const b = ev.body
  let detail = ''
  if (b.type === 'run.started') detail = `${b.model}${b.effort ? ` · ${b.effort}` : ''}`
  else if (b.type === 'text.delta') detail = `${b.text.length} chars`
  else if (b.type === 'reasoning.delta') detail = `${b.text.length} chars`
  else if (b.type === 'error') detail = b.message
  else if (b.type === 'run.completed') detail = b.reason
  else if (b.type === 'usage' && b.usage.tokensOut) {
    detail = `${b.usage.tokensOut} out`
    if (b.usage.cacheReadTokens) detail += ` · ${b.usage.cacheReadTokens} cached`
    if (b.usage.cacheWriteTokens) detail += ` · ${b.usage.cacheWriteTokens} primed`
  }
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-dim)',
        lineHeight: 1.5
      }}
    >
      <span style={{ color: 'var(--text-faint)' }}>
        {new Date(ev.ts).toLocaleTimeString(undefined, { hour12: false })}
      </span>{' '}
      <span style={{ color: eventColor(b.type) }}>{b.type}</span>
      {detail && <span style={{ color: 'var(--text-faint)' }}> {detail.slice(0, 60)}</span>}
    </div>
  )
}

function eventColor(type: string): string {
  if (type.startsWith('error')) return 'var(--red)'
  if (type.startsWith('run.')) return 'var(--violet-soft)'
  if (type.startsWith('tool')) return 'var(--brass)'
  return 'var(--text-dim)'
}

function TasksTab(): React.JSX.Element {
  const threadId = useStore((s) => s.activeThreadId)
  const [todos, setTodos] = React.useState<Awaited<ReturnType<typeof window.lattice.listTodos>>>([])
  React.useEffect(() => {
    if (threadId) void window.lattice.listTodos(threadId).then(setTodos)
  }, [threadId])
  if (todos.length === 0)
    return (
      <div style={{ color: 'var(--text-faint)' }}>
        No checklist yet. The agent can create one with the <code>todo_write</code> tool.
      </div>
    )
  return (
    <div>
      <h4>Run checklist</h4>
      {todos.map((t) => (
        <div key={t.id} className="kv">
          <span className="k">{t.title}</span>
          <span className="v">{t.status}</span>
        </div>
      ))}
    </div>
  )
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

function AgentsTab(): React.JSX.Element {
  const events = useStore((s) => s.events)

  // Real subagent runs carry an `agent` id on their events. Group by it.
  const agents = new Map<string, { model?: string; running: boolean; lastLine?: string }>()
  for (const ev of events) {
    if (!ev.agent) continue
    const entry = agents.get(ev.agent) ?? { running: true }
    if (ev.body.type === 'run.started') entry.model = ev.body.model
    if (ev.body.type === 'run.completed') entry.running = false
    if (ev.body.type === 'text.delta') entry.lastLine = ev.body.text.slice(-80)
    agents.set(ev.agent, entry)
  }

  if (agents.size === 0) {
    return (
      <div className="agents-empty">
        <I name="account_tree" size={22} />
        <div className="title">No subagents running</div>
        <div className="body">
          Models spin up subagents on their own when a task benefits from parallel or isolated work. Live
          status, models, and provenance appear here while they run.
        </div>
      </div>
    )
  }

  return (
    <div>
      <h4>Subagents ({agents.size})</h4>
      {[...agents.entries()].map(([id, a]) => (
        <div className={`agent-card ${a.running ? '' : 'idle'}`} key={id}>
          <div className="row">
            <span className="name">
              <span className={a.running ? 'run-spinner' : 'idle-dot'} />
              {id.slice(0, 10)}
            </span>
            {a.model && <span className="model-tag">{a.model}</span>}
          </div>
          {a.lastLine && <div className="status-line">{a.lastLine}</div>}
        </div>
      ))}
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
