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

export interface ToolContext {
  threadMeta: ThreadMeta
  workspace: WorkspaceMeta
  runId: string
  signal: AbortSignal
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
   * Injected by the run manager for the top-level run: wait for (or, with `wait:false`, poll)
   * background subagents started via `spawnBackgroundAgent`, and read their results. Targets are
   * agent ids or names; omit `agents` to target every background agent. Absent inside a subagent.
   */
  collectAgents?: (opts: { agents?: string[]; wait: boolean }) => Promise<BackgroundAgentStatus[]>
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
