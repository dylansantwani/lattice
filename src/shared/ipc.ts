import type {
  ToolInventoryEntry,
  BgJobView,
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  AskRequest,
  AskResponse,
  BrowserBounds,
  BrowserState,
  ChatMessage,
  CompactResult,
  RollResult,
  ContextBudget,
  FileChange,
  FsEntry,
  FsFile,
  MemoryBulkAction,
  MemoryDuplicatePair,
  MemoryItem,
  MemorySweepReport,
  MemorySyncReport,
  ModelHealth,
  SessionActivity,
  SessionActivitySummary,
  ModelInfo,
  ProviderProbe,
  RetryMode,
  RunEvent,
  RunId,
  SendOptions,
  SessionMessage,
  SessionSummary,
  ThreadGroup,
  ThreadId,
  ThreadMeta,
  ThreadSearchHit,
  Fleet,
  FleetAgentView,
  FleetActivityItem,
  FleetChange,
  AgentWorkingMemory,
  AgentKind,
  Mode,
  PermissionPreset,
  Todo,
  TodoPatch,
  PermissionRule,
  McpServerConfig,
  McpServerStatus,
  UsageRow,
  WorkspaceMeta,
  ThreadView
} from './types'
import type { StatsSnapshot } from './statsSnapshot'

/**
 * Invoke-style API exposed to the renderer via contextBridge.
 * Every method maps to an ipcMain.handle channel named `lattice:<method>`.
 */
export interface LatticeApi {
  // workspaces & threads
  listWorkspaces(): Promise<WorkspaceMeta[]>
  createWorkspace(opts: { name?: string; roots: string[] }): Promise<WorkspaceMeta>
  updateWorkspace(id: string, patch: { name?: string; roots?: string[] }): Promise<WorkspaceMeta>
  deleteWorkspace(id: string): Promise<void>
  /** Find the workspace whose roots contain path, optionally creating one rooted at path. */
  resolveWorkspace(path: string, opts?: { create?: boolean }): Promise<WorkspaceMeta>
  listThreads(workspaceId?: string, includeArchived?: boolean): Promise<ThreadMeta[]>
  createThread(opts?: Partial<Pick<ThreadMeta, 'title' | 'model' | 'effort' | 'mode' | 'permissionPreset' | 'workspaceId' | 'cwd' | 'goal' | 'replyStyle' | 'contextPolicy'>>): Promise<ThreadMeta>
  /**
   * Load a thread's meta, messages and events.
   *
   * `opts.eventLimit` / `opts.messageLimit` window the history to its tail. A long thread's full
   * event log runs to tens of megabytes — mostly tool results — and every reader that only paints
   * the tail (a phone opening a chat) otherwise pays for all of it: serialise, send, parse. Omit
   * the options for the complete history, which is what the desktop transcript asks for.
   */
  getThread(id: ThreadId, opts?: { eventLimit?: number; messageLimit?: number }): Promise<{ meta: ThreadMeta; messages: ChatMessage[]; events: RunEvent[] }>
  /**
   * A thread as a remote client renders it: the last `messageLimit` messages (default 40), one
   * pre-folded summary per settled run behind them (see TurnSummary), and compact events only for a
   * run that is still live. Opening a long thread on a phone went from 2.5–4 MB of raw events to tens
   * of KB. `before` pages older messages (createdAt strictly before it).
   */
  getThreadView(id: ThreadId, opts?: { messageLimit?: number; before?: number }): Promise<ThreadView>
  /** One run's events, compacted for rendering (deltas merged, drafts/progress dropped, big results
   *  clipped) — the on-demand detail behind a TurnSummary's activity block. */
  getRunEvents(threadId: ThreadId, runId: RunId, opts?: { compact?: boolean; maxResultChars?: number }): Promise<RunEvent[]>
  /** Full-text-ish search over message content; returns one snippet per matching thread. */
  searchThreads(query: string, limit?: number): Promise<ThreadSearchHit[]>
  updateThread(id: ThreadId, patch: Partial<ThreadMeta>): Promise<ThreadMeta>
  /** Seed thread-scoped CLI permission rules before a non-interactive turn starts. */
  setPermissionRules(threadId: ThreadId, rules: PermissionRule[]): Promise<void>
  deleteThread(id: ThreadId): Promise<void>
  /** Delete a thread's messages and events, keeping the thread and its settings (`/clear`). */
  clearThread(id: ThreadId): Promise<void>
  /** Fork a thread into a side conversation seeded from its history (`/side`, `/btw`). */
  forkThread(id: ThreadId, opts?: { titlePrefix?: string }): Promise<ThreadMeta>
  /** Summarize the thread's live history into one compaction summary (`/compact`). */
  compactThread(id: ThreadId): Promise<CompactResult>
  /**
   * Fold the thread's older turns into its running summary and mine them for long-term memories,
   * keeping about `keepTokens` of recent conversation verbatim (0 = fold everything: a fresh start
   * that remembers). The on-demand half of a `rolling` {@link ContextPolicy}; works on any thread.
   */
  rollThread(id: ThreadId, opts?: { keepTokens?: number }): Promise<RollResult>

