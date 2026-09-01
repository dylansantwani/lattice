import React from 'react'
import { useStore } from '@/state/store'
import { fmtTokens } from './ContextOrbit'
import type { RunEvent } from '@shared/types'

const SEGMENT_COLORS: Record<string, string> = {
  system: '#8e87d8',
  tools: '#d5a45d',
  history: '#7fb98a',
  injected: '#6aa5c8',
  outputReserve: '#5a5f66',
  safety: '#3c4046'
}

const SEGMENT_LABELS: Record<string, string> = {
  system: 'System & instructions',
  tools: 'Tool schemas',
  history: 'Conversation history',
  injected: 'Injected content',
  outputReserve: 'Output reserve',
  safety: 'Safety buffer'
}

export function Inspector(): React.JSX.Element {
  const tab = useStore((s) => s.ui.inspectorTab)
  const setUi = useStore((s) => s.setUi)

  return (
    <aside className="inspector">
      <div className="inspector-tabs">
        {(['context', 'run', 'tasks', 'memory'] as const).map((t) => (
          <button
            key={t}
            className={`inspector-tab ${tab === t ? 'active' : ''}`}
            onClick={() => setUi({ inspectorTab: t })}
          >
            {t}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="inspector-tab" onClick={() => setUi({ inspectorOpen: false })} aria-label="Close inspector">
          ✕
        </button>
      </div>
      <div className="inspector-body">
        {tab === 'context' && <ContextTab />}
        {tab === 'run' && <RunTab />}
        {tab === 'tasks' && <TasksTab />}
        {tab === 'memory' && <MemoryTab />}
      </div>
    </aside>
  )
}

function ContextTab(): React.JSX.Element {
  const budget = useStore((s) => s.budget)
  if (!budget) return <div style={{ color: 'var(--text-faint)' }}>No context data yet.</div>
  const entries = Object.entries(budget.segments).filter(([, v]) => v > 0)
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
        <span className="k">Used</span>
        <span className="v">
          {budget.exact ? '' : '~'}
          {fmtTokens(budget.usedTokens)} ({Math.round(budget.occupancy * 100)}%)
        </span>
      </div>
      <div className="seg-bar">
        {entries.map(([k, v]) => (
          <div
            key={k}
            style={{ width: `${(v / budget.usableTokens) * 100}%`, background: SEGMENT_COLORS[k] }}
            title={`${SEGMENT_LABELS[k]}: ${fmtTokens(v)}`}
          />
        ))}
      </div>
      <h4>Segments</h4>
      {entries.map(([k, v]) => (
        <div key={k} className="kv">
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
          <span className="v">
            {budget.exact ? '' : '~'}
            {fmtTokens(v)}
          </span>
        </div>
      ))}
      <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-faint)' }}>
        Counts are {budget.exact ? 'provider-exact' : 'estimated (~4 chars/token)'}.
      </div>
    </div>
  )
}

function RunTab(): React.JSX.Element {
  const events = useStore((s) => s.events)
  const recent = events.slice(-200)
  return (
    <div>
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
  let label: string = b.type
  let detail = ''
  if (b.type === 'run.started') detail = `${b.model}${b.effort ? ` · ${b.effort}` : ''}`
  else if (b.type === 'text.delta') detail = `${b.text.length} chars`
  else if (b.type === 'reasoning.delta') detail = `${b.text.length} chars`
  else if (b.type === 'error') detail = b.message
  else if (b.type === 'run.completed') detail = b.reason
  else if (b.type === 'usage' && b.usage.tokensOut) detail = `${b.usage.tokensOut} out`
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5 }}>
      <span style={{ color: 'var(--text-faint)' }}>
        {new Date(ev.ts).toLocaleTimeString(undefined, { hour12: false })}
      </span>{' '}
      <span style={{ color: eventColor(label) }}>{label}</span>
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
  return <div style={{ color: 'var(--text-faint)' }}>Todos land with the tool runtime slice.</div>
}

function MemoryTab(): React.JSX.Element {
  const [items, setItems] = React.useState<Awaited<ReturnType<typeof window.lattice.listMemory>>>([])
  React.useEffect(() => {
    void window.lattice.listMemory().then(setItems)
  }, [])
  return (
    <div>
      <h4>Curated memory ({items.length})</h4>
      {items.map((m) => (
        <div
          key={m.id}
          style={{
            padding: '8px 10px',
            background: 'var(--raised)',
            borderRadius: 6,
            marginBottom: 6,
            fontSize: 12.5
          }}
        >
          <div style={{ color: 'var(--text-faint)', fontSize: 10.5, marginBottom: 3 }}>
            {m.scope} · {m.type} · {m.author}
          </div>
          {m.content}
        </div>
      ))}
      {items.length === 0 && <div style={{ color: 'var(--text-faint)' }}>No memories saved.</div>}
    </div>
  )
}
