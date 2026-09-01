import { create } from 'zustand'
import type {
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  AskRequest,
  AskResponse,
  ChatMessage,
  ContextBudget,
  McpServerConfig,
  McpServerStatus,
  ModelInfo,
  RunEvent,
  SendOptions,
  ThreadGroup,
  ThreadMeta
} from '@shared/types'
import type { PushEvent } from '@shared/ipc'

interface UiState {
  inspectorOpen: boolean
  inspectorTab: 'context' | 'run' | 'tasks' | 'memory' | 'agents' | 'mcp'
  modelPickerOpen: boolean
  settingsOpen: boolean
  railCollapsed: boolean
}

interface LatticeState {
  ready: boolean
  threads: ThreadMeta[]
  /** user-defined sidebar folders (manual grouping) */
  groups: ThreadGroup[]
  activeThreadId: string | null
  messages: ChatMessage[]
  events: RunEvent[]
  models: ModelInfo[]
  /** most-recently-selected model ids, newest first (persisted locally) */
  recentModelIds: string[]
  /** how many times each model id has been selected (persisted locally) */
  modelUsage: Record<string, number>
  mcpServers: { config: McpServerConfig; status: McpServerStatus }[]
  settings: AppSettings | null
  budget: ContextBudget | null
  /** tool calls awaiting the user's approval, across all threads */
  approvals: ApprovalRequest[]
  /** questions the model has put to the user (ask_user), across all threads */
  asks: AskRequest[]
  /** ids of threads whose run finished while the user wasn't viewing them (green dot) */
  completedThreads: Set<string>
  ui: UiState

  init(): Promise<void>
  respondApproval(decision: ApprovalDecision): Promise<void>
  respondAsk(response: AskResponse): Promise<void>
  refreshMcp(): Promise<void>
  selectThread(id: string): Promise<void>
  newThread(): Promise<void>
  renameThread(id: string, title: string): Promise<void>
  setThreadPinned(id: string, pinned: boolean): Promise<void>
  setThreadArchived(id: string, archived: boolean): Promise<void>
  deleteThread(id: string): Promise<void>
  // ---- thread groups (sidebar organization) ----
  /** Create a group and (optionally) immediately file a thread into it. Returns the new group id. */
  createGroup(name: string, opts?: { color?: string; assign?: string }): Promise<string>
  renameGroup(id: string, name: string): Promise<void>
  setGroupColor(id: string, color: string): Promise<void>
  deleteGroup(id: string): Promise<void>
  /** File a thread into a group, or clear its group with `null`. */
  assignThreadGroup(threadId: string, groupId: string | null): Promise<void>
  /** Set (or clear, with '') the active thread's north-star goal. */
  setGoal(goal: string): Promise<void>
  /** Fork the active thread into a side conversation; optionally seed it with a first prompt. */
  forkThread(opts?: { titlePrefix?: string; seed?: string }): Promise<void>
  /** Compact the active thread's history into a summary. Returns a human-readable result note. */
  compactThread(): Promise<string>
  /** Clear the active thread's messages, keeping the thread and its settings. */
  clearThread(): Promise<void>
  send(opts: Omit<SendOptions, 'threadId'>): Promise<void>
  /** Remove a still-queued turn from the active thread. */
  dequeueMessage(id: string): Promise<void>
  /** Edit the text of a still-queued turn on the active thread. */
  editQueuedMessage(id: string, text: string): Promise<void>
  cancel(): Promise<void>
  setModel(model: string): Promise<void>
  setEffort(effort: string): Promise<void>
  setMode(mode: ThreadMeta['mode']): Promise<void>
  setPreset(preset: ThreadMeta['permissionPreset']): Promise<void>
  setDefaultModel(model: string): Promise<void>
  saveSettings(patch: Partial<AppSettings>): Promise<void>
  refreshBudget(): Promise<void>
  setUi(patch: Partial<UiState>): void
  /** transient command feedback shown as a toast; auto-clears */
  notice: { text: string; tone: 'info' | 'warn' } | null
  flash(text: string, tone?: 'info' | 'warn'): void
}

const RECENTS_KEY = 'lattice.recentModels'
const RECENTS_MAX = 6

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENTS_MAX) : []
  } catch {
    return []
  }
}

