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

/**
 * A user-authored cost model for one route, in USD per million tokens. When present it replaces
 * list-price *estimation* for turns on that route (it does not override cost the provider actually
 * billed), and the resulting figure is shown as an exact cost — the user is asserting
 * these are their real rates. `cachedInputPerMTok`/`reasoningPerMTok` are optional; when omitted they
 * fall back to `inputPerMTok` and `outputPerMTok` respectively, which reproduces the coarse list-price
 * estimate exactly (that estimate charges every input token at the input rate and every output token,
 * reasoning included, at the output rate).
 */
export interface CostRates {
  inputPerMTok: number
  cachedInputPerMTok?: number
  outputPerMTok: number
  reasoningPerMTok?: number
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
  /** The configured Lattice provider this model was fetched from (its id) — set by the registry. */
  providerId?: string
  /** That provider's label, e.g. "runpod2". Used to group models under a provider whose backend
   *  `owned_by` isn't a recognized gateway source (a dedicated vLLM/llama.cpp endpoint, say). */
  providerLabel?: string
  contextLength: number
  maxOutputTokens: number
  capabilities: ModelCapabilities
  /** USD per million tokens, when the gateway reports pricing (absent for many local models). */
  pricing?: ModelPricing
  /** Raw provider metadata, preserved verbatim */
  raw?: unknown
}

export type ReasoningFidelity = 'raw' | 'summary' | 'hidden' | 'off'

// ---------- tool inventory (Tools inspector) ----------
/** One tool as the current thread sees it: where it comes from, what the policy does with it, its schema. */
export interface ToolInventoryEntry {
  name: string
  description: string
  /** builtin core, or a deferred MCP tool */
  source: 'builtin' | 'mcp'
  serverId?: string
  serverLabel?: string
  resource: string
  action: string
  riskTier: string
  /** what the thread's mode + permission preset do with a call: run, ask first, or withhold */
  effect: 'allow' | 'ask' | 'deny'
  /** MCP only: whether this thread has loaded the tool's schema into its request (via find_tools or first use) */
  loaded?: boolean
  /** MCP only: server connectivity */
  healthy?: boolean
  error?: string
  parameters: unknown
}

// ---------- background jobs ----------
export type BgJobStatus = 'running' | 'done' | 'failed' | 'canceled'

/** The public, serialisable view of a background shell job — what `job_status` and the inspector see. */
export interface BgJobView {
  id: string
  threadId: string
  command: string
  status: BgJobStatus
  startedAt: number
  endedAt?: number
  exitCode?: number
  /** combined stdout+stderr so far (live while running), capped with a truncation note */
  output: string
  running: boolean
  /** True for a foreground command that was moved to the background after its grace window. */
  promoted?: boolean
  /** The model's short human label for what the command is for (the `purpose` argument). */
  purpose?: string
}

// ---------- Messages & content ----------
export type Role = 'user' | 'assistant' | 'system' | 'tool'

/**
 * Provenance for a message that reaches a thread's transcript as a `user`-role turn but was NOT
 * typed by the human — a finished background subagent's result, or a message another session (or a
 * subagent) sent here. The model still reads it as ordinary user-role input; `origin` exists purely
 * so the renderer attributes it to its real sender (an "incoming" card) instead of drawing it as a
 * bubble the person appears to have written themselves.
 */
export interface MessageOrigin {
  /**
   * `agent` — a subagent (its completion, or a message it sent). `session` — another thread.
   * `shell` — the completion of a long shell command that was auto-moved to the background.
   */
  kind: 'agent' | 'session' | 'shell'
  /** Human-readable sender: the subagent's name, the sending session's title, or "shell". */
  label: string
  /** For `kind:'agent'`: the subagent's id. */
  agentId?: string
  /** For `kind:'session'` (or an agent messaging across threads): the sending thread's id. */
  fromThreadId?: ThreadId
}

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

/**
 * A provider-wire message captured verbatim during a run — the assistant's tool-call message, a
 * tool result, or the user-role carrier for images a tool returned. These live only in the
 * in-memory request transcript during a run; persisting them on the producing assistant message
 * lets a later turn replay them into context, so the model retains what its own tools returned
 * instead of forgetting it the moment the turn ends. Mirrors the provider `WireMessage` shape.
 */
