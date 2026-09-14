import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentKind, ApprovalRequest, AskRequest, Fleet, FleetActivityItem, FleetAgentView, Mode, PermissionPreset, SessionActivity } from '@shared/types'
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
    // Agents run unattended: under `workspace` every web/MCP/shell call parks on an approval card in
    // a hidden thread, which is how a fleet "silently dies". Full is the working default.
    permissionPreset: 'full',
    cwd: '',
    rolling: true,
    allowedTools: ''
  }
}

/** Builtin tool names a worker allowlist can name — shown as a hint under the Tools field. */
const TOOL_HINT =
  'web_search, web_fetch, fetch_image, fs_read, fs_write, fs_edit, fs_list, grep_search, shell, start_job, ' +
  'memory_save, todo_write, find_mcp'

const STYLE = `
.fleet-screen { position: fixed; inset: 0; z-index: 60; background: var(--canvas); color: var(--text);
  font-family: var(--font-ui); display: flex; flex-direction: column; }
.fleet-top { height: 56px; flex: none; display: flex; align-items: center; gap: 10px;
  padding: 0 18px 0 84px; border-bottom: 1px solid var(--hairline); background: var(--shell);
  -webkit-app-region: drag; }
.fleet-top button, .fleet-top select { -webkit-app-region: no-drag; }
.fleet-top .fleet-mark { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; }
.fleet-top select { background: var(--raised); color: var(--text); border: 1px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 5px 8px; font-size: 13px; }
.fleet-spacer { flex: 1; }
.fleet-ghost { background: transparent; color: var(--text-dim); border: 1px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 6px 12px; font-size: 13px; cursor: pointer; }
.fleet-ghost:hover { background: var(--raised); color: var(--text); }

.fleet-body { flex: 1; overflow: auto; padding: 30px 30px 64px; }
.fleet-inner { max-width: 1140px; margin: 0 auto; }

.fleet-orch { display: grid; grid-template-columns: auto 1fr auto; gap: 18px; align-items: center;
  background: var(--panel); border: 1px solid var(--hairline-strong); border-left: 3px solid var(--violet);
  border-radius: var(--radius); padding: 22px 24px; }
.fleet-orch .fleet-orch-text { cursor: pointer; }
.fleet-orch .badge-hub { width: 50px; height: 50px; border-radius: 13px; display: grid; place-items: center;
  background: color-mix(in srgb, var(--violet) 22%, transparent); color: var(--violet-soft); cursor: pointer; }
.fleet-orch h2 { margin: 0 0 4px; font-size: 21px; }
.fleet-orch-model { display: flex; flex-direction: column; gap: 5px; min-width: 200px; }
.fleet-orch-model select { background: var(--raised); color: var(--text); border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; }
.fleet-mini-label { font-size: 10px; letter-spacing: .07em; text-transform: uppercase; color: var(--text-faint); }
.fleet-agents-label { font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--text-faint); margin: 24px 2px 0; }
.fleet-kicker { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--violet-soft); }
.fleet-role { color: var(--text-dim); font-size: 13.5px; line-height: 1.5; margin-top: 7px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

.fleet-command { display: flex; gap: 8px; align-items: center; margin: 16px 0 4px; }
.fleet-command input { flex: 1; height: 50px; background: var(--panel); color: var(--text);
  border: 1px solid var(--hairline-strong); border-radius: var(--radius); padding: 0 16px; font-size: 15px; }
.fleet-command input:focus { outline: none; border-color: var(--violet); }
.fleet-command select { height: 50px; background: var(--raised); color: var(--text-dim);
  border: 1px solid var(--hairline); border-radius: var(--radius-sm); padding: 0 8px; font-size: 12px; }
.fleet-send { height: 50px; padding: 0 22px; border: none; border-radius: var(--radius); cursor: pointer;
  background: var(--violet); color: #16131f; font-weight: 600; font-size: 15px; }
.fleet-send:disabled { opacity: .45; cursor: default; }

.fleet-connector { display: flex; flex-direction: column; align-items: center; margin: 18px 0 6px; }
.fleet-connector .line { width: 2px; height: 20px; background: var(--hairline-strong); }
.fleet-connector .label { font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-faint); margin-top: 6px; }

.fleet-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(252px, 1fr)); gap: 18px;
  margin-top: 10px; }
.fleet-card { background: var(--panel); border: 1px solid var(--hairline-strong); border-radius: var(--radius);
  padding: 18px; cursor: pointer; display: flex; flex-direction: column; gap: 12px; min-height: 152px;
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
.fleet-card .name { font-weight: 600; font-size: 16px; }
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

.fleet-map { position: relative; }
.fleet-lines { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; overflow: visible; }
.fleet-lines path { fill: none; stroke: var(--hairline-strong); stroke-width: 2; opacity: .9; }
.fleet-lines path.active { stroke: var(--green); opacity: 1; stroke-width: 2.5;
  stroke-dasharray: 5 7; animation: fleetFlow .8s linear infinite; }
@keyframes fleetFlow { to { stroke-dashoffset: -24; } }

.fleet-needs { background: color-mix(in srgb, var(--brass) 12%, var(--panel)); border: 1px solid var(--brass);
  border-radius: var(--radius); padding: 16px 18px; margin-bottom: 18px; display: flex; flex-direction: column; gap: 4px; }
.fleet-needs h3 { margin: 0 0 6px; font-size: 13px; letter-spacing: .04em; text-transform: uppercase;
  color: var(--brass); display: flex; align-items: center; gap: 8px; }
.fleet-need { display: flex; flex-direction: column; gap: 9px; padding: 12px 0; border-top: 1px solid var(--hairline); }
.fleet-need:first-of-type { border-top: none; }
.fleet-need .who { font-size: 12px; color: var(--brass); font-weight: 600; }
.fleet-need .q { color: var(--text); font-size: 14.5px; line-height: 1.45; }
.fleet-need .answer { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.fleet-need input { flex: 1; min-width: 220px; background: var(--panel); color: var(--text);
  border: 1px solid var(--hairline-strong); border-radius: var(--radius-sm); padding: 9px 11px; font-size: 13px; }

.fleet-model-btn { width: 100%; background: var(--raised); color: var(--text); border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm); padding: 9px 11px; font-size: 13px; cursor: pointer; text-align: left;
  display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.fleet-model-btn:hover { border-color: var(--violet); }
.fleet-model-btn .chev { color: var(--text-faint); }

.fleet-live { background: var(--panel); border: 1px solid var(--hairline); border-radius: var(--radius-sm);
  padding: 12px; display: flex; flex-direction: column; gap: 7px; }
.fleet-live .doing { color: var(--green); font-size: 13.5px; display: flex; gap: 7px; align-items: center; }
.fleet-live .tool { font-size: 12px; color: var(--text-dim); display: flex; gap: 7px; align-items: center; }
.fleet-live .tool .t-name { color: var(--text); }
.fleet-head, .fleet-grid { position: relative; z-index: 1; }
.fleet-card .preview { color: var(--text-dim); font-size: 12.5px; line-height: 1.4; flex: 1;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.fleet-card .preview.live { color: var(--green); }
.fleet-feed { margin-top: 28px; background: var(--panel); border: 1px solid var(--hairline); border-radius: var(--radius); }
.fleet-feed-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--hairline);
  font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--text-faint); }
.fleet-feed-empty { padding: 16px; color: var(--text-faint); font-size: 13px; }
.fleet-feed-item { display: grid; grid-template-columns: 64px 1fr; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--hairline);
  cursor: pointer; text-align: left; background: transparent; border-left: none; border-right: none; border-bottom: none; color: inherit; width: 100%; }
.fleet-feed-item:first-of-type { border-top: none; }
.fleet-feed-item:hover { background: var(--raised); }
.fleet-feed-item .when { font-size: 11.5px; color: var(--text-faint); padding-top: 2px; }
.fleet-feed-item .route { font-size: 12.5px; font-weight: 600; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.fleet-feed-item .route .arrow { color: var(--text-faint); font-weight: 400; }
.fleet-feed-item .route .tag { font-size: 10.5px; font-weight: 500; color: var(--text-faint); border: 1px solid var(--hairline); border-radius: 999px; padding: 0 6px; }
.fleet-feed-item .body { color: var(--text-dim); font-size: 12.5px; line-height: 1.45; margin-top: 3px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; }
.fleet-feed-item.open .body { display: block; -webkit-line-clamp: unset; }
.fleet-dot.needs { background: var(--brass); }
.fleet-dot.error { background: var(--red); }
.fleet-status.needs { color: var(--brass); }
.fleet-status.error { color: var(--red); }
`

