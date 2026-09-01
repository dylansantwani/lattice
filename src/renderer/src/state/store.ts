import { create } from 'zustand'
import type {
  AppSettings,
  ChatMessage,
  ContextBudget,
  ModelInfo,
  RunEvent,
  SendOptions,
  ThreadMeta
} from '@shared/types'
import type { PushEvent } from '@shared/ipc'

interface UiState {
  inspectorOpen: boolean
  inspectorTab: 'context' | 'run' | 'tasks' | 'memory' | 'agents'
  modelPickerOpen: boolean
  settingsOpen: boolean
  railCollapsed: boolean
}

interface LatticeState {
  ready: boolean
  threads: ThreadMeta[]
  activeThreadId: string | null
  messages: ChatMessage[]
  events: RunEvent[]
  models: ModelInfo[]
  settings: AppSettings | null
  budget: ContextBudget | null
  ui: UiState

  init(): Promise<void>
  selectThread(id: string): Promise<void>
  newThread(): Promise<void>
  send(opts: Omit<SendOptions, 'threadId'>): Promise<void>
  cancel(): Promise<void>
  setModel(model: string): Promise<void>
  setEffort(effort: string): Promise<void>
  setMode(mode: ThreadMeta['mode']): Promise<void>
  setPreset(preset: ThreadMeta['permissionPreset']): Promise<void>
  saveSettings(patch: Partial<AppSettings>): Promise<void>
  refreshBudget(): Promise<void>
  setUi(patch: Partial<UiState>): void
}

export const useStore = create<LatticeState>((set, get) => {
  // ---- push subscription (module-level, once) ----
  if (typeof window !== 'undefined' && window.lattice) {
    window.lattice.onPush((event: PushEvent) => {
      const s = get()
      if (event.kind === 'thread.updated') {
        set({
          threads: sortThreads(
            s.threads.some((t) => t.id === event.meta.id)
              ? s.threads.map((t) => (t.id === event.meta.id ? { ...t, ...event.meta } : t))
              : [event.meta, ...s.threads]
          )
        })
      } else if (event.kind === 'message.updated') {
        if (event.message.threadId !== s.activeThreadId) return
        const exists = s.messages.some((m) => m.id === event.message.id)
        set({
          messages: exists
            ? s.messages.map((m) => (m.id === event.message.id ? event.message : m))
            : [...s.messages, event.message]
        })
      } else if (event.kind === 'run.event') {
        if (event.event.threadId !== s.activeThreadId) return
        set({ events: [...s.events, event.event] })
        if (event.event.body.type === 'run.completed') void get().refreshBudget()
      }
    })
  }

  return {
    ready: false,
    threads: [],
    activeThreadId: null,
    messages: [],
    events: [],
    models: [],
    settings: null,
    budget: null,
    ui: {
      inspectorOpen: true,
      inspectorTab: 'context',
      modelPickerOpen: false,
      settingsOpen: false,
      railCollapsed: false
    },

    async init() {
      const [threads, settings] = await Promise.all([
        window.lattice.listThreads(),
        window.lattice.getSettings()
      ])
      set({ threads: sortThreads(threads), settings, ready: true })
      window.lattice
        .listModels()
        .then((models) => set({ models }))
        .catch(() => {})
      if (threads.length > 0) await get().selectThread(threads[0]!.id)
      else await get().newThread()
    },

    async selectThread(id) {
      set({ activeThreadId: id, messages: [], events: [] })
      const { meta, messages, events } = await window.lattice.getThread(id)
      // guard against a race with a subsequent select
      if (get().activeThreadId !== id) return
      set({
        messages,
        events,
        threads: sortThreads(
          get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t))
        )
      })
      void get().refreshBudget()
    },

    async newThread() {
      const meta = await window.lattice.createThread()
      set({ threads: sortThreads([meta, ...get().threads]) })
      await get().selectThread(meta.id)
    },

    async send(opts) {
      const threadId = get().activeThreadId
      if (!threadId) return
      await window.lattice.send({ ...opts, threadId })
    },

    async cancel() {
      const s = get()
      const runId = [...s.events].reverse().find((e) => e.body.type === 'run.started')?.runId
      if (runId) await window.lattice.cancelRun(runId)
    },

    async setModel(model) {
      const id = get().activeThreadId
      if (!id) return
      const meta = await window.lattice.updateThread(id, { model })
      set({ threads: sortThreads(get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t))) })
      void get().refreshBudget()
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
    }
  }
})

function sortThreads(threads: ThreadMeta[]): ThreadMeta[] {
  return [...threads].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

export function activeThread(s: { threads: ThreadMeta[]; activeThreadId: string | null }): ThreadMeta | null {
  return s.threads.find((t) => t.id === s.activeThreadId) ?? null
}