export interface WireExchange {
  role: 'assistant' | 'tool' | 'user'
  content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
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
  /**
   * For assistant messages that called tools: the raw tool-call/result exchanges produced while
   * generating this message, captured so later turns can replay them (the model would otherwise
   * lose all tool output across turns). Not shown in the transcript — the visible text is `text`.
   */
  toolExchanges?: WireExchange[]
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
  /**
   * Set when this `user`-role message did not come from the human: a delivered subagent completion,
   * or a message from another session/subagent. Drives attributed rendering (see {@link MessageOrigin}).
   */
  origin?: MessageOrigin
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
  /** set on a per-round usage event: ttftMs/wallMs describe that one provider request */
  round?: boolean
}

/**
 * One completed main-run turn's telemetry, with just enough thread context to roll many of
 * these up across the whole app (the Usage page). Subagent turns are intentionally excluded —
 * same convention as the per-thread Run tab breakdown — since they're not separately billed
 * turns the user waited on; their cost is conceptually part of the parent turn.
 */
export interface UsageRow {
  id: MessageId
  threadId: ThreadId
  threadTitle: string
  model?: string
  effort?: string
  createdAt: number
  telemetry: TurnTelemetry
}

// ---------- Run events (canonical stream + persisted log) ----------
export type RunEventBody =
  | {
      type: 'run.started'
      model: string
      effort?: string
      mode: Mode
      /** main runs only: whether the provider serving this run has prompt caching on */
      promptCaching?: boolean
      parentAgent?: AgentRunId
      tools?: string[]
      /** subagent runs only: the human-readable name the parent model gave this agent */
      name?: string
      /** subagent runs only: the free-form role label (e.g. "researcher") */
      agentType?: string
      /**
       * subagent runs only: the callId of the parent's `run_agent` tool call that spawned this agent.
       * Lets the transcript bind the agent's live activity to the delegation row that started it.
       */
      parentCallId?: string
    }
  | { type: 'text.delta'; text: string }
  // `startedAt` is the wall-clock (ms) at which THIS bout of reasoning began — the moment the first
  // reasoning token arrived, captured live in the run loop before any coalescing. It rides on every
  // delta of the bout so the timeline can date the segment from when the model actually started
  // thinking, not from when the coalesced delta happened to be persisted (which can lag by up to a
  // flush interval, and collapses to the tool-call instant when reasoning is followed by a tool).
  | { type: 'reasoning.delta'; text: string; fidelity: ReasoningFidelity; startedAt?: number }
  // `durationMs` is the authoritative thinking span for the bout (real end − real start), measured
  // live. The renderer prefers it over any timestamp subtraction, which is unreliable under coalescing.
  | { type: 'reasoning.done'; fidelity: ReasoningFidelity; tokenCount?: number; durationMs?: number }
  // Emitted while the model is still streaming a tool call's arguments, before the call is complete
  // and submitted. `args` is the bounded raw JSON prefix assembled so far; it can be incomplete and
  // is only for the live transcript preview. The eventual `tool.proposed`/`tool.started` reuse the
  // same callId, so every phase folds into the one row.
  | { type: 'tool.drafting'; callId: string; tool?: string; args?: string }
  | { type: 'tool.proposed'; callId: string; tool: string; args: unknown; riskTier: RiskTier }
  | { type: 'tool.approved'; callId: string; scope: ApprovalScope }
  | { type: 'tool.denied'; callId: string; reason?: string }
  | { type: 'tool.started'; callId: string; tool: string; args: unknown }
  /**
   * Live output of a running tool (a foreground shell command's PTY buffer so far), replacing any
   * earlier snapshot for the same call. Throttled by the tool; shown in the tool row's dropdown.
   */
  | { type: 'tool.progress'; callId: string; output: string }
  | {
      type: 'tool.result'
      callId: string
      tool: string
      ok: boolean
      result: unknown
      durationMs: number
      canceled?: boolean
    }
  | { type: 'ask.requested'; callId: string; question: string; kind: AskKind; options?: AskOption[] }
  | { type: 'ask.answered'; callId: string; answer: string; canceled?: boolean }
  | { type: 'usage'; usage: TurnTelemetry }
  | { type: 'steer.injected'; messageId: MessageId }
  | { type: 'compaction'; beforeTokens: number; afterTokens: number; summaryEventId?: EventId }
  // A round is being redone. `rewound` marks an endpoint-failure retry that restarts the round from
  // scratch: any text/reasoning/tool-draft the failed attempt already streamed is discarded, so the
  // transcript drops it back to the last committed point rather than stitching a broken half-reply
  // onto the redo. Stall/length self-recoveries omit it — their partial output is kept and continued.
  | { type: 'retry'; attempt: number; reason: string; rewound?: boolean }
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
  | 'model_unavailable'
  | 'context_overflow'
  | 'unsupported_param'
  | 'malformed_stream'
  | 'truncated_output'
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
 * One selectable answer for a `kind: 'choice'` question. Beyond the bare label the
 * model can hint which option it recommends and add a one-line rationale, so the user
 * sees why an option is there. The renderer always adds a free-form "Other" affordance
 * on top of these, so the model never needs to include an "Other" option itself.
 */
