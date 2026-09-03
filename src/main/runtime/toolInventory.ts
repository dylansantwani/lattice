import type { McpServerConfig, McpServerStatus, ThreadMeta, ToolInventoryEntry } from '@shared/types'
import type { ToolDefinition } from '../tools/types'

/**
 * The Tools inspector's view of a thread's tool world: every builtin (with the effect the thread's
 * mode/preset gives it — including the ones withheld, which the model never sees but the user
 * should), then every MCP tool with its server's health and whether this thread has loaded it.
 * Pure: the IPC layer feeds it the live sets. Exported for tests.
 */
export function buildToolInventory(input: {
  meta: ThreadMeta
  core: ToolDefinition[]
  deferred: ToolDefinition[]
  loadedNames: Set<string>
  servers: { config: McpServerConfig; status: McpServerStatus }[]
  effectOf: (tool: ToolDefinition, meta: ThreadMeta) => 'allow' | 'ask' | 'deny'
}): ToolInventoryEntry[] {
  const { meta, core, deferred, loadedNames, servers, effectOf } = input
  const byServer = new Map(servers.map((s) => [s.config.id, s]))
  const entries: ToolInventoryEntry[] = core.map((t) => ({
    name: t.name,
    description: t.description,
    source: 'builtin',
    resource: t.resource,
    action: t.action,
    riskTier: t.riskTier,
    effect: effectOf(t, meta),
    parameters: t.parameters
  }))
  for (const t of deferred) {
    const server = t.mcpServerId ? byServer.get(t.mcpServerId) : undefined
    entries.push({
      name: t.name,
      description: t.description,
      source: 'mcp',
      serverId: t.mcpServerId,
      serverLabel: t.serverLabel ?? server?.config.label ?? t.mcpServerId,
      resource: t.resource,
      action: t.action,
      riskTier: t.riskTier,
      effect: effectOf(t, meta),
      loaded: loadedNames.has(t.name),
      healthy: server ? server.status.connected : undefined,
      error: server?.status.error,
      parameters: t.parameters
    })
  }
  return entries
}