  // thread groups (sidebar organization)
  listThreadGroups(workspaceId?: string): Promise<ThreadGroup[]>
  createThreadGroup(opts: { name: string; color?: string; workspaceId?: string }): Promise<ThreadGroup>
  updateThreadGroup(id: string, patch: Partial<Pick<ThreadGroup, 'name' | 'color' | 'sortOrder'>>): Promise<ThreadGroup>
  deleteThreadGroup(id: string): Promise<void>
  /** File a thread into a group, or clear its group with `null`. Returns the updated thread. */
  setThreadGroup(threadId: ThreadId, groupId: string | null): Promise<ThreadMeta>

  // agent fleets — persistent orchestrator + dedicated workers (see store/agents.ts, runtime/fleet.ts)
  listFleets(workspaceId?: string): Promise<Fleet[]>
  createFleet(opts?: { name?: string; workspaceId?: string }): Promise<Fleet>
  renameFleet(id: string, name: string): Promise<Fleet>
  deleteFleet(id: string): Promise<void>
  /** The agents in a fleet, each joined with its live thread state (the Fleet screen's rows). */
  listAgents(fleetId: string): Promise<FleetAgentView[]>
  /** The fleet's activity feed: delegations, reports and questions between its agents, newest first. */
  listFleetActivity(fleetId: string, limit?: number): Promise<FleetActivityItem[]>
  createAgent(opts: {
    fleetId: string
    name: string
    kind: AgentKind
    role?: string
    model?: string
    effort?: string
    mode?: Mode
    permissionPreset?: PermissionPreset
    cwd?: string
    rolling?: boolean
    allowedTools?: string[]
  }): Promise<FleetAgentView>
  updateAgent(
    id: string,
    patch: {
      name?: string
      role?: string
      kind?: AgentKind
      allowedTools?: string[] | null
      model?: string
      effort?: string | null
      mode?: Mode
      permissionPreset?: PermissionPreset
      cwd?: string | null
      rolling?: boolean
      sortOrder?: number
    }
  ): Promise<FleetAgentView>
  deleteAgent(id: string): Promise<void>
  /** An agent's working memory (its WORKING_MEMORY.md, or the starter layout when it has none yet). */
  getAgentWorkingMemory(agentId: string): Promise<AgentWorkingMemory>
  /** Replace an agent's working memory from the Fleet screen; logged in the fleet change log. */
  setAgentWorkingMemory(agentId: string, content: string, expectedUpdatedAt?: number | null): Promise<AgentWorkingMemory>
  /** The fleet change log (agents added/updated/removed, memory edits), newest first. */
  listFleetChanges(fleetId: string, limit?: number): Promise<FleetChange[]>

  // runs
  send(opts: SendOptions): Promise<{ runId: RunId; messageId: string }>
  cancelRun(runId: RunId): Promise<void>
  /** Stop a single subagent (by its agentId) without canceling the rest of the run. */
  cancelAgent(agentId: string): Promise<void>
  /** Stop everything on a thread: its live run, every background subagent, and every background job. */
  stopThreadWork(threadId: ThreadId): Promise<void>
  /** Remove a still-queued turn (composed during a run, not yet started). Returns false if it already left the queue. */
  dequeueMessage(threadId: ThreadId, messageId: string): Promise<boolean>
  /** Edit the text of a still-queued turn. Returns the updated message, or null if it already left the queue. */
  editQueuedMessage(threadId: ThreadId, messageId: string, text: string): Promise<ChatMessage | null>
  /** Promote a still-queued turn into the live run as a steer, folding it into the response in progress. Returns false if it can no longer be steered. */
  steerQueuedMessage(threadId: ThreadId, messageId: string): Promise<boolean>
  /**
   * Recover an interrupted or errored assistant message (the last message in its thread). By default
   * (`auto`) the reply is RESUMED — continued from where it stopped, keeping the text it already
   * wrote and the tool calls it already ran — falling back to a restart when it produced nothing.
   * `restart` always discards the reply and runs the user's turn again. Returns false when it cannot
   * be done (thread busy, not the last message, not a failed reply, or `resume` with nothing to resume).
   */
  retryTurn(threadId: ThreadId, messageId: string, mode?: RetryMode): Promise<boolean>