export interface AskOption {
  /** the answer text returned to the model when this option is chosen */
  label: string
  /** optional one-line explanation shown under the label */
  description?: string
  /** highlight this as the suggested choice (at most one option should set it) */
  recommended?: boolean
}

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
  options?: AskOption[]
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
/**
 * Who owns a thread's current title. `auto` — the default 'New thread' or a model-written summary,
 * free to be refreshed as the conversation evolves; `user` — the human named it (rename UI, or an
 * explicit title at creation, e.g. a /side fork), never overwritten automatically; `agent` — the
 * model deliberately named it via `set_thread_title`, also left alone by auto-titling.
 */
export type TitleSource = 'auto' | 'user' | 'agent'

export interface ThreadMeta {
  id: ThreadId
  workspaceId: WorkspaceId
  title: string
  /** Provenance of `title` — gates automatic re-titling (see {@link TitleSource}). */
  titleSource?: TitleSource
  /** How many user messages the thread had when auto-titling last ran (refresh cadence anchor). */
  titleMsgs?: number
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
  /** id of the user-defined {@link ThreadGroup} this thread was filed under, when any */
  groupId?: string
  lastMessagePreview?: string
  running?: boolean
}

/**
 * A user-defined folder for organizing threads in the sidebar. Threads reference a group by
 * {@link ThreadMeta.groupId}; a thread belongs to at most one group. Groups are per-workspace
 * and ordered by `sortOrder` (ascending). This backs the sidebar's "Groups" (manual) view;
 * the "Auto" view derives its buckets on the fly and needs no persisted groups.
 */
export interface ThreadGroup {
  id: string
  workspaceId: WorkspaceId
  name: string
  /** accent token key (see SIDEBAR group palette), e.g. 'violet' | 'green' | 'amber' */
  color?: string
  /** manual ordering within the sidebar, ascending */
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/**
 * A message sent from one session (thread) to another — the unit of Slice 9 inter-session
 * messaging. `delivery` records how it reached the recipient: `injected` when the recipient had a
 * live run and the message was steered into it at the next safe boundary; `queued` when it waited in
 * the recipient's inbox. `readAt` is set the moment it is delivered (injected) or drained from the
 * inbox (queued via `check_inbox`, or opened by the user).
 */
export interface SessionMessage {
  id: string
  fromThreadId: ThreadId
  toThreadId: ThreadId
  /** the sender's thread title snapshotted at send time (the recipient may not know the sender) */
  fromTitle: string
  /** Whether the sender is another thread or an ephemeral subagent running under that thread. */
  fromKind?: 'session' | 'agent'
  /** The ephemeral sender id when {@link fromKind} is `agent`. */
  fromAgentId?: string
  body: string
  /** id of the {@link SessionMessage} this replies to, when it is a reply */
  replyTo?: string
  createdAt: number
  readAt?: number
  delivery: 'injected' | 'woken' | 'queued'
}

/** One addressable session in the messaging directory (see `list_sessions`). */
export interface SessionSummary {
  threadId: ThreadId
  title: string
  model: string
  running: boolean
  updatedAt: number
  /** messages waiting unread in this session's inbox */
  unread: number
}

/** How the sidebar organizes threads: a flat recency list, user folders, or derived buckets. */
export type SidebarGrouping = 'flat' | 'manual' | 'auto'

/** What the "Auto" sidebar view buckets threads by. */
export type AutoGroupBy = 'date' | 'model' | 'mode'

export interface WorkspaceMeta {
  id: WorkspaceId
  name: string
  /** approved filesystem roots */
  roots: string[]
  createdAt: number
}

// ---------- Files inspector ----------

/** How the agent touched a file, tracked for the session diff. */
export type FileChangeKind = 'create' | 'edit' | 'delete' | 'move'

/** One file the agent changed this thread: the pre-edit baseline and the current content. */
export interface FileChange {
  threadId: ThreadId
  path: string
  kind: FileChangeKind
  /** file content before the first change this thread (null when the agent created it) */
  before: string | null
  /** file content after the latest change (null when the agent deleted it) */
  after: string | null
  /** true when the stored content was clipped because the file exceeded the diff size cap */
  beforeTruncated: boolean
  afterTruncated: boolean
  firstAt: number
  lastAt: number
}

/** One entry in a directory listing for the file tree. */
export interface FsEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
  size?: number
}

