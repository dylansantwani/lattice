/**
 * Shared domain types for Lattice.
 * Everything crossing the IPC boundary or persisted in the event store is defined here.
 */

import { DEFAULT_SPEECH_SETTINGS, type SpeechSettings } from './speech'

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
  /** price of a cached (prompt-cache hit) input token, when the provider reports one */
  cachedInputPerMTok?: number
  /** price of a reasoning token, when billed apart from ordinary output */
  reasoningPerMTok?: number
}

/**
 * What a listed model actually produces. `/v1/models` on an aggregating gateway mixes chat models
 * with image generators, TTS voices, embedding and rerank models; only `chat` can take a turn in a
 * thread, so the picker keeps the rest out of the way (still listed, never in the default view).
 */
export type ModelKind = 'chat' | 'image' | 'audio' | 'video' | 'embedding' | 'rerank'

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
  /** What the model produces; absent means `chat` (the only kind a thread can run on). */
  kind?: ModelKind
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
  /** MCP only: whether this thread has loaded the tool's schema into its request (via find_mcp or first use) */
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
  /** DeepSeek thinking-mode output that must be echoed on later tool-bearing requests. */
  reasoning_content?: string | null
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
  /** DeepSeek thinking-mode content for this message's trailing assistant reply. */
  reasoningContent?: string
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
  /**
   * For `user`-role messages: the memory/recent-work block that was recalled for this turn, computed
   * once when the message was sent and PERSISTED so every later request rebuilds the exact same wire
   * text (a block computed fresh each turn and then dropped from history broke provider prefix
   * caching at the previous user message). `''` = computed, nothing recalled; undefined = legacy row.
   */
  recallText?: string
}

/**
 * A running, model-written digest of one thread — goal, what is done, decisions, open items, key
 * references — kept up to date after runs so a NEW conversation can be told what other conversations
 * were about without reading them (see runtime/threadDigest.ts and the `recall_threads` tool).
 */
export interface ThreadDigest {
  threadId: ThreadId
  digest: string
  updatedAt: number
  /** id of the last message the digest covers */
  markId?: string
}

/** One line of a fleet's activity feed: a delegation, a report, or a question between its agents. */
export interface FleetActivityItem {
  id: string
  fromThreadId: ThreadId
  toThreadId: ThreadId
  fromName: string
  toName: string
  body: string
  createdAt: number
  delivery: 'injected' | 'woken' | 'queued'
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
  /**
   * Set on a usage event emitted by a side call rather than the model's answer: memory
   * distillation or auto-titling after the turn, a rolling-context summary, or a vision model
   * describing an image for a model that cannot see. Its tokens are counted (they are real spend
   * on the same run) and shown separately from the answer.
   */
  purpose?: 'distill' | 'title' | 'roll' | 'vision' | 'digest'
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
  // `startedAt` turns this into a SELF-CONTAINED bout rather than the close of a streamed one.
  // Providers split on whether thinking is readable: open-weight routes stream it as
  // `reasoning`/`reasoning_content` deltas, while every closed hosted reasoning model (Claude,
  // gpt-5.6, gemini) reports thinking ONLY as a token count in the final usage block — measured
  // live: claude-sonnet-5 deltas carry `content` and `role` and nothing else. Those rounds have no
  // reasoning text and therefore no bout to close, so the run loop synthesizes one at round end
  // from what it does know: `startedAt` (when the request went out) plus `durationMs` (the silent
  // span before any output) and `tokenCount`. The timeline splices it back into its true position.
  | {
      type: 'reasoning.done'
      fidelity: ReasoningFidelity
      tokenCount?: number
      durationMs?: number
      startedAt?: number
    }
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
      /** Set on a remote-client snapshot when `result` was clipped (see shared/view/compactEvents). */
      truncated?: boolean
      /** The serialized size of the full result when `truncated` is set. */
      fullChars?: number
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
  | 'model_cooldown'
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
  /** Directory the agent treats as its current working directory. */
  cwd?: string
  /** id of parent thread when this is a /side fork */
  parentThreadId?: ThreadId
  parentEventId?: EventId
  /** persistent north-star for the thread, set via /goal; injected into the system prompt */
  goal?: string
  /**
   * This thread backs a {@link AgentProfile} (a fleet orchestrator or worker). It is a real thread —
   * addressable, messageable, openable — but hidden from the regular chat sidebar so the fleet's
   * agents don't clutter the conversation list; the Agent Fleet screen is where they live.
   */
  isAgent?: boolean
  /** id of the user-defined {@link ThreadGroup} this thread was filed under, when any */
  groupId?: string
  lastMessagePreview?: string
  running?: boolean
  /**
   * Marked private by the user: another SESSION (an agent calling `peek_session` / `list_sessions`)
   * sees only that this thread exists and whether it is busy — never its transcript, tool calls, or
   * what it is working on. The user's own windows are unaffected: it is their thread either way.
   */
  isPrivate?: boolean
  /**
   * How replies are written. `texting`: the thread is a personal assistant the owner reaches by text
   * message (the `lattice channels` gateway), so the base prompt is swapped for a short, plain,
   * conversational one (no markdown reports, no checklists, no thread renames). Unset = the normal
   * agent prompt.
   */
  replyStyle?: ReplyStyle
  /** How the thread's history is kept inside the model's window. Unset = grow until auto-compaction. */
  contextPolicy?: ContextPolicy
}

