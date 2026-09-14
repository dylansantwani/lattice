import type { PermissionAction, PermissionEffect, PermissionResource, PermissionRule } from '@shared/types'

export class PermissionSpecError extends Error {
  readonly exitCode = 2

  constructor(message: string) {
    super(message)
    this.name = 'PermissionSpecError'
  }
}

export interface PermissionRuleOptions {
  /** Injectable so callers that persist rules can use their usual id generator. */
  createId?: () => string
  /** Injectable for deterministic tests. */
  now?: () => number
}

type ToolPermission = Pick<PermissionRule, 'resource' | 'action'>

const TOOL_PERMISSIONS: Record<string, ToolPermission> = {
  fs_read: { resource: 'filesystem', action: 'read' },
  fs_list: { resource: 'filesystem', action: 'read' },
  grep_search: { resource: 'filesystem', action: 'read' },
  show_image: { resource: 'filesystem', action: 'read' },
  show_image_data: { resource: 'filesystem', action: 'read' },
  read_tool_result: { resource: 'filesystem', action: 'read' },
  search_tool_results: { resource: 'filesystem', action: 'read' },
  fs_write: { resource: 'filesystem', action: 'create' },
  fs_mkdir: { resource: 'filesystem', action: 'create' },
  fs_edit: { resource: 'filesystem', action: 'edit' },
  fs_move: { resource: 'filesystem', action: 'edit' },
  fs_delete: { resource: 'filesystem', action: 'delete' },
  shell: { resource: 'shell', action: 'execute' },
  start_job: { resource: 'shell', action: 'execute' },
  stop_job: { resource: 'shell', action: 'execute' },
  job_status: { resource: 'shell', action: 'read' },
  web_search: { resource: 'network', action: 'read' },
  web_fetch: { resource: 'network', action: 'read' },
  fetch_image: { resource: 'network', action: 'read' },
  find_mcp: { resource: 'mcp', action: 'read' }
}

function permissionForTool(tool: string): ToolPermission | undefined {
  // MCP tool definitions are brokered as resource 'mcp' / action 'execute' (src/main/mcp/manager.ts), and
  // rules match on both — a 'connect' rule here could never allow or deny an actual MCP call.
  if (tool.startsWith('mcp__')) return { resource: 'mcp', action: 'execute' }
  return TOOL_PERMISSIONS[tool]
}

function splitSpec(spec: string): { tool: string; scope?: string } {
  const trimmed = spec.trim()
  if (!trimmed) throw new PermissionSpecError('Tool permission spec cannot be empty.')

  const colon = trimmed.indexOf(':')
  const tool = (colon < 0 ? trimmed : trimmed.slice(0, colon)).trim()
  const scope = colon < 0 ? undefined : trimmed.slice(colon + 1).trim()
  if (!tool) throw new PermissionSpecError(`Invalid tool permission spec ${JSON.stringify(spec)}.`)
  if (colon >= 0 && !scope) throw new PermissionSpecError(`Tool permission scope cannot be empty in ${JSON.stringify(spec)}.`)
  return { tool, scope }
}

/**
 * Converts a CLI tool spec such as `shell:git *` into a thread-scoped rule. Tool names are
 * deliberately resolved here, rather than accepting an arbitrary resource/action pair, so a typo
 * cannot silently become a rule that the approval broker never consults.
 */
export function parsePermissionSpec(
  spec: string,
  effect: Extract<PermissionEffect, 'allow' | 'deny'>,
  options: PermissionRuleOptions = {}
): PermissionRule {
  const { tool, scope } = splitSpec(spec)
  const permission = permissionForTool(tool)
  if (!permission) throw new PermissionSpecError(`Unknown tool in permission spec: ${tool}.`)

  return {
    id: options.createId?.() ?? `cli-rule-${tool}-${Date.now()}`,
    subject: 'main',
    resource: permission.resource as PermissionResource,
    action: permission.action as PermissionAction,
    ...(scope || tool.startsWith('mcp__') ? { scope: scope ?? tool } : {}),
    effect,
    duration: 'thread',
    createdAt: options.now?.() ?? Date.now()
  }
}

export function parsePermissionSpecs(
  allow: readonly string[],
  deny: readonly string[],
  options: PermissionRuleOptions = {}
): PermissionRule[] {
  let index = 0
  const createId = options.createId ?? (() => `cli-rule-${index++}`)
  return [
    ...allow.map((spec) => parsePermissionSpec(spec, 'allow', { ...options, createId })),
    ...deny.map((spec) => parsePermissionSpec(spec, 'deny', { ...options, createId }))
  ]
}
