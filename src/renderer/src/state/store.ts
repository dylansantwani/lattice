import { create } from 'zustand'
import type {
  Attachment,
  RetryMode,
  ModelHealth,
  ToolInventoryEntry,
  BgJobView,
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
  ThreadMeta,
  Todo,
  TodoPatch
} from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { shouldWarnModelSwitch, type PendingModelSwitch } from './modelSwitch'
import { foldModelStats, type ModelStats } from '../components/modelStats'
import { shouldDiscardNewThread } from '../threadNavigation'

export type ModelPickerIntent = 'thread' | 'default' | 'subagent' | 'telegram'
export type SettingsTab = 'general' | 'model' | 'channels' | 'conversation' | 'appearance' | 'voice' | 'providers' | 'pricing' | 'mcp' | 'remote'

interface UiState {
  inspectorOpen: boolean
  inspectorTab: 'context' | 'run' | 'tasks' | 'memory' | 'agents' | 'tools' | 'mcp' | 'files' | 'terminal' | 'browser'
  modelPickerOpen: boolean
  /**
   * What choosing a model in the browser does: switch the active thread (the default), set the
   * default for new threads (Settings → Default model), add a subagent model (Settings →
   * Subagent models), or choose the Telegram assistant model. Reset to `thread` when the browser
   * closes.
   */
  modelPickerIntent: ModelPickerIntent
  /** a model id to highlight when the browser opens (deep link from Settings), consumed on open */
  modelPickerFocus: string | null
  settingsOpen: boolean
  /** the Settings tab to open on, when a caller wants a specific one (consumed on open) */
  settingsTab: SettingsTab | null
  usageOpen: boolean
  /** route id whose cost override is being edited (opens the CostEditor modal); null when closed */
  costEditorModel: string | null
  railCollapsed: boolean
}

/**
 * A `/btw` quick aside: an ephemeral side-chat, docked to the right, that carries the parent
 * thread's context (the fork copies its history so the model sees it) but shows only the new
 * back-and-forth. It is a real thread under the hood so runs/tools work, but is kept OUT of the
 * sidebar and hard-deleted on close — a by-the-way question, then gone.
 */
export interface AsideChat {
  threadId: string
  parentThreadId: string
  parentTitle: string
  /** only the new aside turns — the copied parent context is not shown here */
  messages: ChatMessage[]
  running: boolean
  /** run id of the aside's active run, for cancel-on-close */
  runId?: string
}

interface LatticeState {
  ready: boolean
  /**
   * Set when startup fails so the shell can show a legible diagnostic instead of hanging on the
   * "Loading…" screen forever. The most common cause is a missing preload bridge (`window.lattice`
   * undefined) — e.g. an interrupted or stale `out/preload` build — which otherwise white-screens
   * with only an uncaught "Cannot read properties of undefined" in the console.
   */
  bootError: string | null
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
  /** last health ping per model id — which routes are actually live (the model picker's status dots) */
  modelHealth: Record<string, ModelHealth>
  /** model ids with a health ping in flight right now */
  modelHealthChecking: string[]
  /**
   * Ping models to see which are live. Results stream back as `model.health` pushes, so the picker
   * fills in progressively; `refresh` bypasses the main process's short-lived cache.
   */
  checkModelHealth(modelIds: string[], refresh?: boolean): Promise<void>
  /**
   * What you have done with each model (turns, spend, tok/s, TTFT, last used), keyed by base stem —
   * the model browser's usage facts. null until loaded; refreshed each time the browser opens.
   */
  modelStats: Map<string, ModelStats> | null
  loadModelStats(): Promise<void>
  mcpServers: { config: McpServerConfig; status: McpServerStatus }[]
  settings: AppSettings | null
  budget: ContextBudget | null
  /** bumped whenever the active thread's files change, so the Files inspector can refetch its diff */
  filesChangedAt: number
  /** the active thread's background shell jobs (live while running; refetched on `jobs.updated`) */
  jobs: BgJobView[]
  /** the active thread's tool inventory (Tools inspector); refetched on thread/mode/preset/MCP change */
  tools: ToolInventoryEntry[]
  loadTools(): Promise<void>
  /** the active thread's checklist (Tasks panel) — the agent's todo_write list, editable by hand */
  todos: Todo[]
  loadTodos(): Promise<void>
  /** Add a task by hand (optionally as a subtask); it lands at the end of the list. */
  addTodo(title: string, parentId?: string): Promise<void>
  updateTodo(id: string, patch: TodoPatch): Promise<void>
  /** Delete a task and its subtasks. */
  deleteTodo(id: string): Promise<void>
  /** Remove finished items, or the whole checklist. */
  clearTodos(mode: 'done' | 'all'): Promise<void>
  /** Persist a drag-reorder: ids top-to-bottom. */
  reorderTodos(orderedIds: string[]): Promise<void>
  /** a mid-chat model change parked for confirmation (context re-insertion warning); null when none */
  pendingModelSwitch: PendingModelSwitch | null
  /** tool calls awaiting the user's approval, across all threads */
  approvals: ApprovalRequest[]
  /** questions the model has put to the user (ask_user), across all threads */
  asks: AskRequest[]
  /** total unread inter-session messages waiting across all sessions (Slice 9 inbox badge) */
  sessionUnread: number
  /** ids of threads whose run finished while the user wasn't viewing them (green dot) */
  completedThreads: Set<string>
  /** the open `/btw` quick aside, or null when none is docked */
  aside: AsideChat | null
  ui: UiState

