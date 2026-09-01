import type {
  AskKind,
  AskResponse,
  PermissionAction,
  PermissionResource,
  RiskTier,
  ThreadMeta,
  WorkspaceMeta
} from '@shared/types'

/** What the `ask_user` tool asks the run manager to put to the user. */
export interface AskSpec {
  question: string
  kind: AskKind
  options?: string[]
  placeholder?: string
  multiline?: boolean
}

/** What the `run_agent` tool asks the run manager to spawn. */
export interface SubagentSpec {
  task: string
  /**
   * The parent model's chosen name for this subagent (e.g. "scout", "test-writer"). Shown in
   * the sidebar and used as the handle for message_agent / collect_agent. Optional — the run
   * manager assigns a unique fallback ("agent-1", …) when omitted or when it collides.
   */
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
}

/** A subagent's public state, as the parent model sees it through the agent tools. */
export interface SubagentView {
  agentId: string
  name: string
  status: string
  toolCalls: number
  /** the tail of the subagent's most recent output, for a one-line status */
  lastLine?: string
}

/** Result of collecting a subagent's output. */
export interface SubagentCollect {
  ok: boolean
  agentId?: string
  name?: string
  status?: string
  /** the subagent's accumulated answer so far (or final, when done) */
  result?: string
  toolCalls?: number
  error?: string
}

/**
 * The concurrent-subagent control surface handed to the top-level run's tools. Spawning does NOT
 * block: `spawn` returns a handle immediately and the subagent runs in the background, streaming
 * its own events. The parent then talks to it with `message`, reads it with `collect`, and can
 * `stop` it. Absent inside a subagent (subagents cannot manage other agents).
 */
export interface AgentsApi {
  /** Start a subagent in the background; returns its assigned id + name right away. */
  spawn(spec: SubagentSpec): { agentId: string; name: string; status: string }
  /** Deliver a message to a running/idle subagent (by name or id); wakes it if idle. */
  message(ref: string, text: string): { ok: boolean; agentId?: string; name?: string; status?: string; error?: string }
  /** Read a subagent's output. When `wait`, resolves once it settles (idle or finished). */
  collect(ref: string, wait: boolean): Promise<SubagentCollect>
  /** List this run's subagents and their live status. */
  list(): SubagentView[]
  /** Stop a subagent (aborts its work). */
  stop(ref: string): { ok: boolean; name?: string; error?: string }
}

export interface ToolContext {
  threadMeta: ThreadMeta
  workspace: WorkspaceMeta
  runId: string
  signal: AbortSignal
  /**
   * Injected by the run manager for the top-level run: spawn and manage isolated, concurrent
   * subagents that share this run's tool access and stream their own tagged events into the
   * transcript. Absent inside a subagent (subagents cannot spawn or manage other agents).
   */
  agents?: AgentsApi
  /**
   * Injected by the run manager for the top-level run: pause the run and put a
   * question to the user, resolving with their answer. Absent inside a subagent
   * (subagents run headless and must not block on user input).
   */
  ask?: (spec: AskSpec) => Promise<AskResponse>
}

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
   * roots. Defaults to `['path']` for filesystem tools; set it for multi-path tools
   * such as move/rename where both endpoints must be contained.
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
