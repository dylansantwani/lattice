import type { ThreadId } from '@shared/types'
import type { ToolDefinition } from '../tools/types'
import { mcpStatuses, mcpTools } from '../mcp/manager'
import { clearThreadTools, listThreadTools, saveThreadTools } from '../store/eventStore'

/**
 * Deferred tool discovery.
 *
 * MCP servers can expose dozens of tools, each with a large JSON schema. Sending every schema in
 * every request bloats the standing context (tens of thousands of tokens with a few servers
 * connected) and re-busts the prompt cache whenever a server reconnects with a slightly different
 * tool list. So MCP tools are DEFERRED: the model gets a small always-loaded core (the builtins)
 * plus one `find_mcp` tool and a compact list of connected MCP servers. The model selects a server
 * and loads that MCP's complete tool surface at once. Loading is per-thread and append-only — the
 * tools array only ever grows at the end, so the request prefix stays byte-stable (one cache write
 * when an MCP loads, stable thereafter).
 *
 * The loaded set is persisted per thread (the `thread_tools` table) and cached here. It has to
 * survive a relaunch: the transcript keeps referencing the loaded tools by name, so on the next
 * turn the model calls them directly — and a set that had been forgotten turned every one of
 * those calls into a bogus "unavailable under the current mode" denial. The same holds for a
 * model that already knows an integration's tool names (Claude models know the `mcp__server__tool`
 * convention from Claude Code) and skips `find_mcp` altogether: a call to a known-but-unloaded
 * deferred tool loads it on the spot (see {@link resolveDeferred}) instead of being refused.
 */

/** Ceiling on loaded deferred tools per thread — a runaway discovery loop can't rebuild the bloat. */
export const MAX_LOADED_PER_THREAD = 64
const MCP_LOAD_PREFIX = '@mcp:'

/** Write-through cache over the `thread_tools` table; a thread is hydrated on first access. */
const loadedByThread = new Map<ThreadId, string[]>()

function loadedNames(threadId: ThreadId): string[] {
  let names = loadedByThread.get(threadId)
  if (!names) {
    names = listThreadTools(threadId)
    loadedByThread.set(threadId, names)
  }
  return names
}

/** Every currently-connected deferred (MCP) tool. */
export function deferredTools(): ToolDefinition[] {
  return mcpTools()
}

/** The deferred tools this thread has loaded, in load order (append-only for cache stability). */
export function loadedDeferredTools(threadId: ThreadId): ToolDefinition[] {
  const names = loadedNames(threadId)
  if (names.length === 0) return []
  const available = deferredTools()
  const byName = new Map(available.map((t) => [t.name, t]))
  const loaded: ToolDefinition[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const expanded = name.startsWith(MCP_LOAD_PREFIX)
      ? available.filter((tool) => tool.mcpServerId === name.slice(MCP_LOAD_PREFIX.length))
      : [byName.get(name)].filter((tool): tool is ToolDefinition => !!tool)
    for (const tool of expanded) {
      if (seen.has(tool.name)) continue
      seen.add(tool.name)
      loaded.push(tool)
    }
  }
  return loaded
}

/** True when the thread has hit {@link MAX_LOADED_PER_THREAD}. */
export function loadedSetFull(threadId: ThreadId): boolean {
  return loadedDeferredTools(threadId).length >= MAX_LOADED_PER_THREAD
}

/** Mark tools loaded for a thread. Unknown names are ignored; returns the names newly added. */
export function loadDeferred(threadId: ThreadId, names: string[]): string[] {
  const current = loadedNames(threadId)
  const currentTools = new Set(loadedDeferredTools(threadId).map((tool) => tool.name))
  const known = new Set(deferredTools().map((t) => t.name))
  const added: string[] = []
  for (const name of names) {
    if (currentTools.size + added.length >= MAX_LOADED_PER_THREAD) break
    if (!known.has(name) || currentTools.has(name) || current.includes(name) || added.includes(name)) continue
    added.push(name)
  }
  if (added.length) {
    const next = [...current, ...added]
    loadedByThread.set(threadId, next)
    saveThreadTools(threadId, next)
  }
  return added
}