// ---------- Embedded browser inspector ----------

/** Bounds for the embedded browser view, in window content-DIP space (already zoom-scaled). */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Live navigation state of the embedded browser, pushed to the renderer on every change. */
export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

/** The content of a single file, resolved for the viewer. */
export interface FsFile {
  path: string
  /** 'text' → `text` is set; 'image' → `dataUrl` is a data: URL; 'binary' → neither, too large / not renderable */
  kind: 'text' | 'image' | 'binary'
  text?: string
  dataUrl?: string
  size: number
  /** true when a large text file was clipped to the read cap */
  truncated?: boolean
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
  /**
   * tokens reclaimed from the wire by stale tool-result pruning (present only when > 0). The segment
   * counts already reflect the pruned bodies; this reports what pruning saved for the inspector.
   */
  prunedTokens?: number
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
  /** who created the item: the running agent (todo_write) or the user editing the panel by hand */
  source?: 'agent' | 'user'
}

/** The fields the user can change on an existing checklist item from the Tasks panel. */
export type TodoPatch = Partial<Pick<Todo, 'title' | 'details' | 'status' | 'parentId' | 'priority'>>

// ---------- Memory ----------
export type MemoryScope = 'run' | 'thread' | 'project' | 'agent' | 'user' | 'workspace'
export type MemoryType = 'preference' | 'fact' | 'decision' | 'environment' | 'warning' | 'note'

/** Result of a bidirectional memory sync with Claude Code + Hermes. */
export interface MemorySyncReport {
  ok: boolean
  sources: { store: 'claude-code' | 'hermes'; label: string; found: number; error?: string }[]
  /** newly created imported items */
  added: number
  /** existing imported items whose content changed */
  updated: number
  /** imported items pruned because they no longer exist upstream */
  removed: number
  /** total imported items after the sync */
  total: number
  /** write-back: Lattice-authored memories exported into each external store */
  exported: { store: 'claude-code' | 'hermes'; label: string; wrote: number; error?: string }[]
}

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

/** Result of live-probing a single provider's `/v1/models` — powers the Providers-tab status line. */
export interface ProviderProbe {
  ok: boolean
  /** models the provider reported (0 on failure) */
  count: number
  /** human-readable failure reason when `ok` is false (e.g. "HTTP 404", "invalid URL") */
  error?: string
}

/**
 * How a model answered its health ping (see `src/main/providers/health.ts`):
 *  - `live` — answered promptly
 *  - `slow` — answered, but took long enough that you should know before committing a turn to it
 *  - `limited` — reachable, but would not serve the request now (rate-limited, or it rejected the
 *    minimal probe); the route exists, so it may well work for a real request
 *  - `down` — unreachable, unauthorized, unknown to the gateway, or its upstream is broken
 *  - `unknown` — not checked, or no enabled provider serves the id
 */
export type ModelHealthStatus = 'live' | 'slow' | 'limited' | 'down' | 'unknown'

/** The result of pinging one model, shown in the picker before the model is chosen. */
export interface ModelHealth {
  modelId: string
  status: ModelHealthStatus
  /** round-trip of the ping in ms, when one was made */
  latencyMs?: number
  /** which provider served (or would have served) the ping */
  providerId?: string
  /** human-readable reason for a non-live status */
  error?: string
  checkedAt: number
}

