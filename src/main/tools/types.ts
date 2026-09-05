import type {
  AskKind,
  AskOption,
  AskResponse,
  PermissionAction,
  PermissionResource,
  RiskTier,
  ThreadMeta,
  TurnTelemetry,
  WorkspaceMeta
} from '@shared/types'

/** What the `ask_user` tool asks the run manager to put to the user. */
export interface AskSpec {
  question: string
  kind: AskKind
  options?: AskOption[]
  placeholder?: string
  multiline?: boolean
}

/** What the `run_agent` tool asks the run manager to spawn. */
export interface SubagentSpec {
  task: string
  /** short human-readable name the parent model gives this agent, shown in the live agents panel */
  name?: string
  /** free-form role label, surfaced in the transcript (e.g. "researcher") */
  agentType?: string
  /** override the parent thread's model / effort for the sub-run */
  model?: string
  effort?: string
  /**
   * Optional allowlist of tool names the subagent may use. When omitted, the subagent
   * inherits the parent's full tool set (minus the tools it can never have). When present,
   * its tools are narrowed to this list — letting the caller hand a subagent only what its
   * task needs. Names the current mode/preset denies are never granted regardless.
   */
  tools?: string[]
  /**
   * Internal: the callId of the `run_agent` tool call that requested this spawn. Stamped onto the
   * subagent's `run.started` event so the transcript can attach its live activity to that row.
   * Not model-facing — the tool fills it from {@link ToolContext.callId}.
   */
  parentCallId?: string
}

export interface SubagentResult {
  /** the subagent's final answer, returned to the caller as the tool result */
  text: string
  agentId: string
  toolCalls: number
  /** the tool names the subagent actually ran with, after allowlist + mode/preset filtering */
  toolNames: string[]
  telemetry?: TurnTelemetry
}

/** A snapshot of one background subagent, returned by `collectAgents` / the `agent_result` tool. */
export interface BackgroundAgentStatus {
  agentId: string
  name?: string
  status: 'running' | 'done' | 'error'
  /** the subagent's final answer — present once status is 'done' */
  result?: string
  toolCalls?: number
  tools?: string[]
  /** failure message — present once status is 'error' */
  error?: string
}

/**
 * A live, read-only glance at one background subagent — what it is doing RIGHT NOW — returned by
 * `peekAgents` / the `peek_agents` tool. Unlike {@link BackgroundAgentStatus} it never consumes the
 * agent: a still-running agent keeps going and a finished one is still auto-delivered as its own turn.
 */
export interface AgentPeek {
  agentId: string
  name?: string
  status: 'running' | 'done' | 'error'
  /** ms the subagent has been alive */
  elapsedMs: number
  /** ms since its last observable activity (a stuck agent shows a large value) */
  idleMs: number
  /** tool calls it has completed so far */
  toolCalls: number
  /** the tool it is executing this instant, if any */
  currentTool?: string
  /** one-line description of what it is doing now (e.g. "running grep", "thinking", "finished") */
  activity: string
  /** tail of the latest text it has produced — omitted until it has written something */
  preview?: string
  /** the final answer, once done (also still delivered on its own) */
  result?: string
  /** failure message, once errored */
  error?: string
}