  /** Every tool the thread could use, with the effect its mode/preset gives each (Tools inspector). */
  listTools(threadId: ThreadId): Promise<ToolInventoryEntry[]>

  // background jobs (shell commands running detached from the turn)
  listJobs(threadId: ThreadId): Promise<BgJobView[]>
  /** SIGTERM a running background job. Returns false if unknown or already finished. */
  stopJob(jobId: string): Promise<boolean>

  // models
  listModels(refresh?: boolean): Promise<ModelInfo[]>
  /** Live-probe one provider's /v1/models: reports reachability + model count, and warms the cache. */
  checkProvider(providerId: string): Promise<ProviderProbe>
  /**
   * Ping models to see which are actually live before one is chosen (the model picker). Each result
   * also arrives as a `model.health` push as it lands, so rows can update progressively; the
   * returned array is the complete set. Fresh results are served from a short-lived cache unless
   * `refresh` is set.
   */
  checkModelHealth(modelIds: string[], refresh?: boolean): Promise<ModelHealth[]>

  // settings
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  // approvals
  respondApproval(decision: ApprovalDecision): Promise<void>
  pendingApprovals(): Promise<ApprovalRequest[]>

  // asks (model → user questions)
  respondAsk(response: AskResponse): Promise<void>
  pendingAsks(): Promise<AskRequest[]>

  // usage (Usage page — app-wide rollup of per-turn telemetry across every thread)
  listUsageRows(): Promise<UsageRow[]>
  /** The full, detailed usage snapshot (windowed totals, 30-day activity, per-model/provider/thread/
   * tool breakdowns) — the single source of truth behind both the Usage page and the menu-bar app. */
  getStatsSnapshot(): Promise<StatsSnapshot>

  // context
  getContextBudget(threadId: ThreadId): Promise<ContextBudget | null>

  // files inspector
  /** List a directory (defaults to the workspace roots when `path` is omitted), within approved roots. */
  fsTree(path?: string): Promise<FsEntry[]>
  /** Read one file for the viewer (text, image data URL, or a binary marker), within approved roots. */
  fsReadFile(path: string): Promise<FsFile>
  /** Read a path into a wire-ready attachment, applying the renderer's image limits server-side. */
  attachFile(path: string): Promise<import('./types').Attachment>
  /** The files the agent created/edited/deleted in this thread, newest first (session diff). */
  fileChanges(threadId: ThreadId): Promise<FileChange[]>

  // terminal inspector (live interactive PTY)
  /** Spawn an interactive login shell; output streams back as `pty.data` push events. */
  ptyCreate(opts?: { cwd?: string; cols?: number; rows?: number }): Promise<{ id: string }>
  /** Send keystrokes / input bytes to a terminal. */
  ptyInput(id: string, data: string): Promise<void>
  /** Tell a terminal its new viewport size. */
  ptyResize(id: string, cols: number, rows: number): Promise<void>
  /** Kill a terminal and release its PTY. */
  ptyKill(id: string): Promise<void>

  // embedded browser inspector (isolated WebContentsView)
  /** Show the embedded browser at `bounds` (creating it on first use); returns its nav state. */
  browserAttach(bounds: BrowserBounds): Promise<BrowserState | null>
  /** Reposition the embedded browser as its host element moves/resizes. */
  browserSetBounds(bounds: BrowserBounds): Promise<void>
  /** Hide the embedded browser (kept alive so navigation state survives tab switches). */
  browserDetach(): Promise<void>
  /** Navigate the embedded browser (bare hosts get https://, free text becomes a search). */
  browserNavigate(url: string): Promise<void>
  browserBack(): Promise<void>
  browserForward(): Promise<void>
  browserReload(): Promise<void>
  browserStop(): Promise<void>

  // todos (the Tasks panel — the user edits the same checklist the agent maintains with todo_write)
  listTodos(threadId?: ThreadId): Promise<Todo[]>
  upsertTodo(todo: Partial<Todo> & { title: string }): Promise<Todo>
  /** Patch fields on one item (title, status, parent, priority…). Returns null when the id is unknown. */
  updateTodo(id: string, patch: TodoPatch): Promise<Todo | null>
  /** Delete one item and its subtasks. */
  deleteTodo(id: string): Promise<void>
  /** Remove a thread's finished items (`done` — done + canceled) or the whole checklist (`all`). Returns the count removed. */
  clearTodos(threadId: ThreadId, mode: 'done' | 'all'): Promise<number>
  /** Persist a manual ordering: `orderedIds` first-to-last become the thread's top-to-bottom order. */
  reorderTodos(threadId: ThreadId, orderedIds: string[]): Promise<void>