/** Load a complete MCP by one durable server marker. Unlike ad-hoc direct-name loading, an
 * explicit find_mcp selection is not partially clipped at the individual-tool ceiling: the user
 * asked for this server's whole schema, and tools added by the server later should join it too. */
export function loadMcp(threadId: ThreadId, serverId: string): boolean {
  if (!deferredTools().some((tool) => tool.mcpServerId === serverId)) return false
  const current = loadedNames(threadId)
  const marker = MCP_LOAD_PREFIX + serverId
  if (current.includes(marker)) return false
  const next = [...current, marker]
  loadedByThread.set(threadId, next)
  saveThreadTools(threadId, next)
  return true
}

/** Forget a thread's loaded set (thread deleted or its transcript cleared). */
export function clearLoaded(threadId: ThreadId): void {
  loadedByThread.delete(threadId)
  clearThreadTools(threadId)
}

/** Test helper: drop the in-memory cache only, as a relaunch would, leaving the persisted set. */
export function resetCatalogCache(): void {
  loadedByThread.clear()
}

/**
 * Why a call to `name` did not resolve to a loaded tool, when the name is not a loaded deferred
 * tool. `deferred` is the connected-but-unloaded tool (load it and go); the other outcomes carry
 * a message that tells the model precisely what to do next instead of a blanket "unavailable".
 */
export type DeferredResolution =
  | { kind: 'deferred'; tool: ToolDefinition }
  | { kind: 'full'; message: string }
  | { kind: 'unknown'; message: string }

const MCP_NAME = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/

/**
 * Resolve a tool name the model called that is not in its loaded set. A connected deferred tool
 * is loaded for the thread right here — the model clearly knows the tool it wants, and making it
 * round-trip through `find_mcp` (or worse, refusing it) only burns a turn. Loading is the same
 * append-only, persisted operation `find_mcp` performs, so the request stays cache-stable.
 */
export function resolveDeferred(threadId: ThreadId, name: string): DeferredResolution {
  const tool = deferredTools().find((t) => t.name === name)
  if (tool) {
    if (loadDeferred(threadId, [name]).length === 0 && !loadedDeferredTools(threadId).some((t) => t.name === name)) {
      return {
        kind: 'full',
        message:
          `Tool ${name} exists but this thread already has ${MAX_LOADED_PER_THREAD} integration tools ` +
          'loaded, the maximum. Start a new thread to use it.'
      }
    }
    return { kind: 'deferred', tool }
  }
  const m = MCP_NAME.exec(name)
  if (m) {
    const [, serverId, toolName] = m
    const server = mcpStatuses().find((s) => s.config.id === serverId)
    if (!server) {
      return {
        kind: 'unknown',
        message:
          `Unknown tool ${name}: no integration named "${serverId}" is configured. Call find_mcp ` +
          'with one of the listed MCP server ids to load the integration that is actually available.'
      }
    }
    if (!server.config.enabled) {
      return {
        kind: 'unknown',
        message:
          `Tool ${name} is unavailable: the "${server.config.label}" integration is disabled in Settings. ` +
          'Ask the user to enable it, or use a different approach.'
      }
    }
    if (!server.status.connected) {
      return {
        kind: 'unknown',
        message:
          `Tool ${name} is unavailable: the "${server.config.label}" integration is not connected` +
          (server.status.error ? ` (${server.status.error})` : '') +
          '. Ask the user to check the integration in Settings, or use a different approach.'
      }
    }
    return {
      kind: 'unknown',
      message:
        `Unknown tool ${name}: the "${server.config.label}" integration is connected but provides no tool ` +
        `named "${toolName}". Call find_mcp with that server id to load and inspect all of its tools.`
    }
  }
  return {
    kind: 'unknown',
    message:
      `Unknown tool ${name}. It is not one of your core tools and no connected integration provides ` +
      'it. Call find_mcp with one of the listed MCP server ids to load its integration tools.'
  }
}

