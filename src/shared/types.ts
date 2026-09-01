/**
 * Shared domain types for Lattice.
 * Everything crossing the IPC boundary or persisted in the event store is defined here.
 */

// ---------- IDs ----------
export type WorkspaceId = string
export type ThreadId = string
export type RunId = string
export type EventId = string
export type MessageId = string
export type AgentRunId = string

// ---------- Model registry ----------
export interface ModelCapabilities {
  vision: boolean
  tools: boolean
  reasoning: boolean
  effortTiers: string[]
}

/** Normalized price in USD per million tokens, when the provider reports it. */
export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
}

export interface ModelInfo {
  /** Full route id, e.g. "cc/claude-fable-5" */
  id: string
  /** Display name */
  name: string
  /** Route prefix, e.g. "cc", "openrouter", "mac" */
  provider: string
  /**
   * The gateway's real backend identity for this model (`owned_by`), e.g. "claude", "codex",
   * "openrouter". More reliable than the route prefix for grouping by source: a single backend
   * (your Claude sub) is often exposed under several alias prefixes (cc, claude, no-think/cc…).
   */
  ownedBy?: string
  /** The canonical model id this one is an alias of, when the gateway marks it as a `parent`. */
  parent?: string
  contextLength: number
  maxOutputTokens: number
  capabilities: ModelCapabilities
  /** USD per million tokens, when the gateway reports pricing (absent for many local models). */
  pricing?: ModelPricing
  /** Raw provider metadata, preserved verbatim */
  raw?: unknown
}

export type ReasoningFidelity = 'raw' | 'summary' | 'hidden' | 'off'

// ---------- Messages & content ----------
export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface Attachment {
  id: string
  name: string
  path?: string
  mime: string
  bytes: number
  sha256: string
  kind: 'text' | 'image' | 'binary'
  /** Extracted text for text-likes; data URL for small images */
  content?: string
}

export interface ChatMessage {
  id: MessageId
  threadId: ThreadId
  runId?: RunId
  role: Role
  createdAt: number
  /** Markdown body (user/assistant) */
  text: string
  attachments?: Attachment[]
  /** For assistant messages: model/effort actually used */
  model?: string
  effort?: string
  /** Terminal state of the producing run */
  status?: 'complete' | 'interrupted' | 'error'
  telemetry?: TurnTelemetry
  /**
   * True when this message has been folded into a compaction summary: it stays in the
   * transcript (dimmed) for the reader but is no longer sent to the model in full.
   * A `system`-role message with `compacted` false is itself a compaction summary.
   */
  compacted?: boolean
  /**
   * True while this user message is waiting in the turn queue: it was composed during an
   * active run and will start its own turn once the run ahead of it finishes. It stays
   * editable and removable until then, at which point the flag clears.
   */
  queued?: boolean
}

/** A thread whose message content matched a sidebar search, with a preview snippet. */
export interface ThreadSearchHit {
  threadId: ThreadId
  /** role of the message the snippet came from */
  role: Role
  /** short excerpt around the first match, whitespace-collapsed */
  snippet: string
}

export interface TurnTelemetry {
  ttftMs?: number
  wallMs?: number
  modelMs?: number
  toolMs?: number
  tokensOut?: number
  tokensIn?: number
  tokensReasoning?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  tps?: number
  costUsd?: number
  /** true when token counts are estimated, not provider-authoritative */
  estimated?: boolean
  route?: string
}

// ---------- Run events (canonical stream + persisted log) ----------
export type RunEventBody =
  | { type: 'run.started'; model: string; effort?: string; mode: Mode; parentAgent?: AgentRunId }
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string; fidelity: ReasoningFidelity }
  | { type: 'reasoning.done'; fidelity: ReasoningFidelity; tokenCount?: number }
  | { type: 'tool.proposed'; callId: string; tool: string; args: unknown; riskTier: RiskTier }
  | { type: 'tool.approved'; callId: string; scope: ApprovalScope }
  | { type: 'tool.denied'; callId: string; reason?: string }
  | { type: 'tool.started'; callId: string; tool: string; args: unknown }
  | {
      type: 'tool.result'
      callId: string
      tool: string
      ok: boolean
      result: unknown
      durationMs: number
      canceled?: boolean
    }
  | { type: 'ask.requested'; callId: string; question: string; kind: AskKind; options?: string[] }
  | { type: 'ask.answered'; callId: string; answer: string; canceled?: boolean }
  | { type: 'usage'; usage: TurnTelemetry }
  | { type: 'steer.injected'; messageId: MessageId }
  | { type: 'compaction'; beforeTokens: number; afterTokens: number; summaryEventId?: EventId }
  | { type: 'retry'; attempt: number; reason: string }
  | { type: 'error'; category: ErrorCategory; message: string; detail?: string; retryable: boolean }
  | { type: 'run.completed'; reason: 'done' | 'canceled' | 'error' | 'length' }