  // memory
  listMemory(): Promise<MemoryItem[]>
  /** Create or edit one item. A human upsert of a model-authored item stamps `reviewedAt` (the export gate). */
  upsertMemory(item: Partial<MemoryItem> & { content: string }): Promise<MemoryItem>
  deleteMemory(id: string): Promise<void>
  /** Import Claude Code + Hermes memory into the shared store (forced, bypassing the change caches); returns a per-source report. */
  syncMemory(): Promise<MemorySyncReport>
  /** Full-text search over every stored item (all statuses, no scope filter) — the Memory tab's search box, ranked like the tool. */
  searchMemory(query: string): Promise<MemoryItem[]>
  /** Near-duplicate pairs among Lattice-authored items, best match first. */
  listMemoryDuplicates(): Promise<MemoryDuplicatePair[]>
  /** Collapse `dropIds` into `keepId` (optionally with new content); returns the survivor, or null if keepId is unknown. */
  mergeMemory(keepId: string, dropIds: string[], content?: string): Promise<MemoryItem | null>
  /** Apply one action to many items at once; returns how many rows changed. */
  bulkMemory(ids: string[], action: MemoryBulkAction): Promise<number>
  /** Counts for the Memory tab badge, without loading rows. */
  memoryCounts(): Promise<{ total: number; proposed: number; pinned: number }>
  /** Run the housekeeping sweep now (expire, retire, purge); returns what it did. */
  sweepMemory(): Promise<MemorySweepReport>

  // mcp
  listMcpServers(): Promise<{ config: McpServerConfig; status: McpServerStatus }[]>
  upsertMcpServer(config: McpServerConfig): Promise<void>
  deleteMcpServer(id: string): Promise<void>

  // inter-session messaging (Slice 9)
  /** The other sessions this session can address, most-recently-active first. */
  listSessions(excludeThreadId?: ThreadId): Promise<SessionSummary[]>
  /** Send a message to another session by id or title; delivers live (steer) or to its inbox. */
  sendSessionMessage(opts: { fromThreadId: ThreadId; to: string; body: string; replyTo?: string }): Promise<{
    ok: boolean
    delivery?: 'injected' | 'woken' | 'queued'
    toThreadId?: ThreadId
    toTitle?: string
    messageId?: string
    error?: string
  }>
  /** Messages addressed to a thread, newest first. */
  listInbox(threadId: ThreadId): Promise<SessionMessage[]>
  /** Mark one inbox message read; returns false if unknown or already read. */
  markSessionMessageRead(id: string): Promise<boolean>

  // cross-session live activity (Slice 9)
  /** Every session's live state — status, what it is doing, what it is waiting on. */
  listSessionActivity(excludeThreadId?: ThreadId): Promise<SessionActivitySummary[]>
  /** A read-only window onto one session: recent transcript, tool calls, pending approvals/asks. */
  getSessionActivity(threadId: ThreadId): Promise<SessionActivity | null>
  /**
   * Declare the whole set of sessions to stream live updates for, as `session.activity` pushes.
   * Idempotent: pass the full set each time (an empty array stops everything), so a reloaded
   * renderer simply re-declares what it wants and no watch can leak.
   */
  watchSessionActivity(threadIds: ThreadId[]): Promise<void>

  // text-to-speech
  /**
   * Synthesize `text` through the OpenAI-compatible speech endpoint in Settings → Voice (or the
   * overrides, for trying a configuration before saving it). Returns the audio as base64 — the
   * renderer plays it; the main process keeps the API key and sidesteps CORS on local servers.
   */
  synthesizeSpeech(text: string, overrides?: Partial<import('./speech').SpeechSettings>): Promise<SpeechAudio>
  /** Voices the configured OpenAI-compatible endpoint offers (Kokoro lists them; OpenAI has a fixed set). */
  listSpeechVoices(overrides?: Partial<import('./speech').SpeechSettings>): Promise<string[]>
}

export interface SpeechAudio {
  mime: string
  base64: string
}