export interface McpCatalogEntry {
  id: string
  label: string
  description: string
  tools: ToolDefinition[]
}

/** One compact entry per connected MCP. Prefer the server's own initialize instructions; older
 * servers commonly omit them, so fall back to a short description synthesized from their tools. */
export function mcpCatalog(candidates = deferredTools()): McpCatalogEntry[] {
  const statuses = new Map(mcpStatuses().map((server) => [server.config.id, server]))
  const grouped = new Map<string, ToolDefinition[]>()
  for (const tool of candidates) {
    if (!tool.mcpServerId) continue
    const group = grouped.get(tool.mcpServerId) ?? []
    group.push(tool)
    grouped.set(tool.mcpServerId, group)
  }
  return [...grouped.entries()].map(([id, tools]) => {
    const status = statuses.get(id)
    const label = status?.config.label ?? tools[0]?.serverLabel ?? id
    const instructions = status?.status.instructions?.replace(/\s+/g, ' ').trim()
    const samples = tools.slice(0, 3).map((tool) => {
      const prefix = `[${label}] `
      return tool.description.startsWith(prefix) ? tool.description.slice(prefix.length) : tool.description
    })
    const fallback = `Provides ${tools.length} tool${tools.length === 1 ? '' : 's'}${samples.length ? `: ${samples.join('; ')}` : ''}.`
    return { id, label, description: (instructions || fallback).slice(0, 500), tools }
  })
}

/** First sentence of a tool description, capped — enough to tell tools apart in a listing. */
export function toolGist(description: string | undefined, max = 120): string {
  const text = (description ?? '').replace(/\s+/g, ' ').trim()
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence
}

/**
 * The discovery tool itself. Selecting an MCP loads all of its tools: from the next model call in
 * the run they appear as real callable tools (their schemas join the request). Deliberately cheap
 * and unrestricted (R0 read) — discovery has no side effects; the loaded tools keep their own
 * permission gating when actually called.
 */
export function findMcpTool(): ToolDefinition {
  const mcps = mcpCatalog()
  const listing = mcps.map((mcp) => `- ${mcp.id} (${mcp.label}): ${mcp.description}`).join('\n')
  return {
    name: 'find_mcp',
    description:
      'Load every tool schema from one connected MCP server. MCP tools are grouped by server rather ' +
      'than exposed individually until you select the relevant MCP. After this call, all tools from ' +
      'that MCP become directly callable on your next step.\nAvailable MCP servers:\n' + listing,
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          enum: mcps.map((mcp) => mcp.id),
          description: 'Exact MCP server id from the available MCP server list.'
        }
      },
      required: ['server']
    },
    resource: 'mcp',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Load MCP: ${String(a.server ?? '').slice(0, 60)}`,
    async run(args, ctx) {
      const requested = String(args.server ?? '').trim()
      if (!requested) throw new Error('server is required and must be an MCP server id from the list.')
      const current = mcpCatalog()
      const match = current.find(
        (mcp) =>
          mcp.id === requested ||
          mcp.id.toLowerCase() === requested.toLowerCase() ||
          mcp.label.toLowerCase() === requested.toLowerCase()
      )
      if (!match)
        throw new Error(
          `Unknown or unavailable MCP server "${requested}". Choose one of: ` +
            `${current.map((mcp) => mcp.id).join(', ') || '(none)'}.`
        )
      const added = loadMcp(ctx.threadMeta.id, match.id)
      return {
        mcp: { id: match.id, label: match.label, description: match.description },
        // Names and a one-line gist only: the full descriptions and schemas arrive with the tools
        // themselves on the next request, and repeating them here paid for every loaded MCP twice
        // (latchkey's batch description alone is ~7K chars).
        tools: match.tools.map((tool) => ({ name: tool.name, description: toolGist(tool.description) })),
        status: added ? 'loaded' : 'already loaded',
        note: `All ${match.tools.length} tool schemas from this MCP are available to call directly on your next step.`
      }
    }
  }
}