export interface RunEvent {
  id: EventId
  runId: RunId
  threadId: ThreadId
  seq: number
  ts: number
  agent?: AgentRunId
  body: RunEventBody
}

export type ErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'provider_unavailable'
  | 'route_failure'
  | 'context_overflow'
  | 'unsupported_param'
  | 'malformed_stream'
  | 'tool_failure'
  | 'permission_denied'
  | 'process_crash'
  | 'browser_failure'
  | 'canceled'
  | 'unknown'

// ---------- Modes & permissions ----------
export type Mode = 'plan' | 'act' | 'review'

export type PermissionPreset = 'manual' | 'workspace' | 'full' | 'custom'

export type RiskTier = 'R0' | 'R1' | 'R2' | 'R3'

export type PermissionResource =
  | 'filesystem'
  | 'shell'
  | 'network'
  | 'browser'
  | 'mcp'
  | 'secret'
  | 'external_action'

export type PermissionAction =
  | 'read'
  | 'create'
  | 'edit'
  | 'delete'
  | 'execute'
  | 'connect'
  | 'submit'
  | 'disclose'

export type PermissionEffect = 'allow' | 'ask' | 'deny'

export type ApprovalScope = 'once' | 'run' | 'thread' | 'profile'

export interface PermissionRule {
  id: string
  subject: 'main' | 'agent_template' | 'agent_run' | 'tool_profile'
  subjectId?: string
  resource: PermissionResource
  action: PermissionAction
  /** path, host, domain, server/tool name, or credential id */
  scope?: string
  effect: PermissionEffect
  duration: 'once' | 'run' | 'thread' | 'profile' | 'permanent'
  riskTier?: RiskTier
  createdAt: number
}

export interface ApprovalRequest {
  id: string
  runId: RunId
  threadId: ThreadId
  callId: string
  tool: string
  args: unknown
  summary: string
  resource: PermissionResource
  action: PermissionAction
  scope?: string
  riskTier: RiskTier
  /** Narrowest reusable rule the broker can save if the user picks "always" */
  proposedRule?: Omit<PermissionRule, 'id' | 'createdAt'>
}

export interface ApprovalDecision {
  requestId: string
  effect: 'allow' | 'deny'
  scope: ApprovalScope
  saveRule?: boolean
}

// ---------- Model → user questions (the `ask_user` tool) ----------

/** How the renderer should collect the answer. */
export type AskKind =
  /** free-form typed answer */
  | 'text'
  /** pick exactly one of `options` */
  | 'choice'
  /** yes / no */
  | 'confirm'

/**
 * A question the model raised mid-run via the `ask_user` tool. The run is parked
 * until the user answers (or cancels / the run is aborted), then the answer is
 * returned to the model as the tool result so it can continue.
 */
export interface AskRequest {
  id: string
  runId: RunId
  threadId: ThreadId
  callId: string
  question: string
  kind: AskKind
  /** choices for `kind: 'choice'` */
  options?: string[]
  /** placeholder for the text field (`kind: 'text'`) */
  placeholder?: string
  /** render a multi-line textarea instead of a single-line input */
  multiline?: boolean
}

export interface AskResponse {
  requestId: string
  /** the user's answer: the typed text, the chosen option, or 'yes'/'no' */
  answer: string
  /** true when the user dismissed the question without answering */
  canceled?: boolean
}

// ---------- Threads & workspaces ----------
export interface ThreadMeta {
  id: ThreadId
  workspaceId: WorkspaceId
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  archived: boolean
  model: string
  effort?: string
  mode: Mode
  permissionPreset: PermissionPreset
  /** id of parent thread when this is a /side fork */
  parentThreadId?: ThreadId
  parentEventId?: EventId
  /** persistent north-star for the thread, set via /goal; injected into the system prompt */
  goal?: string
  lastMessagePreview?: string
  running?: boolean
}

