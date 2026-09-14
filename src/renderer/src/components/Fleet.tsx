import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentKind, Fleet, FleetAgentView, Mode, PermissionPreset } from '@shared/types'
import { useStore } from '@/state/store'
import { I } from './Icon'

/**
 * The Agent Fleet — a full-window dashboard for a persistent orchestrator plus its dedicated worker
 * agents. Unlike the ephemeral subagents `run_agent` spawns, a fleet agent lives on: it keeps its own
 * thread, memory scope, working directory and warm context across tasks, so it is never re-briefed.
 *
 * The screen is a real view, not a dialog: the orchestrator sits at the top with a command bar you
 * type tasks into, and its workers are big status cards below. Selecting any agent slides in a panel
 * to configure it or message it (delegate / steer / queue / discuss). Self-contained, like Sessions:
 * it talks to `window.lattice.*` directly and only reaches into the store to jump to a thread.
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

const STYLE = `
.fleet-screen { position: fixed; inset: 0; z-index: 60; background: var(--canvas); color: var(--text);
  font-family: var(--font-ui); display: flex; flex-direction: column; }
.fleet-top { height: 56px; flex: none; display: flex; align-items: center; gap: 10px;
  padding: 0 18px; border-bottom: 1px solid var(--hairline); background: var(--shell); }
.fleet-top .fleet-mark { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; }
.fleet-top select { background: var(--raised); color: var(--text); border: 1px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 5px 8px; font-size: 13px; }
.fleet-spacer { flex: 1; }
.fleet-ghost { background: transparent; color: var(--text-dim); border: 1px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 6px 12px; font-size: 13px; cursor: pointer; }
.fleet-ghost:hover { background: var(--raised); color: var(--text); }

.fleet-body { flex: 1; overflow: auto; padding: 26px; }
.fleet-inner { max-width: 1120px; margin: 0 auto; }

.fleet-orch { display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: center;
  background: var(--panel); border: 1px solid var(--hairline); border-left: 3px solid var(--violet);
  border-radius: var(--radius); padding: 18px 20px; cursor: pointer; }
.fleet-orch:hover { border-color: var(--hairline-strong); }
.fleet-orch .badge-hub { width: 46px; height: 46px; border-radius: 12px; display: grid; place-items: center;
  background: color-mix(in srgb, var(--violet) 20%, transparent); color: var(--violet-soft); }
.fleet-orch h2 { margin: 0 0 3px; font-size: 18px; }
.fleet-kicker { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--violet-soft); }
.fleet-role { color: var(--text-dim); font-size: 13px; line-height: 1.45; margin-top: 6px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

.fleet-command { display: flex; gap: 8px; align-items: center; margin: 14px 0 6px; }
.fleet-command input { flex: 1; height: 46px; background: var(--panel); color: var(--text);
  border: 1px solid var(--hairline-strong); border-radius: var(--radius); padding: 0 16px; font-size: 14px; }
.fleet-command input:focus { outline: none; border-color: var(--violet); }
.fleet-command select { height: 46px; background: var(--raised); color: var(--text-dim);
  border: 1px solid var(--hairline); border-radius: var(--radius-sm); padding: 0 8px; font-size: 12px; }
.fleet-send { height: 46px; padding: 0 20px; border: none; border-radius: var(--radius); cursor: pointer;
  background: var(--violet); color: #16131f; font-weight: 600; font-size: 14px; }
.fleet-send:disabled { opacity: .45; cursor: default; }

.fleet-connector { display: flex; flex-direction: column; align-items: center; margin: 18px 0 6px; }
.fleet-connector .line { width: 2px; height: 20px; background: var(--hairline-strong); }
.fleet-connector .label { font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-faint); margin-top: 6px; }

.fleet-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px;
  margin-top: 14px; }
.fleet-card { background: var(--panel); border: 1px solid var(--hairline); border-radius: var(--radius);
  padding: 16px; cursor: pointer; display: flex; flex-direction: column; gap: 10px; min-height: 138px;
  transition: border-color .12s, transform .12s; text-align: left; }
.fleet-card:hover { border-color: var(--hairline-strong); transform: translateY(-2px); }
.fleet-card.sel { border-color: var(--violet); }
.fleet-card .head { display: flex; align-items: center; gap: 9px; }
.fleet-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.fleet-dot.running { background: var(--green); box-shadow: 0 0 0 0 color-mix(in srgb, var(--green) 70%, transparent);
  animation: fleetPulse 1.6s infinite; }
.fleet-dot.queued { background: var(--brass); }
.fleet-dot.idle { background: var(--text-faint); }
@keyframes fleetPulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--green) 60%, transparent); }
  70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
.fleet-card .name { font-weight: 600; font-size: 15px; }
.fleet-card .sub { color: var(--text-faint); font-size: 12px; }
.fleet-card .role { color: var(--text-dim); font-size: 12.5px; line-height: 1.4; flex: 1;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.fleet-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.fleet-chip { font-size: 11px; color: var(--text-dim); background: var(--raised);
  border: 1px solid var(--hairline); border-radius: 999px; padding: 2px 8px; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fleet-status { font-size: 12px; font-weight: 600; }
.fleet-status.running { color: var(--green); }
.fleet-status.queued { color: var(--brass); }
.fleet-status.idle { color: var(--text-faint); }

.fleet-add { border: 1px dashed var(--hairline-strong); background: transparent; color: var(--text-dim);
  display: grid; place-items: center; gap: 6px; font-size: 13px; cursor: pointer; min-height: 138px;
  border-radius: var(--radius); }
.fleet-add:hover { border-color: var(--violet); color: var(--text); }

.fleet-empty { text-align: center; color: var(--text-dim); padding: 60px 20px; }
.fleet-empty h2 { color: var(--text); margin: 0 0 8px; }
.fleet-empty p { max-width: 460px; margin: 0 auto 18px; line-height: 1.5; }

.fleet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 61; }
.fleet-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(460px, 92vw); z-index: 62;
  background: var(--shell); border-left: 1px solid var(--hairline); display: flex; flex-direction: column;
  box-shadow: -18px 0 40px rgba(0,0,0,.35); }
.fleet-drawer-head { flex: none; display: flex; align-items: center; gap: 10px; padding: 16px 18px;
  border-bottom: 1px solid var(--hairline); }
.fleet-drawer-head .name { font-weight: 600; font-size: 16px; flex: 1; }
.fleet-drawer-body { flex: 1; overflow: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 16px; }
.fleet-section-label { font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-faint); margin-bottom: 8px; }
.fleet-msg textarea, .fleet-field input, .fleet-field textarea, .fleet-field select {
  width: 100%; background: var(--panel); color: var(--text); border: 1px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; font-family: inherit; box-sizing: border-box; }
.fleet-field { display: flex; flex-direction: column; gap: 4px; }
.fleet-field > span { font-size: 11px; color: var(--text-faint); }
.fleet-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.fleet-row { display: flex; gap: 8px; align-items: center; }
.fleet-btn { border: 1px solid var(--hairline); background: var(--raised); color: var(--text);
  border-radius: var(--radius-sm); padding: 7px 12px; font-size: 13px; cursor: pointer; }
.fleet-btn:hover { border-color: var(--hairline-strong); }
.fleet-btn.primary { background: var(--violet); color: #16131f; border-color: transparent; font-weight: 600; }
.fleet-btn.danger { color: var(--red); }
.fleet-btn:disabled { opacity: .5; cursor: default; }
.fleet-check { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--text-dim); line-height: 1.4; }
`

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
  const [adding, setAdding] = useState<AgentKind | null>(null)
  const [form, setForm] = useState<AgentForm>(() => blankForm('worker', defaultModel))
  const [msg, setMsg] = useState('')
  const [disposition, setDisposition] = useState<'send' | 'steer' | 'queue'>('send')
  const [busy, setBusy] = useState(false)

  const fleetIdRef = useRef<string | null>(null)
  fleetIdRef.current = fleetId

  const orchestrator = useMemo(() => agents.find((a) => a.kind === 'orchestrator'), [agents])
  const workers = useMemo(
    () => agents.filter((a) => a.kind === 'worker').sort((a, b) => a.sortOrder - b.sortOrder),
    [agents]
  )
  const selected = useMemo(() => agents.find((a) => a.id === selectedId) ?? null, [agents, selectedId])

  const loadAgents = useCallback(async (id: string) => {
    const list = await window.lattice.listAgents(id).catch(() => [] as FleetAgentView[])
    if (fleetIdRef.current === id) setAgents(list)
  }, [])

  const loadFleets = useCallback(async () => {
    let list = await window.lattice.listFleets().catch(() => [] as Fleet[])
    if (list.length === 0) {
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
        if (selectedId || adding) {
          setSelectedId(null)
          setAdding(null)
        } else setUi({ fleetOpen: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setUi, selectedId, adding])

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

  const parseTools = (raw: string): string[] | undefined => {
    const list = raw.split(',').map((t) => t.trim()).filter(Boolean)
    return list.length ? list : undefined
  }

  const startAdd = (kind: AgentKind): void => {
    setSelectedId(null)
    setAdding(kind)
    setForm(blankForm(kind, defaultModel))
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
      setAdding(null)
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
    setUi({ fleetOpen: false })
  }

  const sendTo = async (agent: FleetAgentView, text: string, disp: 'send' | 'steer' | 'queue'): Promise<boolean> => {
    const body = text.trim()
    if (!body || busy) return false
    setBusy(true)
    try {
      await window.lattice.send({ threadId: agent.threadId, text: body, disposition: disp })
      const verb = disp === 'steer' ? (agent.running ? 'steered in' : 'sent') : disp === 'queue' ? 'queued' : 'sent'
      flash(`Task ${verb} → ${agent.name}`)
      if (fleetId) await loadAgents(fleetId)
      return true
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not send.', 'warn')
      return false
    } finally {
      setBusy(false)
    }
  }

  const commandOrchestrator = async (): Promise<void> => {
    if (!orchestrator) return
    if (await sendTo(orchestrator, msg, disposition)) setMsg('')
  }

  const newFleet = async (): Promise<void> => {
    const created = await window.lattice.createFleet({ name: 'New Fleet' }).catch(() => null)
    if (!created) return
    setFleets((f) => [...f, created])
    setFleetId(created.id)
    fleetIdRef.current = created.id
    setSelectedId(null)
    setAdding(null)
    await loadAgents(created.id)
  }

  if (!open) return null

  const dotClass = (a: FleetAgentView): string => (a.running ? 'running' : a.unread > 0 ? 'queued' : 'idle')
  const base = (p?: string): string => (p ? p.split('/').filter(Boolean).pop() ?? p : '')

  const card = (a: FleetAgentView): React.JSX.Element => (
    <button key={a.id} className={`fleet-card ${a.id === selectedId ? 'sel' : ''}`} onClick={() => { setAdding(null); setSelectedId(a.id) }}>
      <div className="head">
        <span className={`fleet-dot ${dotClass(a)}`} />
        <span className="name">{a.name}</span>
      </div>
      {a.role && <div className="role">{a.role}</div>}
      <div className="fleet-chips">
        {a.model && <span className="fleet-chip" title={a.model}>{a.model}</span>}
        {a.cwd && <span className="fleet-chip" title={a.cwd}>📁 {base(a.cwd)}</span>}
        {a.rolling && <span className="fleet-chip">rolling</span>}
      </div>
      <span className={`fleet-status ${dotClass(a)}`}>{a.statusText}</span>
    </button>
  )

  return (
    <>
      <style>{STYLE}</style>
      <div className="fleet-screen">
        <div className="fleet-top">
          <span className="fleet-mark"><I name="hub" size={18} /> Agent Fleet</span>
          <select
            value={fleetId ?? ''}
            onChange={(e) => { setFleetId(e.target.value); fleetIdRef.current = e.target.value; setSelectedId(null); setAdding(null); void loadAgents(e.target.value) }}
          >
            {fleets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <button className="fleet-ghost" onClick={() => void newFleet()}>+ Fleet</button>
          <div className="fleet-spacer" />
          <button className="fleet-ghost" onClick={() => setUi({ fleetOpen: false })}>Done ✕</button>
        </div>

        <div className="fleet-body">
          <div className="fleet-inner">
            {orchestrator ? (
              <>
                <div className="fleet-orch" onClick={() => { setAdding(null); setSelectedId(orchestrator.id) }}>
                  <div className="badge-hub"><I name="hub" size={24} /></div>
                  <div>
                    <div className="fleet-kicker">Orchestrator</div>
                    <h2>{orchestrator.name}</h2>
                    {orchestrator.role && <div className="fleet-role">{orchestrator.role}</div>}
                  </div>
                </div>

                <div className="fleet-command" onClick={(e) => e.stopPropagation()}>
                  <input
                    value={msg}
                    onChange={(e) => setMsg(e.target.value)}
                    placeholder={`Tell ${orchestrator.name} what to do — it delegates to its agents…`}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void commandOrchestrator() } }}
                  />
                  <select value={disposition} onChange={(e) => setDisposition(e.target.value as typeof disposition)} title="How to deliver">
                    <option value="send">Send</option>
                    <option value="steer">Steer</option>
                    <option value="queue">Queue</option>
                  </select>
                  <button className="fleet-send" onClick={() => void commandOrchestrator()} disabled={!msg.trim() || busy}>Send</button>
                </div>

                <div className="fleet-connector"><div className="line" /><div className="label">delegates to</div></div>

                <div className="fleet-grid">
                  {workers.map(card)}
                  <button className="fleet-add" onClick={() => startAdd('worker')}><I name="add" size={22} /> Add agent</button>
                </div>
              </>
            ) : (
              <div className="fleet-empty">
                <h2>Build your fleet</h2>
                <p>A fleet is a persistent orchestrator plus dedicated agents — each with its own working
                  directory, tools and memory. Add the orchestrator, give it workers, then tell it what you
                  want and it delegates the work and reports back.</p>
                <button className="fleet-btn primary" onClick={() => startAdd('orchestrator')}>Add the orchestrator</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {(selected || adding) && (
        <>
          <div className="fleet-backdrop" onClick={() => { setSelectedId(null); setAdding(null) }} />
          <aside className="fleet-drawer">
            <div className="fleet-drawer-head">
              <I name={adding === 'orchestrator' || selected?.kind === 'orchestrator' ? 'hub' : 'smart_toy'} size={18} />
              <span className="name">{adding ? (adding === 'orchestrator' ? 'New orchestrator' : 'New agent') : selected?.name}</span>
              {selected && !adding && (
                <>
                  <button className="fleet-btn" onClick={() => openThread(selected.threadId)}>Open thread</button>
                  <button className="fleet-btn danger" onClick={() => void removeAgent()}>Delete</button>
                </>
              )}
              <button className="fleet-btn" onClick={() => { setSelectedId(null); setAdding(null) }}>✕</button>
            </div>
            <div className="fleet-drawer-body">
              {selected && !adding && (
                <div className="fleet-msg">
                  <div className="fleet-section-label">
                    {selected.kind === 'orchestrator' ? 'Give the orchestrator a task' : 'Message · steer · queue'}
                  </div>
                  <textarea
                    value={msg}
                    onChange={(e) => setMsg(e.target.value)}
                    rows={3}
                    placeholder={selected.kind === 'orchestrator' ? 'It will delegate to its agents…' : 'Send a task, steer its run, or queue behind it…'}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void (async () => { if (await sendTo(selected, msg, disposition)) setMsg('') })() } }}
                  />
                  <div className="fleet-row" style={{ marginTop: 6 }}>
                    <select value={disposition} onChange={(e) => setDisposition(e.target.value as typeof disposition)}>
                      <option value="send">Send{selected.running ? ' (after current)' : ''}</option>
                      <option value="steer">Steer (fold into run)</option>
                      <option value="queue">Queue (after current)</option>
                    </select>
                    <button className="fleet-btn primary" disabled={!msg.trim() || busy} onClick={() => void (async () => { if (await sendTo(selected, msg, disposition)) setMsg('') })()}>Send</button>
                  </div>
                </div>
              )}

              <div>
                {selected && !adding && <div className="fleet-section-label">Configuration</div>}
                <AgentEditor
                  form={form}
                  setForm={setForm}
                  busy={busy}
                  onSubmit={() => (adding ? void createAgent() : void saveAgent())}
                  submitLabel={adding ? 'Create agent' : 'Save changes'}
                  lockKind={!adding}
                />
              </div>
            </div>
          </aside>
        </>
      )}

      <datalist id="fleet-models">
        {models.map((m) => <option key={m.id} value={m.id} />)}
      </datalist>
    </>
  )
}

/** The create/edit form for one agent (rendered inside the drawer). */
function AgentEditor({
  form,
  setForm,
  busy,
  onSubmit,
  submitLabel,
  lockKind
}: {
  form: AgentForm
  setForm: React.Dispatch<React.SetStateAction<AgentForm>>
  busy: boolean
  onSubmit: () => void
  submitLabel: string
  lockKind?: boolean
}): React.JSX.Element {
  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]): void => setForm((f) => ({ ...f, [key]: value }))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="fleet-two">
        <label className="fleet-field"><span>Name</span>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="eBay Sourcing" />
        </label>
        <label className="fleet-field"><span>Kind</span>
          <select value={form.kind} onChange={(e) => set('kind', e.target.value as AgentKind)} disabled={lockKind}>
            <option value="orchestrator">Orchestrator</option>
            <option value="worker">Worker</option>
          </select>
        </label>
      </div>
      <label className="fleet-field"><span>Role — the mission, injected into its prompt</span>
        <textarea value={form.role} onChange={(e) => set('role', e.target.value)} rows={4} placeholder="You source computer parts on eBay…" />
      </label>
      <div className="fleet-two">
        <label className="fleet-field"><span>Model</span>
          <input list="fleet-models" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="provider/model" />
        </label>
        <label className="fleet-field"><span>Working directory</span>
          <input value={form.cwd} onChange={(e) => set('cwd', e.target.value)} placeholder="~/work/ebay" />
        </label>
        <label className="fleet-field"><span>Mode</span>
          <select value={form.mode} onChange={(e) => set('mode', e.target.value as Mode)}>
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="fleet-field"><span>Permissions</span>
          <select value={form.permissionPreset} onChange={(e) => set('permissionPreset', e.target.value as PermissionPreset)}>
            {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <label className="fleet-field"><span>Tools (comma-separated; blank = all its mode allows; MCP tools it loads are always kept)</span>
        <input value={form.allowedTools} onChange={(e) => set('allowedTools', e.target.value)} placeholder="fs_read, shell, memory_search, find_mcp" />
      </label>
      <label className="fleet-check">
        <input type="checkbox" checked={form.rolling} onChange={(e) => set('rolling', e.target.checked)} />
        Rolling context — lives forever, folds old turns into memory (recommended for workers)
      </label>
      <div className="fleet-row">
        <button className="fleet-btn primary" onClick={onSubmit} disabled={busy}>{submitLabel}</button>
      </div>
    </div>
  )
}