export type ReplyStyle = 'texting'

/**
 * `rolling`: a thread meant to live forever. Once its live history passes `triggerTokens`, the
 * oldest turns are folded into a running summary (and mined for long-term memories) so only about
 * `keepTokens` of recent conversation stays verbatim. See runtime/rollingContext.
 */
export interface ContextPolicy {
  mode: 'rolling'
  triggerTokens: number
  keepTokens: number
}

/** Outcome of folding a thread's older history ({@link LatticeApi.rollThread} or an automatic roll). */
export interface RollResult {
  ok: boolean
  reason?: string
  /** messages folded into the running summary */
  folded?: number
  /** estimated tokens of live history before and after */
  beforeTokens?: number
  afterTokens?: number
  /** long-term memories stored (created or revised) from the folded span */
  memories?: number
  summaryMessageId?: string
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

// ---------- cross-session activity (Slice 9) ----------

/**
 * What a session is doing right now, at a glance:
 *  - `running` — a model turn (or a detached subagent/job) is in flight
 *  - `waiting-approval` — parked on a tool approval nobody has answered
 *  - `waiting-answer` — parked on an `ask_user` question
 *  - `error` — its last run ended in an error
 *  - `idle` — nothing in flight
 *  - `private` — marked private, so its contents are withheld from other sessions
 */
export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'waiting-answer' | 'error' | 'private'

/** One line of another session's live state — the directory row in the activity view. */
export interface SessionActivitySummary {
  threadId: ThreadId
  title: string
  model: string
  mode: Mode
  permissionPreset: PermissionPreset
  status: SessionStatus
  /** short human status ("running · shell", "waiting on you", "idle 20m") */
  statusText: string
  /** one line describing what it is doing right now, when it is doing something */
  activity?: string
  running: boolean
  updatedAt: number
  /** unread inter-session messages waiting in this session's inbox */
  unread: number
  /** background subagents still running on this session */
  agents: number
  /** background shell jobs still running on this session */
  jobs: number
  /** the user marked this thread private: other sessions get status only, never contents */
  isPrivate?: boolean
}

/** One recent turn in another session's transcript, as an observer is allowed to see it. */
export interface ActivityMessage {
  id: MessageId
  role: Role
  createdAt: number
  /** redacted and truncated; never reasoning */
  text: string
  /** true when `text` was cut short */
  truncated?: boolean
  /** set when the turn came from another session/subagent rather than the human */
  from?: string
}

/** One recent tool call in another session, with its arguments summarized rather than dumped. */
export interface ActivityToolCall {
  callId: string
  tool: string
  status: 'running' | 'ok' | 'failed' | 'denied'
  /** the tool's own one-line summary of the call, redacted */
  summary?: string
  startedAt: number
  durationMs?: number
  /** set for a subagent's tool call, so the observer can tell whose work it is */
  agent?: string
}

/**
 * A read-only window onto another live session: status, what it is doing, its recent transcript and
 * tool calls, and anything it is waiting on. Deliberately excludes hidden reasoning entirely and
 * runs every string through secret redaction (see `src/main/runtime/sessionActivity.ts`).
 */
export interface SessionActivity extends SessionActivitySummary {
  goal?: string
  messages: ActivityMessage[]
  tools: ActivityToolCall[]
  pending: {
    approvals: { id: string; tool: string; summary: string; riskTier: RiskTier }[]
    asks: { id: string; question: string; kind: AskKind }[]
  }
  /** when the snapshot was taken */
  observedAt: number
  /** why contents are missing, when they are (a private thread seen by another session) */
  withheld?: string
}

/** How much of another session an *agent* may observe. The user's own UI always sees their threads. */
export type SessionObservationPolicy = 'allow' | 'deny'

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

// ---------- Agent fleets ----------

/** Whether an agent runs the fleet (delegates work out) or does the work it is handed. */
export type AgentKind = 'orchestrator' | 'worker'

/**
 * A named group of dedicated agents: one orchestrator plus its workers. Unlike the ephemeral
 * subagents `run_agent` spawns, a fleet and its agents are PERSISTENT — each agent keeps its own
 * thread, memory scope, working directory and warm context across tasks, so it is never re-briefed.
 * Scoped to a workspace.
 */
export interface Fleet {
  id: string
  workspaceId: WorkspaceId
  name: string
  createdAt: number
  updatedAt: number
}

/**
 * A dedicated agent: a saved role bound to a persistent thread. The agent's model, cwd, mode/preset
 * and rolling {@link ContextPolicy} live on its thread ({@link ThreadMeta}); the profile carries who
 * it is (name, kind, role) and, optionally, which builtin tools it may use. `role` is mirrored into
 * the thread's {@link ThreadMeta.goal}, so it is injected into the agent's system prompt for free.
 */
export interface AgentProfile {
  id: string
  fleetId: string
  /** The agent's persistent thread — its live session, memory scope, cwd and context window. */
  threadId: ThreadId
  name: string
  kind: AgentKind
  /** Persona / mission injected into the agent's system prompt (mirrored to the thread goal). */
  role?: string
  /**
   * Optional allowlist of builtin tool names a WORKER may use. Empty/undefined = inherit the full
   * set its thread's mode/preset grants. The coordination tools (`send_message`, `check_inbox`) and
   * `memory_search` are always kept so a delegated result can flow back and the agent can recall.
   */
  allowedTools?: string[]
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/** An agent joined with its live thread state — the row the Fleet screen renders. */
export interface FleetAgentView extends AgentProfile {
  title: string
  model: string
  /** Reasoning tier carried by the agent's thread (the value sent on its next model request). */
  effort?: string
  mode: Mode
  permissionPreset: PermissionPreset
  cwd?: string
  goal?: string
  /** true when the agent's thread runs a rolling {@link ContextPolicy} (lives forever, self-summarizes). */
  rolling: boolean
  running: boolean
  /** unread inter-agent messages waiting in this agent's inbox (queued tasks) */
  unread: number
  /** live status of the agent's thread (running / waiting on you / idle / error), when known */
  status?: SessionStatus
  /** short human status: "running · shell", "waiting on you", "idle 20m" */
  statusText: string
  /** one line describing what the agent is doing right now, when it is working */
  activity?: string
  /** a short snippet of the agent's latest output — the card's at-a-glance preview */
  preview?: string
  lastActivityAt: number
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
export type MemoryType = 'preference' | 'fact' | 'decision' | 'environment' | 'warning' | 'note' | 'workflow'

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
  /** the import lane found no changed source file and did nothing (the previous report is echoed) */
  skipped?: boolean
  /** write-back: Lattice-authored memories exported into each external store */
  exported: { store: 'claude-code' | 'hermes'; label: string; wrote: number; error?: string; skipped?: boolean }[]
}

/** A pair of stored items the duplicate finder judged to be the same fact (token-set similarity). */
export interface MemoryDuplicatePair {
  a: MemoryItem
  b: MemoryItem
  /** 0..1; 1 = identical or one is a contained rewording of the other */
  score: number
}

export type MemoryBulkAction = 'approve' | 'reject' | 'delete' | 'pin' | 'unpin'

/** What one housekeeping sweep did (see eventStore.sweepMemory). */
export interface MemorySweepReport {
  /** approved rows past their horizon flipped to `expired` */
  expired: number
  /** model-authored rows never used/reviewed in the low-value window, flipped to `expired` */
  retired: number
  deletedRejected: number
  deletedExpired: number
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
  /** last time recall (`memory_search`) surfaced this item to the model */
  lastUsedAt?: number
  /** horizon after which the item leaves the prompt/recall (flipped to `expired` by the sweep) */
  expiresAt?: number
  /** when a human explicitly approved/pinned/edited it — the gate for exporting a model-authored item to other agents */
  reviewedAt?: number
  /** how many times recall has surfaced it (the reinforcement signal for ranking and retirement) */
  useCount: number
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
  /**
   * Per-model reasoning tier, overriding {@link defaultEffort} for the models it matches. Keys are
   * shell-style globs over the model id (`claude-sonnet-5`, `*claude*`, `openrouter/*`); the most
   * specific match wins. A single global tier is wrong across models with very different thinking
   * costs — `high` on a local model is nearly free, `high` on a hosted Claude route costs seconds
   * of time-to-first-token. Applied when a thread is created and when its model is switched while
   * it still carries the tier it inherited; see `runtime/effortDefaults`.
   */
  defaultEffortByModel?: Record<string, string>
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
  /**
   * per-turn recall: fetch the memories most relevant to each new turn and prepend them to the
   * user message (bounded, cache-friendly — never in the system prompt). Off ⇒ memory_search only.
   */
  memoryAutoRecall: boolean
  /** after each run, distill durable memories from the exchange (self-learning) */
  selfLearning: boolean
  /**
   * when self-learning, store high-confidence, non-sensitive learnings as `approved`
   * (so they inject and export to Claude Code + Hermes immediately) instead of `proposed`
   * (which wait for review in the Memory tab)
   */
  selfLearningAutoApprove: boolean
  /**
   * When the rule-based per-run pass finds nothing in a substantial exchange, run one model
   * extraction on the utility model (throttled per thread). Default true. Off = rules only.
   */
  selfLearningModelExtraction?: boolean
  /**
   * The model housekeeping passes run on — memory distillation and thread titling — when set;
   * empty/undefined means the thread's own model. Lets an Opus-class thread do its reflection on
   * a cheap or local model: the question those passes answer is small and, per the distiller's own
   * prompt, usually "nothing".
   */
  utilityModel?: string
  /**
   * The model that looks at images for threads whose own model cannot (DeepSeek, most local
   * models): photos the user attaches and screenshots tools return are described once by this
   * model and the text description rides in their place. Empty = pick a vision model automatically
   * (a vision sibling of the thread's model on the same provider first).
   */
  visionModel?: string
  /**
   * How much standing context requests carry: `full` (every tool, the complete base prompt), `lean`
   * (the tools a single model can use, compact schemas, a condensed prompt), or `auto` — lean for
   * models running on the user's own hardware, full otherwise. See runtime/contextProfile.
   */
  contextProfile?: 'auto' | 'full' | 'lean'
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
  // ---- voice ----
  /** Text-to-speech: read replies aloud (see `shared/speech`). */
  speech: SpeechSettings
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
   * whether an agent in one session may read another session's live activity (`peek_session`, and
   * the status/activity line in `list_sessions`). `allow` by default — every session belongs to the
   * same person, and observation is read-only, reasoning-free and secret-redacted. `deny` turns the
   * agent lane off entirely; the user's own activity view is unaffected either way. Individual
   * threads can be marked private ({@link ThreadMeta.isPrivate}) without changing this.
   */
  sessionObservation: SessionObservationPolicy
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
  /**
   * Give runs a head start instead of paying discovery round-trips: inject the workspace primer
   * into the main thread's system prompt and auto-attach the contents of files a user message
   * explicitly names (see prefetch.ts). On unless explicitly set false; no UI yet.
   */
  prefetchContext?: boolean
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
  // OpenRouter's free router chooses an available $0 model for each request. It is the safest
  // out-of-box default: a fresh Lattice install no longer starts every thread on a paid/subscription
  // route. Existing installs on the former untouched default are migrated once by eventStore.
  defaultModel: 'openrouter/free',
  defaultEffort: 'high',
  defaultMode: 'act',
  defaultPermissionPreset: 'workspace',
  temperature: null,
  maxOutputTokens: 0,
  customInstructions: '',
  includeMemory: true,
  memoryAutoRecall: true,
  selfLearning: true,
  selfLearningAutoApprove: true,
  selfLearningModelExtraction: true,
  theme: 'graphite',
  density: 'comfortable',
  reasoningVisibility: 'auto',
  telemetryFooter: true,
  notifications: 'attention',
  notificationSound: true,
  speech: { ...DEFAULT_SPEECH_SETTINGS },
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
  sessionObservation: 'allow',
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

/**
 * What the transcript's retry action should do with an interrupted or errored reply:
 * `resume` continues it from where it stopped (keeping its text and completed tool calls),
 * `restart` discards it and runs the user's turn again, `auto` resumes when there is something to
 * resume and restarts otherwise.
 */
export type RetryMode = 'auto' | 'resume' | 'restart'

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
  /** Server-authored usage guidance returned by MCP initialize. */
  instructions?: string
  tools: { name: string; description?: string; schema?: unknown }[]
  error?: string
}

// ---------- turn summaries (remote clients) ----------

/**
 * A settled assistant turn, pre-folded for a client that renders it without the event log: the
 * flow the desktop transcript shows (prose, one-line activity blocks with their steps, subagent
 * cards), computed on the desktop from the run's events. A phone opening a thread fetches these
 * instead of thousands of raw events; only a run that is still live streams events.
 */
export type TurnStepStatus = 'drafting' | 'running' | 'complete' | 'failed' | 'blocked' | 'interrupted'

export interface TurnStep {
  kind: 'tool' | 'thought' | 'notice'
  callId?: string
  /** What was done — "Ran", "Read", the command's own purpose — or the thought/notice label. */
  verb: string
  /** The thing it was done to — a command, a path, a query. */
  subject?: string
  /** The subject is code-like and renders monospace. */
  mono?: boolean
  /** MCP server tag, when the tool belongs to one. */
  server?: string
  status: TurnStepStatus
  /** The right-hand outcome text: "failed", "denied", "exit 2", a duration. */
  side?: string
  durationMs?: number
  /** Lines added/removed by a file edit. */
  added?: number
  removed?: number
  /** A thought's text (clipped) when the model streamed it. */
  text?: string
}

export interface TurnImage {
  /** data: URL */
  url: string
  caption?: string
}

export type TurnFlowNode =
  | { kind: 'prose'; text: string }
  | {
      kind: 'activity'
      /** "Ran 4 commands, edited Transcript.tsx, thought 21s" */
      summary: string
      status: 'running' | 'complete' | 'failed' | 'interrupted'
      failed: number
      calls: number
      durationMs: number
      steps: TurnStep[]
      /** Images a step produced that the reader must see even when the block is folded. */
      images?: TurnImage[]
    }
  | {
      kind: 'agent'
      callId: string
      name: string
      role?: string
      status: string
      /** The agent's report, clipped. */
      report?: string
    }

export interface TurnSummary {
  runId: RunId
  model?: string
  status: 'complete' | 'failed' | 'interrupted' | 'running'
  flow: TurnFlowNode[]
  error?: { category: ErrorCategory; message: string }
  /** Number of raw events the summary stands in for (so a client can size an on-demand fetch). */
  eventCount: number
}

/** `getThreadView` result: what a remote client needs to show a thread, without the event log. */
export interface ThreadView {
  meta: ThreadMeta
  /** The last `messageLimit` messages, oldest first, with replay-only fields stripped. */
  messages: ChatMessage[]
  /** One summary per settled run behind the returned assistant messages, keyed by run id. */
  turns: Record<RunId, TurnSummary>
  /** Compact events for the run that is still live (empty when nothing is running). */
  events: RunEvent[]
  /** True when older messages exist beyond `messages`. */
  hasMore: boolean
}