/** Push events, main → renderer, on channel `lattice:push` */
export type PushEvent =
  | { kind: 'memory.updated' }
  | { kind: 'run.event'; event: RunEvent }
  // A live context-budget snapshot, pushed mid-run so the Context Orbit tracks the window filling
  // up in real time (streamed reply + tool results) instead of freezing until the turn completes.
  | { kind: 'budget.updated'; threadId: ThreadId; budget: ContextBudget }
  | { kind: 'thread.updated'; meta: ThreadMeta }
  | { kind: 'thread.deleted'; id: ThreadId }
  | { kind: 'groups.updated'; groups: ThreadGroup[] }
  /** A fleet or one of its agents was created/edited/removed — the Fleet screen reloads. */
  | { kind: 'fleet.updated' }
  | { kind: 'message.updated'; message: ChatMessage }
  | { kind: 'message.deleted'; threadId: ThreadId; messageId: string }
  | { kind: 'approval.request'; request: ApprovalRequest }
  | { kind: 'approval.resolved'; requestId: string }
  | { kind: 'ask.request'; request: AskRequest }
  | { kind: 'ask.resolved'; requestId: string }
  | { kind: 'models.updated' }
  /** One model's health ping landed (see `checkModelHealth`) — the picker lights up that row. */
  | { kind: 'model.health'; health: ModelHealth }
  | { kind: 'mcp.updated' }
  | { kind: 'todos.updated'; threadId?: string; todos?: Todo[] }
  | { kind: 'session.message'; message: SessionMessage }
  /** A watched session's live state changed — the cross-session activity view redraws that row. */
  | { kind: 'session.activity'; activity: SessionActivity }
  | { kind: 'files.changed'; threadId: ThreadId }
  /** A background job on this thread started, produced output, or finished — refetch with listJobs. */
  | { kind: 'jobs.updated'; threadId: ThreadId }
  | { kind: 'pty.data'; id: string; data: string }
  | { kind: 'pty.exit'; id: string; exitCode: number }
  | { kind: 'browser.state'; state: BrowserState }
  | { kind: 'zoom.changed'; factor: number }
  /** A user-facing notice (toast): failures and needs-you moments, clickable to jump to the thread. */
  | { kind: 'notice'; tone: 'info' | 'warn' | 'error'; text: string; threadId?: ThreadId }

export const API_METHODS: (keyof LatticeApi)[] = [
  'listWorkspaces',
  'createWorkspace',
  'updateWorkspace',
  'deleteWorkspace',
  'resolveWorkspace',
  'listThreads',
  'createThread',
  'getThread',
  'getThreadView',
  'getRunEvents',
  'searchThreads',
  'updateThread',
  'setPermissionRules',
  'deleteThread',
  'clearThread',
  'forkThread',
  'compactThread',
  'rollThread',
  'listThreadGroups',
  'createThreadGroup',
  'updateThreadGroup',
  'deleteThreadGroup',
  'setThreadGroup',
  'listFleets',
  'createFleet',
  'renameFleet',
  'deleteFleet',
  'listAgents',
  'listFleetActivity',
  'createAgent',
  'updateAgent',
  'deleteAgent',
  'getAgentWorkingMemory',
  'setAgentWorkingMemory',
  'listFleetChanges',
  'send',
  'cancelRun',
  'cancelAgent',
  'stopThreadWork',
  'dequeueMessage',
  'editQueuedMessage',
  'steerQueuedMessage',
  'retryTurn',
  'listTools',
  'listJobs',
  'stopJob',
  'listModels',
  'checkProvider',
  'checkModelHealth',
  'getSettings',
  'setSettings',
  'listUsageRows',
  'getStatsSnapshot',
  'respondApproval',
  'pendingApprovals',
  'respondAsk',
  'pendingAsks',
  'getContextBudget',
  'fsTree',
  'fsReadFile',
  'attachFile',
  'fileChanges',
  'ptyCreate',
  'ptyInput',
  'ptyResize',
  'ptyKill',
  'browserAttach',
  'browserSetBounds',
  'browserDetach',
  'browserNavigate',
  'browserBack',
  'browserForward',
  'browserReload',
  'browserStop',
  'listTodos',
  'upsertTodo',
  'updateTodo',
  'deleteTodo',
  'clearTodos',
  'reorderTodos',
  'listMemory',
  'upsertMemory',
  'deleteMemory',
  'syncMemory',
  'searchMemory',
  'listMemoryDuplicates',
  'mergeMemory',
  'bulkMemory',
  'memoryCounts',
  'sweepMemory',
  'listMcpServers',
  'upsertMcpServer',
  'deleteMcpServer',
  'listSessions',
  'sendSessionMessage',
  'listInbox',
  'markSessionMessageRead',
  'listSessionActivity',
  'getSessionActivity',
  'watchSessionActivity',
  'synthesizeSpeech',
  'listSpeechVoices'
]