  init(): Promise<void>
  respondApproval(decision: ApprovalDecision): Promise<void>
  respondAsk(response: AskResponse): Promise<void>
  refreshMcp(): Promise<void>
  /** Recompute the total unread inter-session message count (the inbox badge). */
  refreshSessionUnread(): Promise<void>
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
  /** Open a `/btw` quick aside docked to the right, carrying this thread's context; optional seed. */
  openAside(seed?: string): Promise<void>
  /** Send a message inside the open aside. */
  sendAside(text: string): Promise<void>
  /** Cancel the aside's active run, if any. */
  cancelAside(): Promise<void>
  /** Close and discard the aside (hard-deletes the ephemeral fork thread). */
  closeAside(): Promise<void>
  /** Compact the active thread's history into a summary. Returns a human-readable result note. */
  compactThread(): Promise<string>
  /** Clear the active thread's messages, keeping the thread and its settings. */
  clearThread(): Promise<void>
  send(opts: Omit<SendOptions, 'threadId'>): Promise<void>
  /** Remove a still-queued turn from the active thread. */
  dequeueMessage(id: string): Promise<void>
  /** Edit the text of a still-queued turn on the active thread. */
  editQueuedMessage(id: string, text: string): Promise<void>
  /** Fold a still-queued turn into the response in progress now, as a steer, instead of waiting. */
  steerQueuedMessage(id: string): Promise<void>
  cancel(): Promise<void>
  /** Stop a single running subagent by its agentId, without canceling the rest of the run. */
  cancelAgent(agentId: string): Promise<void>
  /** Refetch the active thread's background jobs (Agents inspector). */
  loadJobs(): Promise<void>
  /** SIGTERM a running background job of the active thread. */
  stopJob(jobId: string): Promise<void>
  /** Re-run the turn behind an interrupted/errored assistant reply (the transcript's Retry button). */
  /**
   * Recover an interrupted/failed reply. Default `auto` RESUMES it from where it stopped when there
   * is anything to continue; `restart` discards it and re-runs the user's turn.
   */
  retryTurn(messageId: string, mode?: RetryMode): Promise<void>
  /** Stop every running subagent and background job on the active thread (the composer's control when only background work runs). */
  stopBackgroundWork(agentIds: string[], jobIds: string[]): Promise<void>
  /** Stop everything on a thread — live run, subagents, jobs (the sidebar's Stop on any running thread). */
  stopThreadWork(threadId: string): Promise<void>
  /**
   * Switch the active thread's model, optionally together with a reasoning tier (the browser's
   * effort row). A real mid-chat switch is parked for confirmation first (see ModelSwitchWarning).
   */
  setModel(model: string, effort?: string): Promise<void>
  /** Apply a model change parked by {@link setModel} once the user confirms the context warning. */
  confirmModelSwitch(): Promise<void>
  /** Discard a parked model change without switching. */
  cancelModelSwitch(): void
  setEffort(effort: string): Promise<void>
  setMode(mode: ThreadMeta['mode']): Promise<void>
  setPreset(preset: ThreadMeta['permissionPreset']): Promise<void>
  setDefaultModel(model: string): Promise<void>
  /** Mark or unmark a model as one the main model may run subagents on (Settings.subagentModels). */
  toggleSubagentModel(model: string): Promise<void>
  /** Star or unstar a model as a favorite (Settings.favoriteModels); favorites lead the picker. */
  toggleFavoriteModel(model: string): Promise<void>
  /** Per-model default reasoning tier (`settings.defaultEffortByModel`); null removes the entry. */
  setModelEffortDefault(model: string, tier: string | null): Promise<void>
  /** Per-model context-window correction (`settings.modelContextOverrides`); null removes it. Re-lists models, since the registry applies it at fetch time. */
  setModelContextOverride(model: string, tokens: number | null): Promise<void>
  /** Per-model source-group override (`settings.modelSourceOverrides`); null removes it. Re-lists models. */
  setModelSourceOverride(model: string, sourceKey: string | null): Promise<void>
  /** Open the model browser for a purpose, optionally highlighting a model. */
  openModelPicker(opts?: { intent?: ModelPickerIntent; focus?: string }): void
  saveSettings(patch: Partial<AppSettings>): Promise<void>
  /** Force a fresh model listing from all providers and replace the picker's list. */
  reloadModels(): Promise<void>
  refreshBudget(): Promise<void>
  setUi(patch: Partial<UiState>): void
  /** transient command feedback shown as a toast; auto-clears. `threadId` makes it clickable (jump). */
  notice: { text: string; tone: 'info' | 'warn' | 'error'; threadId?: string } | null
  flash(text: string, tone?: 'info' | 'warn' | 'error', threadId?: string): void
  /** threads whose last run (or a job/subagent on it) failed while the user was elsewhere — red sidebar dot */
  failedThreads: Set<string>
  /** unsent composer text per thread, so switching chats (or relaunching) never loses a draft */
  drafts: Record<string, string>
  setDraft(threadId: string, text: string): void
  /**
   * Images staged in the composer, per thread. In memory only — a data URL for a screenshot runs to
   * megabytes, which would blow the localStorage quota that carries the text drafts — so they
   * survive switching chats but not a relaunch.
   */
  draftAttachments: Record<string, Attachment[]>
  setDraftAttachments(threadId: string, attachments: Attachment[]): void
}