export function FleetScreen(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.fleetOpen)
  const setUi = useStore((s) => s.setUi)
  const selectThread = useStore((s) => s.selectThread)
  const flash = useStore((s) => s.flash)
  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const openModelPicker = useStore((s) => s.openModelPicker)
  const asks = useStore((s) => s.asks)
  const approvals = useStore((s) => s.approvals)
  const respondAsk = useStore((s) => s.respondAsk)
  const respondApproval = useStore((s) => s.respondApproval)
  const defaultModel = settings?.defaultModel ?? models[0]?.id ?? ''
  const nameOf = (id: string): string => (id ? models.find((m) => m.id === id)?.name ?? id : 'Choose model')

  const [fleets, setFleets] = useState<Fleet[]>([])
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [agents, setAgents] = useState<FleetAgentView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState<AgentKind | null>(null)
  const [form, setForm] = useState<AgentForm>(() => blankForm('worker', defaultModel))
  const [msg, setMsg] = useState('')
  const [disposition, setDisposition] = useState<'send' | 'steer' | 'queue'>('send')
  const [busy, setBusy] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [detail, setDetail] = useState<SessionActivity | null>(null)
  const [feed, setFeed] = useState<FleetActivityItem[]>([])
  const [feedOpen, setFeedOpen] = useState<string | null>(null)

  const fleetIdRef = useRef<string | null>(null)
  fleetIdRef.current = fleetId

  const orchestrator = useMemo(() => agents.find((a) => a.kind === 'orchestrator'), [agents])
  const workers = useMemo(
    () => agents.filter((a) => a.kind === 'worker').sort((a, b) => a.sortOrder - b.sortOrder),
    [agents]
  )
  const selected = useMemo(() => agents.find((a) => a.id === selectedId) ?? null, [agents, selectedId])

  // Pending questions/approvals for any agent in this fleet — surfaced right on the screen so an
  // orchestrator escalating with ask_user (or a mid-run approval) is answerable here, not buried in
  // a hidden agent thread. The store already tracks every pending ask/approval across threads.
  const agentByThread = useMemo(() => new Map(agents.map((a) => [a.threadId, a])), [agents])
  const pendingAsks = useMemo(() => asks.filter((a) => agentByThread.has(a.threadId)), [asks, agentByThread])
  const pendingApprovals = useMemo(
    () => approvals.filter((a) => agentByThread.has(a.threadId)),
    [approvals, agentByThread]
  )

  // Live "what is it doing now" for the open agent, refreshed while the drawer is up.
  const selThread = selected?.threadId
  useEffect(() => {
    if (!open || !selThread || adding) {
      setDetail(null)
      return
    }
    let cancelled = false
    const load = (): void => {
      void window.lattice
        .getSessionActivity(selThread)
        .then((d) => {
          if (!cancelled) setDetail(d)
        })
        .catch(() => {})
    }
    load()
    const t = window.setInterval(load, 2000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [open, selThread, adding])

  // Connector lines fan from the orchestrator down to each worker card. They are geometry, so they
  // are measured from the DOM after layout and recomputed on any resize or roster change.
  const mapRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const workerEls = useRef<Map<string, HTMLElement>>(new Map())
  const [lines, setLines] = useState<{ d: string; active: boolean }[]>([])

  const recomputeLines = useCallback(() => {
    const map = mapRef.current
    const head = headRef.current
    if (!map || !head) {
      setLines([])
      return
    }
    const m = map.getBoundingClientRect()
    const h = head.getBoundingClientRect()
    const sx = h.left + h.width / 2 - m.left
    const sy = h.bottom - m.top
    const next: { d: string; active: boolean }[] = []
    for (const w of workers) {
      const el = workerEls.current.get(w.id)
      if (!el) continue
      const r = el.getBoundingClientRect()
      const tx = r.left + r.width / 2 - m.left
      const ty = r.top - m.top
      const midY = (sy + ty) / 2
      next.push({ d: `M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`, active: w.running })
    }
    setLines(next)
  }, [workers])

  useLayoutEffect(() => {
    if (!open) return
    recomputeLines()
    const ro = new ResizeObserver(() => recomputeLines())
    if (mapRef.current) ro.observe(mapRef.current)
    window.addEventListener('resize', recomputeLines)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', recomputeLines)
    }
  }, [open, agents, recomputeLines])

  const loadAgents = useCallback(async (id: string) => {
    const [list, activity] = await Promise.all([
      window.lattice.listAgents(id).catch(() => [] as FleetAgentView[]),
      window.lattice.listFleetActivity(id, 40).catch(() => [] as FleetActivityItem[])
    ])
    if (fleetIdRef.current === id) {
      setAgents(list)
      setFeed(activity)
    }
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

  const answerAsk = (req: AskRequest, value: string): void => {
    void respondAsk({ requestId: req.id, answer: value })
    setAnswers((a) => {
      const next = { ...a }
      delete next[req.id]
      return next
    })
  }
  const decideApproval = (req: ApprovalRequest, effect: 'allow' | 'deny'): void => {
    void respondApproval({ requestId: req.id, effect, scope: 'once' })
  }
  const openAgentModel = (agent: { id: string; model: string }): void =>
    openModelPicker({ intent: 'agent', agent: { id: agent.id, model: agent.model } })

  const newFleet = async (): Promise<void> => {
    const name = window.prompt('Name the new fleet', 'New Fleet')?.trim()
    if (!name) return
    const created = await window.lattice.createFleet({ name }).catch(() => null)
    if (!created) {
      flash('Could not create the fleet.', 'warn')
      return
    }
    setFleets((f) => [...f, created])
    setFleetId(created.id)
    fleetIdRef.current = created.id
    setSelectedId(null)
    setAdding(null)
    await loadAgents(created.id)
  }

  const currentFleet = fleets.find((f) => f.id === fleetId) ?? null

  const renameCurrentFleet = async (): Promise<void> => {
    if (!currentFleet) return
    const name = window.prompt('Rename this fleet', currentFleet.name)?.trim()
    if (!name || name === currentFleet.name) return
    try {
      const updated = await window.lattice.renameFleet(currentFleet.id, name)
      setFleets((f) => f.map((x) => (x.id === updated.id ? updated : x)))
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not rename.', 'warn')
    }
  }

  const deleteCurrentFleet = async (): Promise<void> => {
    if (!currentFleet) return
    const n = agents.length
    const what = n ? ` and its ${n} agent${n === 1 ? '' : 's'} (their threads too)` : ''
    if (!window.confirm(`Delete the fleet “${currentFleet.name}”${what}? This cannot be undone.`)) return
    try {
      await window.lattice.deleteFleet(currentFleet.id)
      setSelectedId(null)
      setAdding(null)
      fleetIdRef.current = null
      setFleetId(null)
      await loadFleets()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not delete.', 'warn')
    }
  }

  if (!open) return null

  const tone = (a: FleetAgentView): string =>
    a.running || a.status === 'running'
      ? 'running'
      : a.status === 'waiting-approval' || a.status === 'waiting-answer'
        ? 'needs'
        : a.status === 'error'
          ? 'error'
          : a.unread > 0
            ? 'queued'
            : 'idle'
  const base = (p?: string): string => (p ? p.split('/').filter(Boolean).pop() ?? p : '')
  const fmtWhen = (ts: number): string => {
    const d = new Date(ts)
    const sameDay = new Date().toDateString() === d.toDateString()
    return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  const card = (a: FleetAgentView): React.JSX.Element => {
    const live = !!a.activity
    const body = live ? a.activity! : a.preview || a.role || ''
    return (
      <button
        key={a.id}
        ref={(el) => {
          if (el) workerEls.current.set(a.id, el)
          else workerEls.current.delete(a.id)
        }}
        className={`fleet-card ${a.id === selectedId ? 'sel' : ''}`}
        onClick={() => {
          setAdding(null)
          setSelectedId(a.id)
        }}
      >
        <div className="head">
          <span className={`fleet-dot ${tone(a)}`} />
          <span className="name">{a.name}</span>
        </div>
        {body && <div className={`preview ${live ? 'live' : ''}`}>{live ? `⏳ ${body}` : body}</div>}
        <div className="fleet-chips">
          {a.model && <span className="fleet-chip" title={a.model}>{a.model}</span>}
          {a.cwd && <span className="fleet-chip" title={a.cwd}>📁 {base(a.cwd)}</span>}
          {a.rolling && <span className="fleet-chip">rolling</span>}
        </div>
        <span className={`fleet-status ${tone(a)}`}>{a.statusText}</span>
      </button>
    )
  }

  const renderAsk = (req: AskRequest): React.JSX.Element => {
    const who = agentByThread.get(req.threadId)?.name ?? 'An agent'
    const val = answers[req.id] ?? ''
    const submit = (): void => { if (val.trim()) answerAsk(req, val.trim()) }
    return (
      <div className="fleet-need" key={req.id}>
        <span className="who">{who} asks</span>
        <span className="q">{req.question}</span>
        <div className="answer">
          {req.kind === 'confirm' ? (
            <>
              <button className="fleet-btn primary" onClick={() => answerAsk(req, 'yes')}>Yes</button>
              <button className="fleet-btn" onClick={() => answerAsk(req, 'no')}>No</button>
            </>
          ) : (
            <>
              {req.kind === 'choice' &&
                (req.options ?? []).map((o) => (
                  <button key={o.label} className={`fleet-btn ${o.recommended ? 'primary' : ''}`} title={o.description} onClick={() => answerAsk(req, o.label)}>
                    {o.label}
                  </button>
                ))}
              <input
                placeholder={req.kind === 'choice' ? 'Other…' : req.placeholder ?? 'Your answer…'}
                value={val}
                onChange={(e) => setAnswers((a) => ({ ...a, [req.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
              />
              <button className="fleet-btn primary" disabled={!val.trim()} onClick={submit}>Send</button>
            </>
          )}
        </div>
      </div>
    )
  }

  const renderApproval = (req: ApprovalRequest): React.JSX.Element => {
    const who = agentByThread.get(req.threadId)?.name ?? 'An agent'
    return (
      <div className="fleet-need" key={req.id}>
        <span className="who">{who} needs approval</span>
        <span className="q">{req.summary || req.tool}</span>
        <div className="answer">
          <button className="fleet-btn primary" onClick={() => decideApproval(req, 'allow')}>Allow</button>
          <button className="fleet-btn danger" onClick={() => decideApproval(req, 'deny')}>Deny</button>
        </div>
      </div>
    )
  }

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
          <button className="fleet-ghost" onClick={() => void renameCurrentFleet()} disabled={!currentFleet} title="Rename this fleet">Rename</button>
          <button className="fleet-ghost" onClick={() => void newFleet()}>+ Fleet</button>
          <button className="fleet-ghost" onClick={() => void deleteCurrentFleet()} disabled={!currentFleet} title="Delete this fleet and its agents">Delete fleet</button>
          <div className="fleet-spacer" />
          <button className="fleet-ghost" onClick={() => setUi({ fleetOpen: false })}>Done ✕</button>
        </div>

        <div className="fleet-body">
          <div className="fleet-inner">
            {(pendingAsks.length > 0 || pendingApprovals.length > 0) && (
              <div className="fleet-needs">
                <h3><I name="front_hand" size={15} /> Needs you</h3>
                {pendingAsks.map(renderAsk)}
                {pendingApprovals.map(renderApproval)}
              </div>
            )}
            {orchestrator ? (
              <div className="fleet-map" ref={mapRef}>
                <svg className="fleet-lines">
                  {lines.map((l, i) => (
                    <path key={i} d={l.d} className={l.active ? 'active' : ''} />
                  ))}
                </svg>
                <div className="fleet-head" ref={headRef}>
                <div className="fleet-orch">
                  <div className="badge-hub" onClick={() => { setAdding(null); setSelectedId(orchestrator.id) }}>
                    <I name="hub" size={24} />
                  </div>
                  <div className="fleet-orch-text" onClick={() => { setAdding(null); setSelectedId(orchestrator.id) }}>
                    <div className="fleet-kicker">Orchestrator</div>
                    <h2>{orchestrator.name}</h2>
                    {orchestrator.role && <div className="fleet-role">{orchestrator.role}</div>}
                  </div>
                  <div className="fleet-orch-model" onClick={(e) => e.stopPropagation()}>
                    <span className="fleet-mini-label">Model</span>
                    <button className="fleet-model-btn" onClick={() => openAgentModel(orchestrator)} title="Change the orchestrator's model">
                      <span>{nameOf(orchestrator.model)}</span><span className="chev">▾</span>
                    </button>
                    <button className="fleet-ghost" onClick={() => { setAdding(null); setSelectedId(orchestrator.id) }}>Configure</button>
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
                </div>

                <div className="fleet-agents-label">Agents · {workers.length}</div>
                <div className="fleet-grid">
                  {workers.map(card)}
                  <button className="fleet-add" onClick={() => startAdd('worker')}><I name="add" size={22} /> Add agent</button>
                </div>

                <div className="fleet-feed" onClick={(e) => e.stopPropagation()}>
                  <div className="fleet-feed-head"><I name="forum" size={14} /> Activity — delegations, reports and questions between agents</div>
                  {feed.length === 0 ? (
                    <div className="fleet-feed-empty">Nothing yet. Give {orchestrator.name} a task above; every hand-off and every report shows up here.</div>
                  ) : (
                    feed.map((item) => {
                      const from = agentByThread.get(item.fromThreadId)
                      const to = agentByThread.get(item.toThreadId)
                      const isReport = from?.kind === 'worker' && to?.kind === 'orchestrator'
                      const open = feedOpen === item.id
                      return (
                        <button
                          key={item.id}
                          className={`fleet-feed-item${open ? ' open' : ''}`}
                          onClick={() => setFeedOpen(open ? null : item.id)}
                          onDoubleClick={() => openThread(item.toThreadId)}
                          title="Click to expand · double-click to open the receiving agent's thread"
                        >
                          <span className="when">{fmtWhen(item.createdAt)}</span>
                          <span>
                            <span className="route">
                              {item.fromName} <span className="arrow">→</span> {item.toName}
                              <span className="tag">{isReport ? 'report' : item.delivery === 'injected' ? 'steer' : item.delivery === 'woken' ? 'task' : 'queued'}</span>
                            </span>
                            <span className="body">{item.body}</span>
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            ) : (
              <div className="fleet-empty">
                <h2>Build your fleet</h2>
                <p>A fleet is a persistent orchestrator plus dedicated agents — each with its own working
                  directory, tools and memory. Add the orchestrator, give it workers, then tell it what you
                  want and it delegates the work and reports back.</p>
                <p>Or build it from any chat: tell the model what the team should do and it creates the
                  whole fleet in one call (the <code>create_fleet</code> tool) — it shows up here.</p>
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

              {selected && !adding && detail && (detail.activity || (detail.tools?.length ?? 0) > 0) && (
                <div>
                  <div className="fleet-section-label">Working now</div>
                  <div className="fleet-live">
                    {detail.activity && (
                      <div className="doing"><span className="fleet-dot running" /> {detail.activity}</div>
                    )}
                    {(detail.tools ?? []).slice().reverse().slice(0, 5).map((t) => (
                      <div className="tool" key={t.callId}>
                        <I name={t.status === 'running' ? 'pending' : t.status === 'ok' ? 'check' : 'close'} size={12} />
                        <span className="t-name">{t.tool}</span>
                        {t.summary ? ` — ${t.summary}` : ''}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                {selected && !adding && <div className="fleet-section-label">Configuration</div>}
                <AgentEditor
                  form={form}
                  setForm={setForm}
                  models={models}
                  busy={busy}
                  onSubmit={() => (adding ? void createAgent() : void saveAgent())}
                  submitLabel={adding ? 'Create agent' : 'Save changes'}
                  lockKind={!adding}
                  pickModel={selected && !adding ? () => openAgentModel({ id: selected.id, model: form.model }) : undefined}
                />
              </div>
            </div>
          </aside>
        </>
      )}

    </>
  )
}

/** The create/edit form for one agent (rendered inside the drawer). */
function AgentEditor({
  form,
  setForm,
  models,
  busy,
  onSubmit,
  submitLabel,
  lockKind,
  pickModel
}: {
  form: AgentForm
  setForm: React.Dispatch<React.SetStateAction<AgentForm>>
  models: { id: string; name?: string }[]
  busy: boolean
  onSubmit: () => void
  submitLabel: string
  lockKind?: boolean
  /** When present (editing an existing agent), the Model field opens the real picker and saves immediately. */
  pickModel?: () => void
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
          {pickModel ? (
            <button type="button" className="fleet-model-btn" onClick={pickModel} title="Change model — opens the full model picker">
              <span>{models.find((m) => m.id === form.model)?.name ?? form.model ?? 'Choose model'}</span>
              <span className="chev">▾</span>
            </button>
          ) : (
            <select value={form.model} onChange={(e) => set('model', e.target.value)}>
              {form.model && !models.some((m) => m.id === form.model) && <option value={form.model}>{form.model}</option>}
              {models.length === 0 && !form.model && <option value="">(no models loaded)</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name && m.name !== m.id ? `${m.name} — ${m.id}` : m.id}
                </option>
              ))}
            </select>
          )}
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
      <div className="fleet-check" style={{ marginTop: -6 }}>
        {form.permissionPreset === 'full'
          ? 'Full: runs unattended — web, MCP and shell calls never wait on you.'
          : form.permissionPreset === 'workspace'
            ? 'Workspace: every web, MCP and shell call waits for your approval (shown under “Needs you” here). An unattended agent stalls there.'
            : 'Manual: read-only tools only; everything else is refused.'}
      </div>
      <label className="fleet-field"><span>{form.kind === 'orchestrator'
        ? 'Extra tools (comma-separated). An orchestrator only gets coordination tools — delegate, peek, message, memory, ask — so it must hand work to its agents; name any work tool here to add it back.'
        : 'Tools (comma-separated; blank = all its mode allows; MCP tools it loads are always kept)'}</span>
        <input value={form.allowedTools} onChange={(e) => set('allowedTools', e.target.value)} placeholder="web_search, web_fetch, fs_write" />
        <span title={TOOL_HINT}>Builtins: {TOOL_HINT}. Messaging + memory_search are always kept.</span>
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
