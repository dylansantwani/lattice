import type {
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  AskRequest,
  AskResponse,
  ChatMessage,
  CompactResult,
  ContextBudget,
  MemoryItem,
  MemorySyncReport,
  ModelInfo,
  RunEvent,
  RunId,
  SendOptions,
  ThreadGroup,
  ThreadId,
  ThreadMeta,
  ThreadSearchHit,
  Todo,
  McpServerConfig,
  McpServerStatus,
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
  /** Remove a still-queued turn (composed during a run, not yet started). Returns false if it already left the queue. */
  dequeueMessage(threadId: ThreadId, messageId: string): Promise<boolean>
  /** Edit the text of a still-queued turn. Returns the updated message, or null if it already left the queue. */
  editQueuedMessage(threadId: ThreadId, messageId: string, text: string): Promise<ChatMessage | null>

  // models
  listModels(refresh?: boolean): Promise<ModelInfo[]>

  // settings
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  // approvals
  respondApproval(decision: ApprovalDecision): Promise<void>
  pendingApprovals(): Promise<ApprovalRequest[]>

  // asks (model → user questions)
  respondAsk(response: AskResponse): Promise<void>
  pendingAsks(): Promise<AskRequest[]>

  // context
  getContextBudget(threadId: ThreadId): Promise<ContextBudget | null>

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
}

/** Push events, main → renderer, on channel `lattice:push` */
export type PushEvent =
  | { kind: 'memory.updated' }
  | { kind: 'run.event'; event: RunEvent }
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
  'dequeueMessage',
  'editQueuedMessage',
  'listModels',
  'getSettings',
  'setSettings',
  'respondApproval',
  'pendingApprovals',
  'respondAsk',
  'pendingAsks',
  'getContextBudget',
  'listTodos',
  'upsertTodo',
  'listMemory',
  'upsertMemory',
  'deleteMemory',
  'syncMemory',
  'listMcpServers',
  'upsertMcpServer',
  'deleteMcpServer'
]