const DRAFTS_KEY = 'lattice.drafts'
const DRAFT_MAX_CHARS = 20_000
function readDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string' && v) out[k] = v
    return out
  } catch {
    return {}
  }
}
function writeDrafts(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
  } catch {
    /* storage full or unavailable: drafts stay in memory for this session */
  }
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
  // Lookup index over the visible thread's events (ids + agent ids), kept in step with the array
  // identity: appending an event updates it in place, and any other replacement of `events`
  // (thread switch, clear, compaction) rebuilds it once on the next push.
  let eventIndex: { arr: RunEvent[]; ids: Set<string>; agents: Set<string> } | null = null
  const indexEvents = (arr: RunEvent[]): NonNullable<typeof eventIndex> => {
    if (eventIndex && eventIndex.arr === arr) return eventIndex
    const ids = new Set<string>()
    const agents = new Set<string>()
    for (const e of arr) {
      ids.add(e.id)
      if (e.agent) agents.add(e.agent)
    }
    eventIndex = { arr, ids, agents }
    return eventIndex
  }
  // Highest checklist size we've seen per thread. We pop the inspector open whenever the count
  // grows (a genuinely new task was created) but not on mere status flips — so a status change
  // never yanks a panel the user deliberately closed back open.
  const tasksSeenCount = new Map<string, number>()
  // A leave can race with another click. Share one cleanup request per thread so two navigation
  // events cannot issue duplicate deletes while the first one is checking the persisted state.
  const abandoningThreads = new Map<string, Promise<void>>()
  // Track threads created in this renderer session as new even if the user renames them before
  // sending. The title fallback below also recognizes new threads restored after a reload.
  const newlyCreatedThreads = new Set<string>()
  // Keep navigation cleanup behind an in-flight send. Otherwise a click can arrive after the
  // composer dispatched the first message but before the main process persisted it.
  const pendingSends = new Map<string, Promise<unknown>>()

  const discardAbandonedThread = (
    id: string,
    fallbackMeta: ThreadMeta,
    fallbackMessages: ChatMessage[],
    fallbackEvents: RunEvent[]
  ): Promise<void> => {
    const pending = abandoningThreads.get(id)
    if (pending) return pending

    const task = (async (): Promise<void> => {
      // A fresh thread with no local content is the common path. Error events/statuses are also
      // checked here so a failed first turn does not leave a permanent "New thread" entry.
      if (
        !shouldDiscardNewThread(
          fallbackMeta,
          fallbackMessages,
          fallbackEvents,
          newlyCreatedThreads.has(id) || fallbackMeta.title === 'New thread'
        )
      )
        return

      const pendingSend = pendingSends.get(id)
      if (pendingSend) await pendingSend.catch(() => {})

      // Re-read before deleting. The renderer can be between selectThread() calls while the first
      // message is still being persisted/streamed, and the push stream may not have caught up yet.
      const snapshot = await window.lattice.getThread(id).catch(() => null)
      if (!snapshot) return
      const state = get()
      // The user may have navigated back while the persisted-state read was in flight. In that
      // case the thread is no longer being left, so never delete it from under the active view.
      if (state.activeThreadId === id || pendingSends.has(id)) return
      const currentMeta = state.threads.find((thread) => thread.id === id)
      if (!currentMeta) return

      const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]))
      for (const message of fallbackMessages) messagesById.set(message.id, message)
      const eventsById = new Map(snapshot.events.map((event) => [event.id, event]))
      for (const event of fallbackEvents) eventsById.set(event.id, event)
      const latestMeta =
        currentMeta.updatedAt >= snapshot.meta.updatedAt
          ? { ...snapshot.meta, ...currentMeta, running: !!(currentMeta.running || snapshot.meta.running) }
          : { ...currentMeta, ...snapshot.meta, running: !!(currentMeta.running || snapshot.meta.running) }
      if (
        !shouldDiscardNewThread(
          latestMeta,
          [...messagesById.values()],
          [...eventsById.values()],
          newlyCreatedThreads.has(id) || latestMeta.title === 'New thread'
        )
      )
        return

      try {
        await window.lattice.deleteThread(id)
      } catch {
        // Cleanup is best-effort; navigation should never strand the user on the old thread.
        return
      }
      newlyCreatedThreads.delete(id)
      const current = get()
      const threads = current.threads.filter((thread) => thread.id !== id)
      const completedThreads = current.completedThreads.has(id)
        ? new Set([...current.completedThreads].filter((threadId) => threadId !== id))
        : current.completedThreads
      set({ threads, completedThreads })
    })()
    abandoningThreads.set(id, task)
    void task.then(
      () => {
        if (abandoningThreads.get(id) === task) abandoningThreads.delete(id)
      },
      () => {
        if (abandoningThreads.get(id) === task) abandoningThreads.delete(id)
      }
    )
    return task
  }

  // ---- push subscription (module-level, once) ----
  if (typeof window !== 'undefined' && window.lattice) {
    window.lattice.onPush((event: PushEvent) => {
      const s = get()
      if (event.kind === 'thread.updated') {
        // The aside is a real thread but must never enter the sidebar list; route its running
        // state into the aside slice and stop before the threads/completed bookkeeping below.
        if (s.aside && event.meta.id === s.aside.threadId) {
          set({ aside: { ...s.aside, running: !!event.meta.running } })
          return
        }
        const prev = s.threads.find((t) => t.id === event.meta.id)
        let completed = s.completedThreads
        if (event.meta.running) {
          // a run started/continues — clear any stale completion (or failure) marker
          if (completed.has(event.meta.id)) {
            completed = new Set(completed)
            completed.delete(event.meta.id)
          }
          if (s.failedThreads.has(event.meta.id)) {
            set({ failedThreads: new Set([...s.failedThreads].filter((t) => t !== event.meta.id)) })
          }
        } else if (prev?.running && event.meta.id !== s.activeThreadId) {
          // a run just finished on a thread the user isn't viewing — flag it
          completed = new Set(completed)
          completed.add(event.meta.id)
        }
        // A run's lifecycle bumps the thread's `updatedAt` in the DB (start, finish, streamed
        // turns), which would float a *background* chat to the top of the recency-sorted sidebar and
        // bury the chat you're actually in — e.g. a chat you left running leaping above a new chat
        // you just made. The sidebar should reflect when *you* last engaged a thread, so keep a
        // background thread's existing sort timestamp; only the thread you're viewing (or a brand-new
        // one not yet in the list) adopts the pushed `updatedAt`. Its running/done state still
        // updates — it just doesn't jump position.
        const isActive = event.meta.id === s.activeThreadId
        set({
          completedThreads: completed,
          threads: sortThreads(
            s.threads.some((t) => t.id === event.meta.id)
              ? s.threads.map((t) =>
                  t.id === event.meta.id
                    ? { ...t, ...event.meta, updatedAt: isActive ? event.meta.updatedAt : t.updatedAt }
                    : t
                )
              : [event.meta, ...s.threads]
          )
        })
        // A first run can fail after the user has already left the chat. In that case there is no
        // later selectThread() to trigger cleanup; the idle update is the equivalent leave-time
        // signal, and the helper rechecks the persisted first turn before deleting.
        // Only threads THIS window created are eligible here. The bridge is shared with remote
        // clients (the iOS app), whose freshly-sent threads are also titled 'New thread' until the
        // first turn completes — reaping those on a push would delete another device's thread out
        // from under it the moment its first turn fails.
        if (
          !event.meta.running &&
          event.meta.id !== get().activeThreadId &&
          newlyCreatedThreads.has(event.meta.id)
        ) {
          const updated = get().threads.find((thread) => thread.id === event.meta.id)
          if (updated) void discardAbandonedThread(updated.id, updated, [], [])
        }
      } else if (event.kind === 'groups.updated') {
        set({ groups: event.groups })
      } else if (event.kind === 'thread.deleted') {
        newlyCreatedThreads.delete(event.id)
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
        if (s.aside && event.message.threadId === s.aside.threadId) {
          const a = s.aside
          const has = a.messages.some((m) => m.id === event.message.id)
          set({
            aside: {
              ...a,
              messages: has
                ? a.messages.map((m) => (m.id === event.message.id ? event.message : m))
                : [...a.messages, event.message]
            }
          })
          return
        }
        if (event.message.threadId !== s.activeThreadId) return
        const exists = s.messages.some((m) => m.id === event.message.id)
        set({
          messages: exists
            ? s.messages.map((m) => (m.id === event.message.id ? event.message : m))
            : [...s.messages, event.message]
        })
      } else if (event.kind === 'message.deleted') {
        if (s.aside && event.threadId === s.aside.threadId) {
          set({ aside: { ...s.aside, messages: s.aside.messages.filter((m) => m.id !== event.messageId) } })
          return
        }
        if (event.threadId !== s.activeThreadId) return
        // A retried turn drops its failed reply AND that run's events, so the dead timeline does not
        // linger under the fresh run (the main process purged them from the store already).
        const gone = s.messages.find((m) => m.id === event.messageId)
        const runId = gone?.role === 'assistant' ? gone.runId : undefined
        set({
          messages: s.messages.filter((m) => m.id !== event.messageId),
          events: runId ? s.events.filter((e) => e.runId !== runId) : s.events
        })
      } else if (event.kind === 'run.event') {
        if (s.aside && event.event.threadId === s.aside.threadId) {
          const evt = event.event
          if (evt.body.type === 'run.started') set({ aside: { ...s.aside, runId: evt.runId, running: true } })
          else if (evt.body.type === 'run.completed') set({ aside: { ...s.aside, running: false } })
          return
        }
        if (event.event.threadId !== s.activeThreadId) {
          // Error events for a thread the user already left are otherwise intentionally ignored by
          // the visible transcript. They still matter for removing an abandoned new thread — but only
          // the parent turn's own errors do. A subagent error (carries an `agent` tag, yet reuses the
          // parent run's id) must never trigger discard, or a healthy thread whose background/foreground
          // agent failed gets deleted out from under the user.
          // As above: only this window's own new threads. A remote client's (iOS) first-turn error
          // must leave its thread — and the error the user needs to read — in place.
          if (
            event.event.body.type === 'error' &&
            !event.event.agent &&
            newlyCreatedThreads.has(event.event.threadId)
          ) {
            const thread = s.threads.find((candidate) => candidate.id === event.event.threadId)
            if (thread) void discardAbandonedThread(thread.id, thread, [], [event.event])
          }
          return
        }
        const evt = event.event
        // Redelivered events (retry/reconnect) must not double-count: a duplicated `usage`
        // event would inflate every aggregate that sums the events array (cache badge, panels).
        // The id/agent index makes both checks O(1); scanning the array per event made a long
        // run quadratic in its event count.
        const idx = indexEvents(s.events)
        if (idx.ids.has(evt.id)) return
        // First event carrying a not-yet-seen agent id = a subagent just spawned. Pop the
        // inspector open on its Agents tab so the user sees the fan-out as it happens.
        const spawnedSubagent = !!evt.agent && !idx.agents.has(evt.agent)
        const nextEvents = [...s.events, evt]
        idx.ids.add(evt.id)
        if (evt.agent) idx.agents.add(evt.agent)
        idx.arr = nextEvents
        set({
          events: nextEvents,
          ...(spawnedSubagent
            ? { ui: { ...s.ui, inspectorOpen: true, inspectorTab: 'agents' as const } }
            : {})
        })
        if (evt.body.type === 'run.completed') void get().refreshBudget()
      } else if (event.kind === 'budget.updated') {
        // Live budget snapshot from an in-flight run — drop it in directly (no IPC round-trip) so the
        // Context Orbit and Context inspector fill in as the turn streams. Only for the visible thread;
        // run.completed still does an authoritative pull from persisted state.
        if (event.threadId === s.activeThreadId) set({ budget: event.budget })
      } else if (event.kind === 'todos.updated') {
        // A checklist changed. The push carries the fresh list, so the visible thread updates with
        // no round-trip; an older push without it falls back to a refetch. If a new item was created
        // (the count grew past anything we've seen for this thread), pop the inspector open on the
        // Tasks tab so the plan animates into view — but only for agent writes: the user's own edits
        // happen IN that panel and must never yank it around.
        if (event.threadId === s.activeThreadId) {
          if (event.todos) set({ todos: event.todos })
          else void get().loadTodos()
        }
        if (event.threadId && event.todos) {
          const count = event.todos.length
          const grew = count > (tasksSeenCount.get(event.threadId) ?? 0)
          tasksSeenCount.set(event.threadId, Math.max(count, tasksSeenCount.get(event.threadId) ?? 0))
          const byAgent = event.todos.some((t) => t.source !== 'user')
          if (grew && byAgent && event.threadId === s.activeThreadId && !get().ui.inspectorOpen) {
            set({ ui: { ...get().ui, inspectorOpen: true, inspectorTab: 'tasks' } })
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
      } else if (event.kind === 'session.message') {
        // A message arrived (or was read) somewhere. Recompute the unread badge; and if it landed on
        // a thread the user isn't viewing, flag that thread the same way a finished run does.
        void get().refreshSessionUnread()
        // Messages are delivered (and marked read) on arrival now, so "new" means recently created —
        // a drain re-push of an old row must not re-flag the thread.
        const m = event.message
        if (m.toThreadId !== s.activeThreadId && Date.now() - m.createdAt < 10_000) {
          const completed = new Set(s.completedThreads)
          completed.add(m.toThreadId)
          set({ completedThreads: completed })
          s.flash(`New message from ${m.fromTitle}`)
        }
      } else if (event.kind === 'model.health') {
        // A ping landed. Record it and clear that model from the in-flight set, so its row stops
        // spinning the moment its own result arrives rather than when the whole batch finishes.
        set({
          modelHealth: { ...get().modelHealth, [event.health.modelId]: event.health },
          modelHealthChecking: get().modelHealthChecking.filter((id) => id !== event.health.modelId)
        })
      } else if (event.kind === 'notice') {
        // Empty text = a system-notification click asking us to jump to the thread.
        if (!event.text) {
          if (event.threadId && event.threadId !== s.activeThreadId) void get().selectThread(event.threadId)
          return
        }
        s.flash(event.text, event.tone, event.threadId)
        if (event.tone === 'error' && event.threadId && event.threadId !== s.activeThreadId) {
          const failed = new Set(s.failedThreads)
          failed.add(event.threadId)
          set({ failedThreads: failed })
        }
      } else if (event.kind === 'jobs.updated') {
        if (event.threadId === s.activeThreadId) void get().loadJobs()
      } else if (event.kind === 'files.changed') {
        // The agent touched a file on this thread — nudge the Files inspector to refetch its diff.
        if (event.threadId === s.activeThreadId) set({ filesChangedAt: Date.now() })
      } else if (event.kind === 'zoom.changed') {
        // Native window chrome (the traffic lights) is fixed in physical pixels and doesn't
        // scale with page zoom; CSS that has to line up with it reads --zoom to compensate
        // (see .pane-header padding in global.css).
        document.documentElement.style.setProperty('--zoom', String(event.factor))
      }
    })
  }

  // Actually switch the active thread to `model`: record it as most-recent/used and persist it.
  // Shared by the immediate path (empty/same-model) and the confirmed mid-chat path.
  const applyModel = async (model: string, effort?: string): Promise<void> => {
    const recents = [model, ...get().recentModelIds.filter((m) => m !== model)].slice(0, RECENTS_MAX)
    writeRecents(recents)
    const usage = { ...get().modelUsage, [model]: (get().modelUsage[model] ?? 0) + 1 }
    writeUsage(usage)
    set({ recentModelIds: recents, modelUsage: usage })
    const id = get().activeThreadId
    if (!id) return
    const meta = await window.lattice.updateThread(id, effort ? { model, effort } : { model })
    set({ threads: sortThreads(get().threads.map((t) => (t.id === id ? { ...t, ...meta } : t))) })
    void get().refreshBudget()
  }

  return {
    ready: false,
    bootError: null,
    threads: [],
    groups: [],
    activeThreadId: null,
    jobs: [],
    tools: [],
    todos: [],
    messages: [],
    events: [],
    models: [],
    recentModelIds: readRecents(),
    modelUsage: readUsage(),
    modelHealth: {},
    modelHealthChecking: [],
    modelStats: null,
    mcpServers: [],
    settings: null,
    budget: null,
    filesChangedAt: 0,
    pendingModelSwitch: null,
    approvals: [],
    asks: [],
    sessionUnread: 0,
    completedThreads: new Set<string>(),
    aside: null,
    ui: {
      // Closed by default — it opens itself when there's something worth inspecting
      // (a subagent spawns, or the user clicks a diff).
      inspectorOpen: false,
      inspectorTab: 'context',
      modelPickerOpen: false,
      modelPickerIntent: 'thread',
      modelPickerFocus: null,
      settingsOpen: false,
      settingsTab: null,
      usageOpen: false,
      costEditorModel: null,
      railCollapsed: false
    },

    async init() {
      // The whole app talks to the main process through the `window.lattice` preload bridge. If the
      // bridge is missing there is nothing to load — fail loudly rather than throwing deep inside the
      // Promise.all below (an uncaught rejection that leaves the shell stuck on "Loading…" forever).
      if (typeof window.lattice?.listThreads !== 'function') {
        set({
          bootError:
            'The preload bridge (window.lattice) did not load, so the app cannot reach the main ' +
            'process. This usually means out/preload/index.cjs is missing or stale — rebuild with ' +
            '`pnpm build` (or restart `pnpm dev`).'
        })
        return
      }
      let threads: ThreadMeta[]
      let settings: AppSettings
      let groups: ThreadGroup[]
      try {
        ;[threads, settings, groups] = await Promise.all([
          window.lattice.listThreads(undefined, true),
          window.lattice.getSettings(),
          window.lattice.listThreadGroups().catch(() => [])
        ])
      } catch (err) {
        set({
          bootError: `Startup failed while loading initial state: ${
            err instanceof Error ? err.message : String(err)
          }`
        })
        return
      }
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
      void get().refreshSessionUnread()
      const first = sortThreads(threads).find((t) => !t.archived)
      if (first) await get().selectThread(first.id)
      else await get().newThread()
    },

    async refreshMcp() {
      const mcpServers = await window.lattice.listMcpServers().catch(() => [])
      set({ mcpServers })
    },

    async refreshSessionUnread() {
      const sessions = await window.lattice.listSessions().catch(() => [])
      set({ sessionUnread: sessions.reduce((n, s) => n + s.unread, 0) })
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
      const previousId = get().activeThreadId
      const previousThread = previousId ? get().threads.find((thread) => thread.id === previousId) : undefined
      const previousMessages = get().messages
      const previousEvents = get().events
      const cleared = get().completedThreads
      const completedThreads = cleared.has(id)
        ? new Set([...cleared].filter((t) => t !== id))
        : cleared
      // Move focus before cleanup so the thread.deleted push for the old thread cannot interpret the
      // cleanup as an external deletion of the still-active chat and start a second navigation.
      const failedThreads = get().failedThreads.has(id)
        ? new Set([...get().failedThreads].filter((t) => t !== id))
        : get().failedThreads
      set({ activeThreadId: id, messages: [], events: [], jobs: [], todos: [], completedThreads, failedThreads, pendingModelSwitch: null })
      void get().loadJobs()
      void get().loadTodos()
      if (previousId && previousId !== id && previousThread) {
        await discardAbandonedThread(previousId, previousThread, previousMessages, previousEvents)
      }
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
        // Sort by createdAt only. A prompt and its reply share a millisecond, and
        // message ids (ulid) are random within a millisecond — an id tie-break would
        // flip the reply above the prompt. Array.sort is stable, so equal-createdAt
        // messages keep their incoming order: the DB snapshot (ordered by rowid =
        // insertion order) first, then any newer messages pushed live.
        messages: [...byId.values()].sort((a, b) => a.createdAt - b.createdAt),
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
      newlyCreatedThreads.add(meta.id)
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

    async openAside(seed) {
      const parentId = get().activeThreadId
      if (!parentId) return
      // Only one aside at a time — discard any current one first (also hard-deletes its thread).
      if (get().aside) await get().closeAside()
      const parent = get().threads.find((t) => t.id === parentId)
      // Reuse the same fork that seeds the child with the parent's history, so the model has the
      // prior context. The child is NOT added to `threads`, so it never shows in the sidebar.
      const child = await window.lattice.forkThread(parentId, { titlePrefix: 'BTW' })
      set({
        aside: {
          threadId: child.id,
          parentThreadId: parentId,
          parentTitle: parent?.title ?? 'this chat',
          messages: [],
          running: false
        }
      })
      if (seed?.trim()) await get().sendAside(seed.trim())
    },

    async sendAside(text) {
      const a = get().aside
      const trimmed = text.trim()
      if (!a || !trimmed) return
      await window.lattice.send({ threadId: a.threadId, text: trimmed, disposition: 'send' })
    },

    async cancelAside() {
      const a = get().aside
      if (a?.runId) await window.lattice.cancelRun(a.runId)
    },

    async closeAside() {
      const a = get().aside
      if (!a) return
      // Drop the UI immediately; then discard the ephemeral thread. deleteThread cancels any
      // in-flight run first (see ipc.ts), so a mid-answer aside closes cleanly.
      set({ aside: null })
      try {
        await window.lattice.deleteThread(a.threadId)
      } catch {
        /* best-effort: the aside is already gone from the UI */
      }
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
      const request = Promise.resolve().then(() => window.lattice.send({ ...opts, threadId }))
      pendingSends.set(threadId, request)
      try {
        await request
      } finally {
        if (pendingSends.get(threadId) === request) pendingSends.delete(threadId)
      }
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

    async steerQueuedMessage(id) {
      const threadId = get().activeThreadId
      if (!threadId) return
      const steered = await window.lattice.steerQueuedMessage(threadId, id).catch(() => false)
      // The main process pushes message.updated (queued flag cleared) + a steer.injected event; the
      // transcript re-renders from those. On failure the run already moved past a steerable boundary.
      if (!steered) {
        await get().selectThread(threadId)
        get().flash('That message can no longer be steered in — it will run as its own turn.', 'warn')
      }
    },

    async cancel() {
      const s = get()
      const runId = [...s.events].reverse().find((e) => e.body.type === 'run.started')?.runId
      if (runId) await window.lattice.cancelRun(runId)
    },

    async loadTools() {
      const id = get().activeThreadId
      if (!id || typeof window.lattice.listTools !== 'function') return
      const tools = await window.lattice.listTools(id).catch(() => [])
      if (get().activeThreadId === id) set({ tools })
    },

    async loadTodos() {
      const id = get().activeThreadId
      if (!id) {
        set({ todos: [] })
        return
      }
      // Tolerate a bridge without todo support (older preload, or a test double with a partial API).
      if (typeof window.lattice.listTodos !== 'function') return
      const todos = await window.lattice.listTodos(id).catch(() => [])
      if (get().activeThreadId === id) set({ todos })
    },

    async addTodo(title, parentId) {
      const threadId = get().activeThreadId
      const text = title.trim()
      if (!threadId || !text) return
      await window.lattice.upsertTodo({ title: text, threadId, parentId, status: 'todo', source: 'user' })
    },

    async updateTodo(id, patch) {
      // Optimistic: the row reflects the change at once; the push confirms (or corrects) it.
      const now = Date.now()
      set({ todos: get().todos.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: now } : t)) })
      await window.lattice.updateTodo(id, patch)
    },

    async deleteTodo(id) {
      const gone = new Set([id])
      // Take the subtree out locally too, so nothing flickers back in before the push lands.
      let grew = true
      while (grew) {
        grew = false
        for (const t of get().todos) {
          if (t.parentId && gone.has(t.parentId) && !gone.has(t.id)) {
            gone.add(t.id)
            grew = true
          }
        }
      }
      set({ todos: get().todos.filter((t) => !gone.has(t.id)) })
      await window.lattice.deleteTodo(id)
    },

    async clearTodos(mode) {
      const threadId = get().activeThreadId
      if (!threadId) return
      if (mode === 'all') set({ todos: [] })
      await window.lattice.clearTodos(threadId, mode)
    },

    async reorderTodos(orderedIds) {
      const threadId = get().activeThreadId
      if (!threadId) return
      const rank = new Map(orderedIds.map((id, i) => [id, i]))
      const next = [...get().todos].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
      set({ todos: next })
      await window.lattice.reorderTodos(threadId, orderedIds)
    },

    async checkModelHealth(modelIds, refresh) {
      // Tolerate a bridge without health support (older preload, or a partial test double).
      if (typeof window.lattice.checkModelHealth !== 'function') return
      const ids = [...new Set(modelIds.filter(Boolean))]
      if (!ids.length) return
      set({ modelHealthChecking: [...new Set([...get().modelHealthChecking, ...ids])] })
      try {
        // Results also arrive as `model.health` pushes; the returned set is the backstop so a cached
        // result (which is not pushed twice) still lands, and nothing stays stuck "checking".
        const results = await window.lattice.checkModelHealth(ids, refresh)
        const health = { ...get().modelHealth }
        for (const r of results) health[r.modelId] = r
        set({ modelHealth: health })
      } catch {
        // A failed round-trip leaves what we already knew; the rows just stop spinning.
      } finally {
        set({ modelHealthChecking: get().modelHealthChecking.filter((id) => !ids.includes(id)) })
      }
    },

    async loadJobs() {
      const id = get().activeThreadId
      if (!id) {
        set({ jobs: [] })
        return
      }
      // Tolerate a bridge without job support (older preload, or a test double with a partial API).
      if (typeof window.lattice.listJobs !== 'function') return
      const jobs = await window.lattice.listJobs(id).catch(() => [])
      if (get().activeThreadId === id) set({ jobs })
    },

    async stopJob(jobId) {
      await window.lattice.stopJob(jobId)
      await get().loadJobs()
    },

    async retryTurn(messageId, mode) {
      const id = get().activeThreadId
      if (!id) return
      const ok = await window.lattice.retryTurn(id, messageId, mode)
      if (!ok) get().flash('Could not retry: the thread is busy, or this is not its last reply.', 'warn')
    },

    async stopThreadWork(threadId) {
      await window.lattice.stopThreadWork(threadId)
    },

    async stopBackgroundWork(agentIds, jobIds) {
      await Promise.all([
        ...agentIds.map((id) => window.lattice.cancelAgent(id).catch(() => undefined)),
        ...jobIds.map((id) => window.lattice.stopJob(id).catch(() => undefined))
      ])
      await get().loadJobs()
    },

    async cancelAgent(agentId) {
      await window.lattice.cancelAgent(agentId)
    },

    async setModel(model, effort) {
      const id = get().activeThreadId
      const current = id ? get().threads.find((t) => t.id === id)?.model : undefined
      // A real mid-chat switch re-sends the whole conversation to the new model — park it and
      // let the user confirm the context/cost implications first (see ModelSwitchWarning).
      if (shouldWarnModelSwitch({ currentModel: current, targetModel: model, messageCount: get().messages.length })) {
        set({ pendingModelSwitch: effort ? { model, effort } : { model } })
        return
      }
      // Re-selecting the current model with a different tier is just an effort change.
      if (current === model && effort && id) {
        await get().setEffort(effort)
        return
      }
      await applyModel(model, effort)
    },

    async confirmModelSwitch() {
      const pending = get().pendingModelSwitch
      if (!pending) return
      set({ pendingModelSwitch: null })
      await applyModel(pending.model, pending.effort)
    },

    cancelModelSwitch() {
      set({ pendingModelSwitch: null })
    },

    async setDefaultModel(model) {
      await get().saveSettings({ defaultModel: model })
    },

    async toggleSubagentModel(model) {
      const current = get().settings?.subagentModels ?? []
      const next = current.includes(model) ? current.filter((id) => id !== model) : [...current, model]
      await get().saveSettings({ subagentModels: next })
    },

    async toggleFavoriteModel(model) {
      const current = get().settings?.favoriteModels ?? []
      const next = current.includes(model) ? current.filter((id) => id !== model) : [...current, model]
      await get().saveSettings({ favoriteModels: next })
    },

    async setModelEffortDefault(model, tier) {
      const next = { ...(get().settings?.defaultEffortByModel ?? {}) }
      if (tier) next[model] = tier
      else delete next[model]
      await get().saveSettings({ defaultEffortByModel: next })
    },

    async setModelContextOverride(model, tokens) {
      const next = { ...(get().settings?.modelContextOverrides ?? {}) }
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) next[model] = Math.round(tokens)
      else delete next[model]
      await get().saveSettings({ modelContextOverrides: next })
      // Applied by the registry when models are fetched, so the corrected figure only lands after a re-list.
      await get().reloadModels()
    },

    async setModelSourceOverride(model, sourceKey) {
      const next = { ...(get().settings?.modelSourceOverrides ?? {}) }
      if (sourceKey) next[model] = sourceKey
      else delete next[model]
      await get().saveSettings({ modelSourceOverrides: next })
      await get().reloadModels()
    },

    openModelPicker(opts) {
      set({
        ui: {
          ...get().ui,
          modelPickerOpen: true,
          modelPickerIntent: opts?.intent ?? 'thread',
          modelPickerFocus: opts?.focus ?? null
        }
      })
    },

    async loadModelStats() {
      // Absent on the relay/headless bridge and in unit tests: the browser simply shows no usage facts.
      if (typeof window.lattice.getStatsSnapshot !== 'function') return
      const snap = await window.lattice.getStatsSnapshot().catch(() => null)
      if (!snap) return
      set({ modelStats: foldModelStats(snap.ranges.all?.byModel ?? []) })
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

    async reloadModels() {
      const models = await window.lattice.listModels(true).catch(() => null)
      if (models) set({ models })
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
    failedThreads: new Set(),
    draftAttachments: {},
    setDraftAttachments(threadId, attachments) {
      const next = { ...get().draftAttachments }
      if (attachments.length) next[threadId] = attachments
      else delete next[threadId]
      set({ draftAttachments: next })
    },
    drafts: readDrafts(),
    setDraft(threadId, text) {
      const drafts = { ...get().drafts }
      const clipped = text.length > DRAFT_MAX_CHARS ? text.slice(0, DRAFT_MAX_CHARS) : text
      if (clipped.trim()) drafts[threadId] = clipped
      else delete drafts[threadId]
      set({ drafts })
      writeDrafts(drafts)
    },
    flash(text, tone = 'info', threadId) {
      set({ notice: { text, tone, threadId } })
      const token = text
      // A failure lingers longer: it is the thing the user came back to the screen for.
      setTimeout(() => {
        if (get().notice?.text === token) set({ notice: null })
      }, tone === 'error' ? 8000 : 3600)
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