export interface AppSettings {
  providers: ProviderConfig[]
  // ---- defaults applied to every new thread ----
  defaultModel: string
  defaultEffort?: string
  defaultMode: Mode
  defaultPermissionPreset: PermissionPreset
  // ---- model / sampling (applied to every request) ----
  /** sampling temperature sent to the model; null = provider/model default (field omitted) */
  temperature: number | null
  /** hard cap on output tokens per response; 0 = provider/model default */
  maxOutputTokens: number
  /** your standing instructions, appended to the base system prompt on every turn */
  customInstructions: string
  /** memory in prompts: pinned items inline + a static recall note (rest via memory_search) */
  includeMemory: boolean
  /** after each run, distill durable memories from the exchange (self-learning) */
  selfLearning: boolean
  /**
   * when self-learning, store high-confidence, non-sensitive learnings as `approved`
   * (so they inject and export to Claude Code + Hermes immediately) instead of `proposed`
   * (which wait for review in the Memory tab)
   */
  selfLearningAutoApprove: boolean
  // ---- appearance ----
  theme: 'graphite' | 'midnight' | 'paper' | 'high-contrast'
  density: 'comfortable' | 'compact' | 'presentation'
  reasoningVisibility: 'expanded' | 'auto' | 'hidden'
  telemetryFooter: boolean
  // ---- notifications ----
  /**
   * When Lattice gets loud: `failures` — a run error, a failed background job or subagent;
   * `attention` (default) — failures plus moments that need you (an approval, a question);
   * `all` — also when a run finishes while the window is in the background. Each fires an in-app
   * toast, a system notification when the window is not focused, and (with `notificationSound`)
   * an alert sound.
   */
  notifications: 'off' | 'failures' | 'attention' | 'all'
  notificationSound: boolean
  // ---- cost model ----
  /**
   * Per-route cost overrides, keyed by model id (route id, e.g. "cc/claude-fable-5"). Used to
   * estimate cost on routes the provider doesn't bill for, and to correct the coarse list-price
   * estimate — a route with an override shows an exact cost. Empty by default.
   */
  costOverrides: Record<string, CostRates>
  /**
   * Per-model context-window overrides, keyed by model id (route id), in tokens. Corrects a window a
   * gateway misreports — most often a local endpoint (llama.cpp / vLLM) whose `/v1/models` advertises
   * a generic default (or nothing, so Lattice assumes 128k) when the server actually runs a smaller
   * slot. Applied when models are fetched, so context budgeting, the subagent-model list the main
   * agent sees, tool-output truncation, and the UI all agree on the real window. Empty by default
   * apart from the known local Qwen llama.cpp slot, which runs a 64k (65536-token) window.
   */
  modelContextOverrides: Record<string, number>
  /**
   * Per-model source-group overrides, keyed by model id (route id) → a source key (the model
   * picker's `owned_by` bucket, e.g. "pc5080", "mac"). Reassigns which section a model lists under
   * when the gateway reports a generic runtime backend (`llamacpp`, `vllm`) that hides which rig it
   * actually runs on — e.g. the local Qwen llama.cpp model, which runs on the PC 5080. Applied when
   * models are fetched (it overwrites `owned_by`), so the picker groups it correctly. Empty by
   * default apart from that Qwen model.
   */
  modelSourceOverrides: Record<string, string>
  // ---- delegation ----
  /**
   * Model ids (route ids) the user has marked as subagent models. When a main model delegates with
   * `run_agent`, it may run the subagent on its own model or on any of these — the list is shown to
   * it in the system prompt so it can match the model to the task (a cheap/fast model for bounded
   * searches, a strong one for judgment-heavy work). Anything else is refused. Empty by default,
   * which leaves the main model's own model as the only choice.
   */
  subagentModels: string[]
  // ---- model picker ----
  /**
   * Model ids (route ids) the user has starred as favorites in the model picker. Favorites are
   * surfaced first — a dedicated "Favorites" section leads the picker when no search is active, and
   * a "Favorites" filter narrows to just them — so the handful of models you actually reach for stay
   * one glance away in a list of hundreds. Order is the order they were starred. Distinct from
   * {@link defaultModel} (the single model new threads start on) and {@link subagentModels}.
   */
  favoriteModels: string[]
  // ---- sidebar thread organization ----
  /** how recent threads are organized in the sidebar: flat list, manual folders, or auto buckets */
  sidebarGrouping: SidebarGrouping
  /** which dimension the "Auto" sidebar view groups by */
  autoGroupBy: AutoGroupBy
  /**
   * ping the models the picker leads with (favorites, recents, the current model) when it opens, so
   * a dead route is visible before you select it. On by default. Each ping is a one-token
   * completion — negligible cost, but it IS a real request, so this switch turns it off; the
   * picker's explicit "Check health" button still works when it is off.
   */
  modelHealthPings: boolean
  // ---- composer ----
  /** how the composer sends: Enter sends, or ⌘/Ctrl+Enter sends (Enter inserts a newline) */
  sendKey: 'enter' | 'mod-enter'
  // ---- context orbit thresholds ----
  /**
   * automatically compact a thread's history before a turn once its context passes
   * `compactionThreshold`. On by default. When off, `compactionThreshold` only tints the orbit gauge
   * and the user compacts manually with /compact; `blockThreshold` still hard-stops new turns.
   */
  autoCompact: boolean
  compactionThreshold: number
  blockThreshold: number
  /**
   * prune large tool-result bodies from long-ago turns down to a compact placeholder, reclaiming
   * context while keeping the recent working set intact. On by default; the recent tool results are
   * never touched, so this only bites on genuinely long threads.
   */
  pruneToolResults: boolean
  // ---- runtime guards ----
  /** runaway-loop guard for the main turn loop; 0 (or negative) means no limit */
  maxToolRounds: number
  /** runaway-loop guard for subagent loops; 0 (or negative) means no limit */
  maxSubagentToolRounds: number
  /**
   * how many times to automatically redo a model round when the endpoint fails transiently
   * (rate-limit, 5xx, or a dropped connection) before surfacing the error. 0 disables auto-retry —
   * a failed request surfaces immediately, as it did before this policy existed. Backoff is
   * exponential with jitter and honors a `Retry-After` the endpoint sends.
   */
  maxEndpointRetries: number
  // ---- remote access (iOS / mobile bridge) ----
  /**
   * The network bridge that lets a remote client (the Lattice iOS app) reach this desktop runtime
   * over an authenticated HTTP+WebSocket surface — the same {@link import('./ipc').LatticeApi} the
   * renderer uses, exposed on the wire. Off by default. The password hash and issued device tokens
   * live in the local `meta` table, never in settings, so they are never sent to a remote client.
   */
  remoteAccess: RemoteAccessSettings
}

