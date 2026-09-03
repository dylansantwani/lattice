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
  ContextBudget,
  FileChange,
  FsEntry,
  FsFile,
  MemoryItem,
  MemorySyncReport,
  ModelInfo,
  ProviderProbe,
  RunEvent,
  RunId,
  SendOptions,
  SessionMessage,
  SessionSummary,
  ThreadGroup,
  ThreadId,
  ThreadMeta,
  ThreadSearchHit,
  Todo,
  McpServerConfig,
  McpServerStatus,
  UsageRow,
  WorkspaceMeta
} from './types'

/**
 * Invoke-style API exposed to the renderer via contextBridge.
 * Every method maps to an ipcMain.handle channel named `lattice:<method>`.
 */
export interface LatticeApi {
  // workspaces & threads
  listWorkspaces(): Promise<WorkspaceMeta[]>
  listThreads(workspaceId?: string, includeArchived?: boolean): Promise<ThreadMeta[]>
  createThread(opts?: Partial<Pick<ThreadMeta, 'title' | 'model' | 'effort' | 'mode' | 'workspaceId'>>): Promise<ThreadMeta>
  getThread(id: ThreadId): Promise<{ meta: ThreadMeta; messages: ChatMessage[]; events: RunEvent[] }>
  /** Full-text-ish search over message content; returns one snippet per matching thread. */
  searchThreads(query: string, limit?: number): Promise<ThreadSearchHit[]>
  updateThread(id: ThreadId, patch: Partial<ThreadMeta>): Promise<ThreadMeta>
  deleteThread(id: ThreadId): Promise<void>
  /** Delete a thread's messages and events, keeping the thread and its settings (`/clear`). */
  clearThread(id: ThreadId): Promise<void>
  /** Fork a thread into a side conversation seeded from its history (`/side`, `/btw`). */
  forkThread(id: ThreadId, opts?: { titlePrefix?: string }): Promise<ThreadMeta>
  /** Summarize the thread's live history into one compaction summary (`/compact`). */
  compactThread(id: ThreadId): Promise<CompactResult>

  // thread groups (sidebar organization)
  listThreadGroups(workspaceId?: string): Promise<ThreadGroup[]>
  createThreadGroup(opts: { name: string; color?: string; workspaceId?: string }): Promise<ThreadGroup>
  updateThreadGroup(id: string, patch: Partial<Pick<ThreadGroup, 'name' | 'color' | 'sortOrder'>>): Promise<ThreadGroup>
  deleteThreadGroup(id: string): Promise<void>
  /** File a thread into a group, or clear its group with `null`. Returns the updated thread. */
  setThreadGroup(threadId: ThreadId, groupId: string | null): Promise<ThreadMeta>

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
   * Re-run the turn behind an interrupted or errored assistant message (the last message in its
   * thread): the failed reply and its run events are dropped and its user turn is run again. Returns
   * false when it cannot be retried (thread busy, not the last message, or not a failed reply).
   */
  retryTurn(threadId: ThreadId, messageId: string): Promise<boolean>

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

  // context
  getContextBudget(threadId: ThreadId): Promise<ContextBudget | null>

  // files inspector
  /** List a directory (defaults to the workspace roots when `path` is omitted), within approved roots. */
  fsTree(path?: string): Promise<FsEntry[]>
  /** Read one file for the viewer (text, image data URL, or a binary marker), within approved roots. */
  fsReadFile(path: string): Promise<FsFile>
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

  // todos
  listTodos(threadId?: ThreadId): Promise<Todo[]>
  upsertTodo(todo: Partial<Todo> & { title: string }): Promise<Todo>

  // memory
  listMemory(): Promise<MemoryItem[]>
  upsertMemory(item: Partial<MemoryItem> & { content: string }): Promise<MemoryItem>
  deleteMemory(id: string): Promise<void>
  /** Import Claude Code + Hermes memory into the shared store; returns a per-source report. */
  syncMemory(): Promise<MemorySyncReport>

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
  | { kind: 'message.updated'; message: ChatMessage }
  | { kind: 'message.deleted'; threadId: ThreadId; messageId: string }
  | { kind: 'approval.request'; request: ApprovalRequest }
  | { kind: 'approval.resolved'; requestId: string }
  | { kind: 'ask.request'; request: AskRequest }
  | { kind: 'ask.resolved'; requestId: string }
  | { kind: 'models.updated' }
  | { kind: 'mcp.updated' }
  | { kind: 'todos.updated'; threadId?: string; todos?: Todo[] }
  | { kind: 'session.message'; message: SessionMessage }
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
  'listThreads',
  'createThread',
  'getThread',
  'searchThreads',
  'updateThread',
  'deleteThread',
  'clearThread',
  'forkThread',
  'compactThread',
  'listThreadGroups',
  'createThreadGroup',
  'updateThreadGroup',
  'deleteThreadGroup',
  'setThreadGroup',
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
  'getSettings',
  'setSettings',
  'listUsageRows',
  'respondApproval',
  'pendingApprovals',
  'respondAsk',
  'pendingAsks',
  'getContextBudget',
  'fsTree',
  'fsReadFile',
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
  'listMemory',
  'upsertMemory',
  'deleteMemory',
  'syncMemory',
  'listMcpServers',
  'upsertMcpServer',
  'deleteMcpServer',
  'listSessions',
  'sendSessionMessage',
  'listInbox',
  'markSessionMessageRead'
]
