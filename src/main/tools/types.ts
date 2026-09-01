import type {
  PermissionAction,
  PermissionResource,
  RiskTier,
  ThreadMeta,
  WorkspaceMeta
} from '@shared/types'

export interface ToolContext {
  threadMeta: ThreadMeta
  workspace: WorkspaceMeta
  runId: string
  signal: AbortSignal
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