export interface ToolContext {
  threadMeta: ThreadMeta
  workspace: WorkspaceMeta
  /**
   * The model this run actually calls the provider with: a subagent's chosen model inside a subagent
   * (which may differ from the thread's own model), else the thread's model. Tool-output truncation
   * scales to THIS model's context window, so a subagent on a small local model gets smaller results
   * than the same tool would return for a large-context main agent. Falls back to `threadMeta.model`.
   */
  effectiveModel?: string
  runId: string
  /** The id of the tool call being executed (the `callId` on its tool.* events). */
  callId?: string
  signal: AbortSignal
  /**
   * Report a running tool's live output (a foreground shell command's PTY buffer so far) to the
   * transcript, where the tool row's dropdown shows it as it happens. The tool throttles; each call
   * replaces the previous snapshot. Absent where nothing renders it.
   */
  progress?: (output: string) => void
  /**
   * Injected by the run manager for the top-level run: spawn an isolated subagent that
   * shares this run's tool access and streams its own tagged events into the transcript.
   * Absent inside a subagent (subagents cannot spawn further subagents).
   */
  runSubagent?: (spec: SubagentSpec) => Promise<SubagentResult>
  /**
   * Injected by the run manager for the top-level run: pause the run and put a
   * question to the user, resolving with their answer. Absent inside a subagent
   * (subagents run headless and must not block on user input).
   */
  ask?: (spec: AskSpec) => Promise<AskResponse>
  /**
   * Injected by the run manager for the top-level run: start a subagent that runs CONCURRENTLY in
   * the background and return a handle immediately, instead of blocking until it finishes. The
   * parent can keep working — or park on `ask` to hand control back to the user — while it runs,
   * then read its result later via `collectAgents`. Absent inside a subagent.
   */
  spawnBackgroundAgent?: (spec: SubagentSpec) => { agentId: string; name?: string }
  /**
   * Injected by the run manager for the top-level run: the model ids a `run_agent` call may pass as
   * `model` — the thread's own model plus the models the user designated as subagent models in
   * Settings. `run_agent` refuses any other id up front (naming the choices) instead of letting the
   * subagent fail at the gateway. Absent inside a subagent.
   */
  subagentModels?: string[]
  /**
   * Injected by the run manager for the top-level run: wait for (or, with `wait:false`, poll)
   * background subagents started via `spawnBackgroundAgent`, and read their results. Targets are
   * agent ids or names; omit `agents` to target every background agent. Absent inside a subagent.
   */
  collectAgents?: (opts: { agents?: string[]; wait: boolean }) => Promise<BackgroundAgentStatus[]>
  /**
   * Injected by the run manager for the top-level run: a synchronous, read-only glance at the live
   * progress of background subagents — what each is doing right now — without blocking and without
   * consuming any result (a finished agent is still auto-delivered as its own turn). Targets are
   * agent ids or names; omit `agents` to peek at all of them. Absent inside a subagent.
   */
  peekAgents?: (opts: { agents?: string[] }) => AgentPeek[]
  /**
   * Set when the CALLER is itself a subagent (not a top-level thread run). Identifies it for
   * messaging: `check_inbox` reads its own (empty — messages arrive live) mailbox rather than the
   * parent thread's, and `send_message` addresses it as the subagent, letting it message the thread
   * it runs under and its siblings. Absent for a top-level run.
   */
  agentIdentity?: { agentId: string; name?: string; parentThreadId: string }
  /**
   * Injected by the run manager for the top-level run: register a background shell job so the run
   * manager pings the thread with its output when it finishes — the notify-on-completion lane,
   * mirroring `spawnBackgroundAgent`. `kind` says how the job got there: `background` for one the
   * model started deliberately (`start_job` / `shell(background:true)`), `timeout` for a foreground
   * command that outran its timeout and was promoted instead of killed. The `jobId` is the bgJobs
   * job (visible to `job_status`/`stop_job`). Absent inside a subagent, where a long command falls
   * back to the plain "kill on timeout" behaviour and background jobs are refused.
   */
  promoteShellToBackground?: (info: { jobId: string; command: string; kind: 'background' | 'timeout'; purpose?: string }) => void
  /**
   * Injected by the run manager for the top-level run: mark background shell jobs the model has just
   * read to completion itself (via `job_status`) as delivered, so the auto-ping does not ALSO push
   * their result back as a separate turn. A no-op for jobs that are not tracked for a ping.
   */
  claimShellJobsDelivery?: (jobIds: string[]) => void
  /**
   * The live subagents this caller can address by id or name — a top-level run's own background
   * subagents, or a subagent's siblings. Injected by the run manager; used by `list_sessions` to
   * surface addressable agents alongside sessions.
   */
  listAgentPeers?: () => AgentPeer[]
  /**
   * Deliver a message to a live subagent peer (by id or name), folding it into that agent's run at
   * its next tool boundary. Returns `null` when no agent matches (so `send_message` falls through to
   * resolving the target as a session/thread), otherwise the delivery outcome. The sender identity
   * is fixed by the run manager from the caller — it cannot be spoofed via arguments.
   */
  messageAgentPeer?: (target: string, body: string) => AgentDeliveryResult | null
}

/** A live subagent surfaced as an addressable messaging peer. */
export interface AgentPeer {
  agentId: string
  name?: string
  status: 'running' | 'done' | 'error'
}

export type AgentDeliveryResult =
  | { ok: true; agentId: string; name?: string }
  | { ok: false; error: string }

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the arguments object */
  parameters: Record<string, unknown>
  resource: PermissionResource
  action: PermissionAction
  riskTier: RiskTier
  /** false → tool is stripped from the active set in Plan mode */
  allowedInPlan: boolean
  /**
   * Names of the string arguments that carry filesystem paths. The broker validates
   * each one is a string and (outside the `full` preset) resolves inside the workspace
   * roots. When omitted, a filesystem tool that declares a `path` parameter defaults to
   * `['path']`; a filesystem tool with no `path` (store-backed tools like `memory_*`,
   * `todo_write`) defaults to no path check. Set it explicitly for multi-path tools such
   * as move/rename where both endpoints must be contained (e.g. `['from','to']`).
   */
  pathArgs?: string[]
  /** set when this tool is provided by an MCP server, not a built-in */
  mcpServerId?: string
  /** friendly server label for display, when mcpServerId is set */
  serverLabel?: string
  /** short human-readable line for the approval sheet */
  summarize(args: Record<string, unknown>): string
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>
}

export interface ToolResultEnvelope {
  ok: boolean
  result?: unknown
  error?: string
  canceled?: boolean
}
