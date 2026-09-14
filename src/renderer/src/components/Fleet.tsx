import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentKind, Fleet, FleetAgentView, Mode, PermissionPreset } from '@shared/types'
import { useStore } from '@/state/store'
import { I } from './Icon'

/**
 * The Agent Fleet screen: a persistent orchestrator plus its dedicated workers, all on one surface.
 *
 * Each agent is a persistent thread (its own memory, cwd and context window) bound to a saved role.
 * You configure an agent here (model, working directory, tools, role, rolling context), then tell the
 * orchestrator what you want — it delegates to its workers, which keep their context between tasks so
 * they are never re-briefed. Delegation, steering (fold a message into a running agent) and queueing
 * all ride the existing inter-session messaging path, so this screen is mostly configuration + a place
 * to talk to any agent. Self-contained, like Sessions: it talks to `window.lattice.*` directly and
 * only reaches into the store to jump to a thread and flash notices.
 */

const MODES: Mode[] = ['act', 'plan', 'review']
const PRESETS: PermissionPreset[] = ['workspace', 'manual', 'full']

interface AgentForm {
  name: string
  kind: AgentKind
  role: string
  model: string
  mode: Mode
  permissionPreset: PermissionPreset
  cwd: string
  rolling: boolean
  allowedTools: string
}

function blankForm(kind: AgentKind, model: string): AgentForm {
  return {
    name: kind === 'orchestrator' ? 'Orchestrator' : '',
    kind,
    role:
      kind === 'orchestrator'
        ? 'You are the orchestrator of a fleet of dedicated agents. Use list_fleet to see your agents and delegate_to_agent to hand each one work in its domain. Keep your own replies short; do the real work through your agents, check on them with peek_session, and report back to the user. Never take an irreversible action (purchase, send, publish) without the user’s go-ahead.'
        : '',
    model,
    mode: 'act',
    permissionPreset: 'workspace',
    cwd: '',
    rolling: kind === 'worker',
    allowedTools: ''
  }
}

