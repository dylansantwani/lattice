import type {
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  ContextBudget,
  MemoryItem,
  ModelInfo,
  RunEvent,
  RunId,
  SendOptions,
  ThreadId,
  ThreadMeta,
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
  listThreads(workspaceId?: string): Promise<ThreadMeta[]>
  createThread(opts?: Partial<Pick<ThreadMeta, 'title' | 'model' | 'effort' | 'mode' | 'workspaceId'>>): Promise<ThreadMeta>
  getThread(id: ThreadId): Promise<{ meta: ThreadMeta; messages: ChatMessage[]; events: RunEvent[] }>
  updateThread(id: ThreadId, patch: Partial<ThreadMeta>): Promise<ThreadMeta>
  deleteThread(id: ThreadId): Promise<void>

  // runs
  send(opts: SendOptions): Promise<{ runId: RunId; messageId: string }>
  cancelRun(runId: RunId): Promise<void>

  // models
  listModels(refresh?: boolean): Promise<ModelInfo[]>

  // settings
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  // approvals
  respondApproval(decision: ApprovalDecision): Promise<void>
  pendingApprovals(): Promise<ApprovalRequest[]>

  // context
  getContextBudget(threadId: ThreadId): Promise<ContextBudget | null>

  // todos
  listTodos(threadId?: ThreadId): Promise<Todo[]>
  upsertTodo(todo: Partial<Todo> & { title: string }): Promise<Todo>

  // memory
  listMemory(): Promise<MemoryItem[]>
  upsertMemory(item: Partial<MemoryItem> & { content: string }): Promise<MemoryItem>
  deleteMemory(id: string): Promise<void>

  // mcp
  listMcpServers(): Promise<{ config: McpServerConfig; status: McpServerStatus }[]>
  upsertMcpServer(config: McpServerConfig): Promise<void>
  deleteMcpServer(id: string): Promise<void>
}

/** Push events, main → renderer, on channel `lattice:push` */
export type PushEvent =
  | { kind: 'run.event'; event: RunEvent }
  | { kind: 'thread.updated'; meta: ThreadMeta }
  | { kind: 'message.updated'; message: ChatMessage }
  | { kind: 'approval.request'; request: ApprovalRequest }
  | { kind: 'approval.resolved'; requestId: string }
  | { kind: 'models.updated' }
  | { kind: 'todos.updated'; threadId?: string }

export const API_METHODS: (keyof LatticeApi)[] = [
  'listWorkspaces',
  'listThreads',
  'createThread',
  'getThread',
  'updateThread',
  'deleteThread',
  'send',
  'cancelRun',
  'listModels',
  'getSettings',
  'setSettings',
  'respondApproval',
  'pendingApprovals',
  'getContextBudget',
  'listTodos',
  'upsertTodo',
  'listMemory',
  'upsertMemory',
  'deleteMemory',
  'listMcpServers',
  'upsertMcpServer',
  'deleteMcpServer'
]