/** Configuration for the mobile/remote bridge (see {@link AppSettings.remoteAccess}). */
export interface RemoteAccessSettings {
  /** Master switch. When true the bridge binds `127.0.0.1:port` on launch. */
  enabled: boolean
  /** Loopback port the bridge listens on (a local reverse tunnel / cloudflared fronts it publicly). */
  port: number
  /** True once a password has been set (its hash lives in `meta`, never here). Read-only mirror for the UI. */
  hasPassword: boolean
  /** Days an issued device token stays valid before the client must re-authenticate. */
  tokenTtlDays: number
  /** The public URL a remote client should point at, shown in Settings (e.g. https://vmcontroller.pulse-core.com). */
  publicUrl?: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  providers: [],
  defaultModel: 'cc/claude-fable-5',
  defaultEffort: 'high',
  defaultMode: 'act',
  defaultPermissionPreset: 'workspace',
  temperature: null,
  maxOutputTokens: 0,
  customInstructions: '',
  includeMemory: true,
  selfLearning: true,
  selfLearningAutoApprove: true,
  theme: 'graphite',
  density: 'comfortable',
  reasoningVisibility: 'auto',
  telemetryFooter: true,
  notifications: 'attention',
  notificationSound: true,
  costOverrides: {},
  // The local Qwen3.6-35B llama.cpp slot runs a 64k (65536-token) window; its gateway route reports
  // no usable context_length, so seed the real figure. Keyed under both the OmniRoute route id and
  // the bare backend id so it lands however the endpoint is exposed.
  modelContextOverrides: {
    'llamacpp/qwen3.6-35b-a3b': 65536,
    'qwen3.6-35b-a3b': 65536
  },
  // The Qwen llama.cpp model runs on the PC 5080 rig; the gateway reports its backend as the generic
  // "llamacpp", so group it with the other 5080 local models rather than in a "llamacpp" bucket.
  modelSourceOverrides: {
    'llamacpp/qwen3.6-35b-a3b': 'pc5080',
    'qwen3.6-35b-a3b': 'pc5080'
  },
  subagentModels: [],
  favoriteModels: [],
  modelHealthPings: true,
  sidebarGrouping: 'flat',
  autoGroupBy: 'date',
  sendKey: 'enter',
  autoCompact: true,
  compactionThreshold: 0.92,
  blockThreshold: 0.97,
  pruneToolResults: true,
  maxToolRounds: 0,
  maxSubagentToolRounds: 0,
  maxEndpointRetries: 4,
  remoteAccess: {
    enabled: false,
    port: 8973,
    hasPassword: false,
    tokenTtlDays: 30,
    publicUrl: 'https://vmcontroller.pulse-core.com'
  }
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
  /**
   * Set when this message is delivered on behalf of a non-human sender (a background subagent's
   * result, or an inbound session/subagent message). Persisted onto the resulting message so the
   * renderer attributes it rather than drawing a human bubble. Absent for messages the user typed.
   */
  origin?: MessageOrigin
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