export function FleetScreen(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.fleetOpen)
  const setUi = useStore((s) => s.setUi)
  const selectThread = useStore((s) => s.selectThread)
  const flash = useStore((s) => s.flash)
  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const defaultModel = settings?.defaultModel ?? models[0]?.id ?? ''

  const [fleets, setFleets] = useState<Fleet[]>([])
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [agents, setAgents] = useState<FleetAgentView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<AgentForm>(() => blankForm('worker', defaultModel))
  const [msg, setMsg] = useState('')
  const [disposition, setDisposition] = useState<'send' | 'steer' | 'queue'>('send')
  const [busy, setBusy] = useState(false)

  const fleetIdRef = useRef<string | null>(null)
  fleetIdRef.current = fleetId

  const orchestrator = useMemo(() => agents.find((a) => a.kind === 'orchestrator'), [agents])
  const selected = useMemo(() => agents.find((a) => a.id === selectedId) ?? null, [agents, selectedId])
  const ordered = useMemo(
    () =>
      agents
        .slice()
        .sort((a, b) => (a.kind === b.kind ? a.sortOrder - b.sortOrder : a.kind === 'orchestrator' ? -1 : 1)),
    [agents]
  )

  // ---- loading ----

  const loadAgents = useCallback(async (id: string) => {
    const list = await window.lattice.listAgents(id).catch(() => [] as FleetAgentView[])
    if (fleetIdRef.current === id) setAgents(list)
  }, [])

  const loadFleets = useCallback(async () => {
    let list = await window.lattice.listFleets().catch(() => [] as Fleet[])
    if (list.length === 0) {
      // First run: give them a fleet to fill so the screen is never a dead end.
      const created = await window.lattice.createFleet({ name: 'My Fleet' }).catch(() => null)
      if (created) list = [created]
    }
    setFleets(list)
    const next = list.find((f) => f.id === fleetIdRef.current) ?? list[0]
    if (next) {
      setFleetId(next.id)
      fleetIdRef.current = next.id
      await loadAgents(next.id)
    }
  }, [loadAgents])

  useEffect(() => {
    if (!open) return
    void loadFleets()
  }, [open, loadFleets])

  // Live refresh: any fleet/thread/message change reloads the roster; a light poll keeps the
  // running/queued status current while an agent works (status is derived, not pushed per tick).
  useEffect(() => {
    if (!open) return
    const off = window.lattice.onPush((event) => {
      if (
        event.kind === 'fleet.updated' ||
        event.kind === 'thread.updated' ||
        event.kind === 'thread.deleted' ||
        event.kind === 'session.message'
      ) {
        const id = fleetIdRef.current
        if (id) void loadAgents(id)
      }
    })
    const timer = window.setInterval(() => {
      const id = fleetIdRef.current
      if (id) void loadAgents(id)
    }, 2500)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [open, loadAgents])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setUi({ fleetOpen: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setUi])

  // Populate the editor when a real agent is selected.
  useEffect(() => {
    if (adding || !selected) return
    setForm({
      name: selected.name,
      kind: selected.kind,
      role: selected.role ?? '',
      model: selected.model || defaultModel,
      mode: selected.mode,
      permissionPreset: selected.permissionPreset,
      cwd: selected.cwd ?? '',
      rolling: selected.rolling,
      allowedTools: (selected.allowedTools ?? []).join(', ')
    })
  }, [selected, adding, defaultModel])

  // ---- actions ----

  const close = (): void => setUi({ fleetOpen: false })

  const startAdd = (kind: AgentKind): void => {
    setAdding(true)
    setSelectedId(null)
    setForm(blankForm(kind, defaultModel))
  }

  const selectAgent = (id: string): void => {
    setAdding(false)
    setSelectedId(id)
  }

  const parseTools = (raw: string): string[] | undefined => {
    const list = raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    return list.length ? list : undefined
  }

  const createAgent = async (): Promise<void> => {
    if (!fleetId || busy) return
    if (form.kind === 'worker' && !form.name.trim()) {
      flash('Give the agent a name.', 'warn')
      return
    }
    setBusy(true)
    try {
      const created = await window.lattice.createAgent({
        fleetId,
        name: form.name.trim() || (form.kind === 'orchestrator' ? 'Orchestrator' : 'Agent'),
        kind: form.kind,
        role: form.role.trim() || undefined,
        model: form.model || undefined,
        mode: form.mode,
        permissionPreset: form.permissionPreset,
        cwd: form.cwd.trim() || undefined,
        rolling: form.rolling,
        allowedTools: parseTools(form.allowedTools)
      })
      setAdding(false)
      setSelectedId(created.id)
      await loadAgents(fleetId)
      flash(`Added ${created.name}.`)
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not create the agent.', 'warn')
    } finally {
      setBusy(false)
    }
  }

  const saveAgent = async (): Promise<void> => {
    if (!selected || busy) return
    setBusy(true)
    try {
      await window.lattice.updateAgent(selected.id, {
        name: form.name.trim() || selected.name,
        kind: form.kind,
        role: form.role.trim() || '',
        model: form.model || undefined,
        mode: form.mode,
        permissionPreset: form.permissionPreset,
        cwd: form.cwd.trim() ? form.cwd.trim() : null,
        rolling: form.rolling,
        allowedTools: parseTools(form.allowedTools) ?? null
      })
      if (fleetId) await loadAgents(fleetId)
      flash('Saved.')
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not save.', 'warn')
    } finally {
      setBusy(false)
    }
  }

  const removeAgent = async (): Promise<void> => {
    if (!selected) return
    if (!window.confirm(`Delete “${selected.name}” and its thread? This cannot be undone.`)) return
    await window.lattice.deleteAgent(selected.id).catch(() => {})
    setSelectedId(null)
    if (fleetId) await loadAgents(fleetId)
  }

  const openThread = (threadId: string): void => {
    void selectThread(threadId)
    close()
  }

  const sendToAgent = async (agent: FleetAgentView): Promise<void> => {
    const text = msg.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await window.lattice.send({ threadId: agent.threadId, text, disposition })
      setMsg('')
      const verb =
        disposition === 'steer'
          ? agent.running
            ? 'steered into its run'
            : 'sent'
          : disposition === 'queue'
            ? 'queued'
            : agent.running
              ? 'queued behind its run'
              : 'sent'
      flash(`Message ${verb} → ${agent.name}`)
      if (fleetId) await loadAgents(fleetId)
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not send.', 'warn')
    } finally {
      setBusy(false)
    }
  }

  const newFleet = async (): Promise<void> => {
    const created = await window.lattice.createFleet({ name: 'New Fleet' }).catch(() => null)
    if (!created) return
    setFleets((f) => [...f, created])
    setFleetId(created.id)
    fleetIdRef.current = created.id
    setSelectedId(null)
    setAdding(false)
    await loadAgents(created.id)
  }

  const renameFleet = async (name: string): Promise<void> => {
    if (!fleetId) return
    const trimmed = name.trim()
    const current = fleets.find((f) => f.id === fleetId)
    if (!trimmed || trimmed === current?.name) return
    const next = await window.lattice.renameFleet(fleetId, trimmed).catch(() => null)
    if (next) setFleets((list) => list.map((f) => (f.id === next.id ? next : f)))
  }

  if (!open) return null

  const statusTone = (a: FleetAgentView): string =>
    a.running ? 'good' : a.unread > 0 ? 'warn' : 'muted'
  const statusIcon = (a: FleetAgentView): string =>
    a.running ? 'pending' : a.unread > 0 ? 'inbox' : 'check'

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal sessions-modal" role="dialog" aria-label="Agent Fleet">
        <div className="sessions-head">
          <h3>
            <I name="hub" size={19} />
            Agent Fleet
          </h3>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, marginLeft: 8 }}>
            <select
              value={fleetId ?? ''}
              onChange={(e) => {
                setFleetId(e.target.value)
                fleetIdRef.current = e.target.value
                setSelectedId(null)
                setAdding(false)
                void loadAgents(e.target.value)
              }}
              aria-label="Fleet"
            >
              {fleets.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <button className="btn tiny" onClick={() => void newFleet()} title="Create another fleet">
              + Fleet
            </button>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close" title="Close (esc)">
            <I name="close" size={18} />
          </button>
        </div>

        <div className="sessions-body">
          {/* Roster */}
          <div className="sessions-list" role="listbox" aria-label="Agents">
            <div style={{ display: 'flex', gap: 6, padding: '6px 6px 8px' }}>
              <button
                className="btn tiny"
                onClick={() => startAdd('orchestrator')}
                disabled={!!orchestrator}
                title={orchestrator ? 'This fleet already has an orchestrator' : 'Add the orchestrator'}
              >
                + Orchestrator
              </button>
              <button className="btn tiny" onClick={() => startAdd('worker')}>
                + Agent
              </button>
            </div>
            {ordered.length === 0 && <p className="sessions-empty">No agents yet. Add an orchestrator to start.</p>}
            {ordered.map((a) => (
              <button
                key={a.id}
                className={`session-row ${a.id === selectedId ? 'selected' : ''}`}
                role="option"
                aria-selected={a.id === selectedId}
                onClick={() => selectAgent(a.id)}
              >
                <I
                  name={a.kind === 'orchestrator' ? 'hub' : statusIcon(a)}
                  size={16}
                  className={`session-status tone-${statusTone(a)}`}
                />
                <span className="session-row-main">
                  <span className="session-row-title">
                    {a.name}
                    {a.kind === 'orchestrator' && <span className="session-row-badges"> · orchestrator</span>}
                  </span>
                  <span className="session-row-status">
                    {a.statusText} · {a.model || 'no model'}
                    {a.rolling ? ' · rolling' : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {/* Detail / editor */}
          <div className="session-detail">
            {adding ? (
              <AgentEditor
                title={form.kind === 'orchestrator' ? 'New orchestrator' : 'New agent'}
                form={form}
                setForm={setForm}
                models={models}
                busy={busy}
                onSubmit={() => void createAgent()}
                submitLabel="Create agent"
                onCancel={() => setAdding(false)}
              />
            ) : selected ? (
              <div>
                <div className="session-detail-head">
                  <div className="session-detail-title">
                    <I name={selected.kind === 'orchestrator' ? 'hub' : 'smart_toy'} size={17} />
                    <span className="session-detail-name">{selected.name}</span>
                  </div>
                  <div className="session-detail-actions">
                    <button className="btn tiny" onClick={() => openThread(selected.threadId)} title="Open this agent's thread">
                      Open thread
                    </button>
                    <button className="btn tiny" onClick={() => void removeAgent()} title="Delete this agent">
                      Delete
                    </button>
                  </div>
                </div>

                <div className="session-detail-meta">
                  <span className={`session-status-text tone-${statusTone(selected)}`}>{selected.statusText}</span>
                  <span>{selected.mode}</span>
                  <span>{selected.permissionPreset}</span>
                  {selected.rolling && <span>rolling context</span>}
                </div>

                {/* Talk to this agent — delegate/steer/queue/discuss from your side */}
                <section className="session-section">
                  <div className="sessions-label">
                    {selected.kind === 'orchestrator'
                      ? 'Tell the orchestrator what to do (it will delegate to its agents)'
                      : 'Message this agent'}
                  </div>
                  <textarea
                    value={msg}
                    onChange={(e) => setMsg(e.target.value)}
                    placeholder={
                      selected.kind === 'orchestrator'
                        ? 'e.g. Source ten 16GB DDR4 kits on eBay under $30 and draft listings…  (⌘↵)'
                        : 'Message, steer, or queue a task…  (⌘↵)'
                    }
                    rows={3}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        void sendToAgent(selected)
                      }
                    }}
                  />
                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <select value={disposition} onChange={(e) => setDisposition(e.target.value as typeof disposition)} aria-label="How to deliver">
                      <option value="send">Send{selected.running ? ' (after current)' : ''}</option>
                      <option value="steer">Steer (fold into current run)</option>
                      <option value="queue">Queue (after current)</option>
                    </select>
                    <button
                      className="btn primary"
                      onClick={() => void sendToAgent(selected)}
                      disabled={!msg.trim() || busy}
                    >
                      Send
                    </button>
                  </div>
                </section>

                {/* Configuration */}
                <section className="session-section">
                  <div className="sessions-label">Configuration</div>
                  <AgentEditor
                    form={form}
                    setForm={setForm}
                    models={models}
                    busy={busy}
                    onSubmit={() => void saveAgent()}
                    submitLabel="Save changes"
                    lockKind
                  />
                </section>
              </div>
            ) : (
              <div className="sessions-empty" style={{ padding: 20 }}>
                <p style={{ marginBottom: 10 }}>
                  A fleet is a persistent orchestrator plus dedicated agents. Add an orchestrator, give it a
                  few worker agents (each with its own working directory, tools and memory), then tell the
                  orchestrator what you want — it delegates the work and reports back.
                </p>
                <button className="btn primary" onClick={() => startAdd(orchestrator ? 'worker' : 'orchestrator')}>
                  {orchestrator ? 'Add an agent' : 'Add the orchestrator'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <datalist id="fleet-models">
        {models.map((m) => (
          <option key={m.id} value={m.id} />
        ))}
      </datalist>
    </div>
  )
}

/** The create/edit form for one agent. */
function AgentEditor({
  title,
  form,
  setForm,
  models,
  busy,
  onSubmit,
  submitLabel,
  onCancel,
  lockKind
}: {
  title?: string
  form: AgentForm
  setForm: React.Dispatch<React.SetStateAction<AgentForm>>
  models: { id: string }[]
  busy: boolean
  onSubmit: () => void
  submitLabel: string
  onCancel?: () => void
  lockKind?: boolean
}): React.JSX.Element {
  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]): void =>
    setForm((f) => ({ ...f, [key]: value }))
  const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3 }
  const label: React.CSSProperties = { fontSize: 11, opacity: 0.7 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {title && <div className="session-detail-name">{title}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={field}>
          <span style={label}>Name</span>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="eBay sourcing" />
        </label>
        <label style={field}>
          <span style={label}>Kind</span>
          <select value={form.kind} onChange={(e) => set('kind', e.target.value as AgentKind)} disabled={lockKind}>
            <option value="orchestrator">Orchestrator</option>
            <option value="worker">Worker</option>
          </select>
        </label>
      </div>

      <label style={field}>
        <span style={label}>Role — the agent’s mission (injected into its prompt)</span>
        <textarea value={form.role} onChange={(e) => set('role', e.target.value)} rows={3} placeholder="You source computer parts on eBay…" />
      </label>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={field}>
          <span style={label}>Model</span>
          <input list="fleet-models" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="provider/model" />
        </label>
        <label style={field}>
          <span style={label}>Working directory</span>
          <input value={form.cwd} onChange={(e) => set('cwd', e.target.value)} placeholder="/Users/you/work/ebay" />
        </label>
        <label style={field}>
          <span style={label}>Mode</span>
          <select value={form.mode} onChange={(e) => set('mode', e.target.value as Mode)}>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label style={field}>
          <span style={label}>Permissions</span>
          <select value={form.permissionPreset} onChange={(e) => set('permissionPreset', e.target.value as PermissionPreset)}>
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label style={field}>
        <span style={label}>Tools (comma-separated builtin names; blank = all its mode allows). MCP tools it loads are always kept.</span>
        <input
          value={form.allowedTools}
          onChange={(e) => set('allowedTools', e.target.value)}
          placeholder="fs_read, shell, memory_search, find_mcp"
        />
      </label>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
        <input type="checkbox" checked={form.rolling} onChange={(e) => set('rolling', e.target.checked)} />
        Rolling context — lives forever, self-summarizes old turns into memory (recommended for workers)
      </label>

      <div className="row" style={{ gap: 6 }}>
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" onClick={onSubmit} disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