export interface WorkspaceMeta {
  id: WorkspaceId
  name: string
  /** approved filesystem roots */
  roots: string[]
  createdAt: number
}

// ---------- Context budget ----------
export interface ContextBudget {
  model: string
  contextLength: number
  /** token counts by segment */
  segments: {
    system: number
    tools: number
    history: number
    injected: number
    outputReserve: number
    safety: number
  }
  usedTokens: number
  usableTokens: number
  /** 0..1 effective occupancy */
  occupancy: number
  exact: boolean
}

// ---------- Todos ----------
export type TodoStatus = 'todo' | 'in_progress' | 'blocked' | 'review' | 'done' | 'canceled'

export interface Todo {
  id: string
  threadId?: ThreadId
  workspaceId: WorkspaceId
  title: string
  details?: string
  status: TodoStatus
  parentId?: string
  priority: number
  assignee?: string
  sourceEventId?: EventId
  result?: string
  createdAt: number
  updatedAt: number
  /** durable board item vs run checklist item */
  durable: boolean
}

// ---------- Memory ----------
export type MemoryScope = 'run' | 'thread' | 'project' | 'agent' | 'user' | 'workspace'
export type MemoryType = 'preference' | 'fact' | 'decision' | 'environment' | 'warning' | 'note'

export interface MemoryItem {
  id: string
  scope: MemoryScope
  scopeId?: string
  type: MemoryType
  content: string
  sourceEventId?: EventId
  author: 'user' | 'model' | 'import'
  confidence: number
  sensitivity: 'normal' | 'sensitive'
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  expiresAt?: number
  version: number
  status: 'proposed' | 'approved' | 'rejected' | 'expired'
  pinned: boolean
}

// ---------- Settings ----------
export interface ProviderConfig {
  id: string
  label: string
  kind: 'openai-compat'
  baseUrl: string
  /** stored in OS keychain in a later pass; plaintext-in-sqlite for now, single-user machine */
  apiKey: string
  enabled: boolean
  /** default headers merged into every request */
  headers?: Record<string, string>
  /** inject cache_control breakpoints so the gateway can reuse the stable prefix (Anthropic-compatible) */
  promptCaching?: boolean
}

export interface AppSettings {
  providers: ProviderConfig[]
  defaultModel: string
  defaultEffort?: string
  defaultMode: Mode
  defaultPermissionPreset: PermissionPreset
  theme: 'graphite' | 'midnight' | 'paper' | 'high-contrast'
  density: 'comfortable' | 'compact' | 'presentation'
  reasoningVisibility: 'expanded' | 'auto' | 'hidden'
  /** context orbit thresholds */
  compactionThreshold: number
  blockThreshold: number
  telemetryFooter: boolean
  /** runaway-loop guard for the main turn loop; 0 (or negative) means no limit */
  maxToolRounds: number
  /** runaway-loop guard for subagent loops; 0 (or negative) means no limit */
  maxSubagentToolRounds: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  providers: [],
  defaultModel: 'cc/claude-fable-5',
  defaultEffort: 'high',
  defaultMode: 'act',
  defaultPermissionPreset: 'workspace',
  theme: 'graphite',
  density: 'comfortable',
  reasoningVisibility: 'auto',
  compactionThreshold: 0.92,
  blockThreshold: 0.97,
  telemetryFooter: true,
  maxToolRounds: 0,
  maxSubagentToolRounds: 0
}

// ---------- Composer send ----------
export interface SendOptions {
  threadId: ThreadId
  text: string
  attachments?: Attachment[]
  model?: string
  effort?: string
  /** while running: steer = inject at next boundary; queue = new turn after completion */
  disposition?: 'send' | 'steer' | 'queue'
}

// ---------- compaction (/compact) ----------
export interface CompactResult {
  ok: boolean
  /** why it was refused / no-op, when `ok` is false */
  reason?: string
  /** estimated tokens of live history before compaction */
  beforeTokens?: number
  /** estimated tokens of the summary that replaced it */
  afterTokens?: number
  summaryMessageId?: string
}

// ---------- MCP ----------
export interface McpServerConfig {
  id: string
  label: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled: boolean
  /** per-tool policy overrides */
  toolPolicy?: Record<string, PermissionEffect>
}

export interface McpServerStatus {
  id: string
  connected: boolean
  latencyMs?: number
  tools: { name: string; description?: string; schema?: unknown }[]
  error?: string
}