const USAGE_KEY = 'lattice.modelUsage'

function readUsage(): Record<string, number> {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeUsage(usage: Record<string, number>): void {
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage))
  } catch {
    /* storage unavailable — usage counts are a convenience, not load-bearing */
  }
}

function writeRecents(ids: string[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(ids.slice(0, RECENTS_MAX)))
  } catch {
    /* storage unavailable — recents are a convenience, not load-bearing */
  }
}

export const useStore = create<LatticeState>((set, get) => {
  // Highest checklist size we've seen per thread. We pop the inspector open whenever the count
  // grows (a genuinely new task was created) but not on mere status flips — so a status change
  // never yanks a panel the user deliberately closed back open.
  const tasksSeenCount = new Map<string, number>()
  // ---- push subscription (module-level, once) ----
  if (typeof window !== 'undefined' && window.lattice) {
    window.lattice.onPush((event: PushEvent) => {
      const s = get()
      if (event.kind === 'thread.updated') {
        const prev = s.threads.find((t) => t.id === event.meta.id)
        let completed = s.completedThreads
        if (event.meta.running) {
          // a run started/continues — clear any stale completion marker
          if (completed.has(event.meta.id)) {
            completed = new Set(completed)
            completed.delete(event.meta.id)
          }
        } else if (prev?.running && event.meta.id !== s.activeThreadId) {
          // a run just finished on a thread the user isn't viewing — flag it
          completed = new Set(completed)
          completed.add(event.meta.id)
        }
        set({
          completedThreads: completed,
          threads: sortThreads(
            s.threads.some((t) => t.id === event.meta.id)
              ? s.threads.map((t) => (t.id === event.meta.id ? { ...t, ...event.meta } : t))
              : [event.meta, ...s.threads]
          )
        })
      } else if (event.kind === 'groups.updated') {
        set({ groups: event.groups })
      } else if (event.kind === 'thread.deleted') {
        if (!s.threads.some((t) => t.id === event.id)) return
        const threads = s.threads.filter((t) => t.id !== event.id)
        const completedThreads = s.completedThreads.has(event.id)
          ? new Set([...s.completedThreads].filter((t) => t !== event.id))
          : s.completedThreads
        set({ threads, completedThreads })
        if (s.activeThreadId === event.id) {
          const next = threads.find((t) => !t.archived)
          if (next) void get().selectThread(next.id)
          else void get().newThread()
        }
      } else if (event.kind === 'message.updated') {
        if (event.message.threadId !== s.activeThreadId) return
        const exists = s.messages.some((m) => m.id === event.message.id)
        set({
          messages: exists
            ? s.messages.map((m) => (m.id === event.message.id ? event.message : m))
            : [...s.messages, event.message]
        })
      } else if (event.kind === 'message.deleted') {
        if (event.threadId !== s.activeThreadId) return
        set({ messages: s.messages.filter((m) => m.id !== event.messageId) })
      } else if (event.kind === 'run.event') {
        if (event.event.threadId !== s.activeThreadId) return
        const evt = event.event
        // Redelivered events (retry/reconnect) must not double-count: a duplicated `usage`
        // event would inflate every aggregate that sums the events array (cache badge, panels).
        if (s.events.some((e) => e.id === evt.id)) return
        // First event carrying a not-yet-seen agent id = a subagent just spawned. Pop the
        // inspector open on its Agents tab so the user sees the fan-out as it happens.
        const spawnedSubagent = !!evt.agent && !s.events.some((e) => e.agent === evt.agent)
        set({
          events: [...s.events, evt],
          ...(spawnedSubagent
            ? { ui: { ...s.ui, inspectorOpen: true, inspectorTab: 'agents' as const } }
            : {})
        })
        if (evt.body.type === 'run.completed') void get().refreshBudget()
      } else if (event.kind === 'todos.updated') {
        // A checklist changed. If a new item was created (the count grew past anything we've seen
        // for this thread), pop the inspector open on the Tasks tab so the plan animates into view.
        if (event.threadId && event.todos) {
          const count = event.todos.length
          const grew = count > (tasksSeenCount.get(event.threadId) ?? 0)
          tasksSeenCount.set(event.threadId, Math.max(count, tasksSeenCount.get(event.threadId) ?? 0))
          if (grew && event.threadId === s.activeThreadId) {
            set({ ui: { ...s.ui, inspectorOpen: true, inspectorTab: 'tasks' } })
          }
        }
      } else if (event.kind === 'mcp.updated') {
        void get().refreshMcp()
      } else if (event.kind === 'approval.request') {
        if (s.approvals.some((a) => a.id === event.request.id)) return
        set({ approvals: [...s.approvals, event.request] })
      } else if (event.kind === 'approval.resolved') {
        set({ approvals: s.approvals.filter((a) => a.id !== event.requestId) })
      } else if (event.kind === 'ask.request') {
        if (s.asks.some((a) => a.id === event.request.id)) return
        set({ asks: [...s.asks, event.request] })
      } else if (event.kind === 'ask.resolved') {
        set({ asks: s.asks.filter((a) => a.id !== event.requestId) })
      }
    })
  }

  return {
    ready: false,
    threads: [],
    groups: [],
    activeThreadId: null,
    messages: [],
    events: [],
    models: [],
    recentModelIds: readRecents(),
    modelUsage: readUsage(),
    mcpServers: [],
    settings: null,
    budget: null,
    approvals: [],
    asks: [],
    completedThreads: new Set<string>(),
    ui: {
      // Closed by default — it opens itself when there's something worth inspecting
      // (a subagent spawns, or the user clicks a diff).
      inspectorOpen: false,
      inspectorTab: 'context',
      modelPickerOpen: false,
      settingsOpen: false,
      railCollapsed: false
    },

    async init() {
      const [threads, settings, groups] = await Promise.all([
        window.lattice.listThreads(undefined, true),
        window.lattice.getSettings(),
        window.lattice.listThreadGroups().catch(() => [])
      ])
      set({ threads: sortThreads(threads), settings, groups, ready: true })
      window.lattice
        .pendingApprovals()
        .then((approvals) => set({ approvals }))
        .catch(() => {})
      window.lattice
        .pendingAsks()
        .then((asks) => set({ asks }))
        .catch(() => {})
      window.lattice
        .listModels()
        .then((models) => set({ models }))
        .catch(() => {})
      void get().refreshMcp()
      const first = sortThreads(threads).find((t) => !t.archived)
      if (first) await get().selectThread(first.id)
      else await get().newThread()
    },

    async refreshMcp() {
      const mcpServers = await window.lattice.listMcpServers().catch(() => [])
      set({ mcpServers })
    },

    async respondApproval(decision) {
      // Optimistically clear it so the prompt dismisses immediately.
      set({ approvals: get().approvals.filter((a) => a.id !== decision.requestId) })
      await window.lattice.respondApproval(decision)
    },

    async respondAsk(response) {
      // Optimistically clear it so the question dismisses immediately.
      set({ asks: get().asks.filter((a) => a.id !== response.requestId) })
      await window.lattice.respondAsk(response)
    },

    async selectThread(id) {
      const cleared = get().completedThreads
      const completedThreads = cleared.has(id)
        ? new Set([...cleared].filter((t) => t !== id))
        : cleared
      set({ activeThreadId: id, messages: [], events: [], completedThreads })
      const { meta, messages, events } = await window.lattice.getThread(id)
      // guard against a race with a subsequent select
      if (get().activeThreadId !== id) return
      // Merge with anything pushed while the fetch was in flight (a streaming run flushes every
      // 80ms): pushed versions of a message/event win over the DB snapshot, and pushed items the
      // snapshot doesn't know yet are kept — a plain overwrite visibly rolled streamed text back.
      const live = get()
      const byId = new Map(messages.map((m) => [m.id, m]))
      for (const m of live.messages) byId.set(m.id, m)
      const seenEvents = new Set(events.map((e) => e.id))
      const mergedEvents = [...events, ...live.events.filter((e) => !seenEvents.has(e.id))]
      set({
        messages: [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)),
        events: mergedEvents,
        threads: sortThreads(
          get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t))
        )
      })
      void get().refreshBudget()
    },

    async newThread() {
      // Seed a fresh session with the model you last used, so a new thread picks up where you
      // left off rather than snapping back to the global default. Falls back to the starred
      // default (applied by the main process) when nothing has been selected yet this install.
      const lastModel = get().recentModelIds[0]
      const meta = await window.lattice.createThread(lastModel ? { model: lastModel } : undefined)
      set({ threads: sortThreads([meta, ...get().threads]) })
      await get().selectThread(meta.id)
    },

    async renameThread(id, title) {
      const trimmed = title.trim()
      if (!trimmed) return
      const meta = await window.lattice.updateThread(id, { title: trimmed })
      set({ threads: sortThreads(get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t))) })
    },

    async setThreadPinned(id, pinned) {
      const meta = await window.lattice.updateThread(id, { pinned })
      set({ threads: sortThreads(get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t))) })
    },

    async setThreadArchived(id, archived) {
      const meta = await window.lattice.updateThread(id, { archived })
      const threads = sortThreads(get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t)))
      set({ threads })
      // if we just archived the active thread, move focus to a visible one
      if (archived && get().activeThreadId === id) {
        const next = threads.find((t) => !t.archived && t.id !== id)
        if (next) await get().selectThread(next.id)
        else await get().newThread()
      }
    },

    async deleteThread(id) {
      await window.lattice.deleteThread(id)
      const wasActive = get().activeThreadId === id
      const threads = get().threads.filter((t) => t.id !== id)
      set({ threads })
      if (wasActive) {
        const next = threads.find((t) => !t.archived)
        if (next) await get().selectThread(next.id)
        else await get().newThread()
      }
    },

    async createGroup(name, opts) {
      const group = await window.lattice.createThreadGroup({ name, color: opts?.color })
      // push('groups.updated') will also land, but set eagerly so the UI has it immediately
      set({ groups: mergeGroup(get().groups, group) })
      if (opts?.assign) await get().assignThreadGroup(opts.assign, group.id)
      return group.id
    },

    async renameGroup(id, name) {
      const trimmed = name.trim()
      if (!trimmed) return
      const group = await window.lattice.updateThreadGroup(id, { name: trimmed })
      set({ groups: mergeGroup(get().groups, group) })
    },

    async setGroupColor(id, color) {
      const group = await window.lattice.updateThreadGroup(id, { color })
      set({ groups: mergeGroup(get().groups, group) })
    },

    async deleteGroup(id) {
      await window.lattice.deleteThreadGroup(id)
      // un-file member threads locally so they don't vanish before the thread.updated pushes arrive
      set({
        groups: get().groups.filter((g) => g.id !== id),
        threads: get().threads.map((t) => (t.groupId === id ? { ...t, groupId: undefined } : t))
      })
    },

    async assignThreadGroup(threadId, groupId) {
      // optimistic — the sidebar re-buckets immediately; the thread.updated push confirms
      set({
        threads: sortThreads(
          get().threads.map((t) => (t.id === threadId ? { ...t, groupId: groupId ?? undefined } : t))
        )
      })
      const meta = await window.lattice.setThreadGroup(threadId, groupId).catch(() => null)
      if (meta) set({ threads: sortThreads(get().threads.map((t) => (t.id === threadId ? { ...t, ...meta } : t))) })
    },

    async setGoal(goal) {
      const id = get().activeThreadId
      if (!id) return
      const meta = await window.lattice.updateThread(id, { goal })
      set({ threads: sortThreads(get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t))) })
      void get().refreshBudget()
    },

    async forkThread(opts) {
      const id = get().activeThreadId
      if (!id) return
      const child = await window.lattice.forkThread(id, { titlePrefix: opts?.titlePrefix })
      set({ threads: sortThreads([child, ...get().threads]) })
      await get().selectThread(child.id)
      if (opts?.seed?.trim()) await get().send({ text: opts.seed.trim(), disposition: 'send' })
      get().flash(`Forked a side thread from “${child.title}”`)
    },

    async compactThread() {
      const id = get().activeThreadId
      if (!id) return 'No active thread.'
      const res = await window.lattice.compactThread(id)
      if (!res.ok) {
        get().flash(res.reason ?? 'Nothing to compact.', 'warn')
        return res.reason ?? 'Nothing to compact.'
      }
      // reload the thread so the dimmed originals + summary render
      await get().selectThread(id)
      void get().refreshBudget()
      const saved = (res.beforeTokens ?? 0) - (res.afterTokens ?? 0)
      const note = `Compacted history — ~${saved.toLocaleString()} tokens freed`
      get().flash(note)
      return note
    },

    async clearThread() {
      const id = get().activeThreadId
      if (!id) return
      await window.lattice.clearThread(id)
      set({ messages: [], events: [] })
      void get().refreshBudget()
      get().flash('Cleared the conversation')
    },

    async send(opts) {
      const threadId = get().activeThreadId
      if (!threadId) return
      await window.lattice.send({ ...opts, threadId })
    },

    async dequeueMessage(id) {
      const threadId = get().activeThreadId
      if (!threadId) return
      // optimistic: drop it immediately; the main process confirms with a message.deleted push
      set({ messages: get().messages.filter((m) => m.id !== id) })
      const removed = await window.lattice.dequeueMessage(threadId, id).catch(() => false)
      if (!removed) {
        // it already left the queue (its run started) — reload so the transcript is accurate
        await get().selectThread(threadId)
        get().flash('That message already started running.', 'warn')
      }
    },

    async editQueuedMessage(id, text) {
      const threadId = get().activeThreadId
      if (!threadId) return
      const trimmed = text.trim()
      if (!trimmed) return
      const updated = await window.lattice.editQueuedMessage(threadId, id, trimmed).catch(() => null)
      if (updated) set({ messages: get().messages.map((m) => (m.id === id ? updated : m)) })
      else {
        await get().selectThread(threadId)
        get().flash('That message already started running.', 'warn')
      }
    },

    async cancel() {
      const s = get()
      const runId = [...s.events].reverse().find((e) => e.body.type === 'run.started')?.runId
      if (runId) await window.lattice.cancelRun(runId)
    },

    async setModel(model) {
      const recents = [model, ...get().recentModelIds.filter((m) => m !== model)].slice(0, RECENTS_MAX)
      writeRecents(recents)
      const usage = { ...get().modelUsage, [model]: (get().modelUsage[model] ?? 0) + 1 }
      writeUsage(usage)
      set({ recentModelIds: recents, modelUsage: usage })
      const id = get().activeThreadId
      if (!id) return
      const meta = await window.lattice.updateThread(id, { model })
      set({ threads: sortThreads(get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t))) })
      void get().refreshBudget()
    },

    async setDefaultModel(model) {
      await get().saveSettings({ defaultModel: model })
    },

    async setEffort(effort) {
      const id = get().activeThreadId
      if (!id) return
      const meta = await window.lattice.updateThread(id, { effort })
      set({ threads: sortThreads(get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t))) })
    },

    async setMode(mode) {
      const id = get().activeThreadId
      if (!id) return
      const meta = await window.lattice.updateThread(id, { mode })
      set({ threads: sortThreads(get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t))) })
    },

    async setPreset(permissionPreset) {
      const id = get().activeThreadId
      if (!id) return
      const meta = await window.lattice.updateThread(id, { permissionPreset })
      set({ threads: get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t)) })
    },

    async saveSettings(patch) {
      const settings = await window.lattice.setSettings(patch)
      set({ settings })
      if (patch.providers) {
        window.lattice
          .listModels(true)
          .then((models) => set({ models }))
          .catch(() => {})
      }
    },

    async refreshBudget() {
      const id = get().activeThreadId
      if (!id) return
      const budget = await window.lattice.getContextBudget(id).catch(() => null)
      if (get().activeThreadId === id) set({ budget })
    },

    setUi(patch) {
      set({ ui: { ...get().ui, ...patch } })
    },

    notice: null,
    flash(text, tone = 'info') {
      set({ notice: { text, tone } })
      const token = text
      setTimeout(() => {
        if (get().notice?.text === token) set({ notice: null })
      }, 3600)
    }
  }
})

/** Upsert one group into the list and keep it ordered by sortOrder (then creation). */
function mergeGroup(groups: ThreadGroup[], group: ThreadGroup): ThreadGroup[] {
  const next = groups.some((g) => g.id === group.id)
    ? groups.map((g) => (g.id === group.id ? group : g))
    : [...groups, group]
  return [...next].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
}

function sortThreads(threads: ThreadMeta[]): ThreadMeta[] {
  return [...threads].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

export function activeThread(s: { threads: ThreadMeta[]; activeThreadId: string | null }): ThreadMeta | null {
  return s.threads.find((t) => t.id === s.activeThreadId) ?? null
}
