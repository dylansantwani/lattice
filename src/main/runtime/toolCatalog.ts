import type { ThreadId } from '@shared/types'
import type { ToolDefinition } from '../tools/types'
import { mcpTools } from '../mcp/manager'

/**
 * Deferred tool discovery.
 *
 * MCP servers can expose dozens of tools, each with a large JSON schema. Sending every schema in
 * every request bloats the standing context (tens of thousands of tokens with a few servers
 * connected) and re-busts the prompt cache whenever a server reconnects with a slightly different
 * tool list. So MCP tools are DEFERRED: the model gets a small always-loaded core (the builtins)
 * plus one `find_tools` tool, and discovers/loads deferred tools by keyword when a task needs
 * them. Loading is per-thread and append-only — the tools array only ever grows at the end, so
 * the request prefix stays byte-stable (one cache write when a tool loads, stable thereafter).
 *
 * The loaded set lives in memory: an app restart forgets it, and the model simply re-discovers.
 */

/** Ceiling on loaded deferred tools per thread — a runaway discovery loop can't rebuild the bloat. */
export const MAX_LOADED_PER_THREAD = 64
/** How many matches one find_tools call returns (and loads). */
export const FIND_TOOLS_LIMIT = 8

const loadedByThread = new Map<ThreadId, string[]>()

/** Every currently-connected deferred (MCP) tool. */
export function deferredTools(): ToolDefinition[] {
  return mcpTools()
}

/** The deferred tools this thread has loaded, in load order (append-only for cache stability). */
export function loadedDeferredTools(threadId: ThreadId): ToolDefinition[] {
  const names = loadedByThread.get(threadId)
  if (!names || names.length === 0) return []
  const byName = new Map(deferredTools().map((t) => [t.name, t]))
  return names.map((n) => byName.get(n)).filter((t): t is ToolDefinition => !!t)
}

/** Mark tools loaded for a thread. Unknown names are ignored; returns the names newly added. */
export function loadDeferred(threadId: ThreadId, names: string[]): string[] {
  const current = loadedByThread.get(threadId) ?? []
  const known = new Set(deferredTools().map((t) => t.name))
  const added: string[] = []
  for (const name of names) {
    if (current.length + added.length >= MAX_LOADED_PER_THREAD) break
    if (!known.has(name) || current.includes(name) || added.includes(name)) continue
    added.push(name)
  }
  if (added.length) loadedByThread.set(threadId, [...current, ...added])
  return added
}

/** Test / lifecycle helper: forget a thread's loaded set. */
export function clearLoaded(threadId: ThreadId): void {
  loadedByThread.delete(threadId)
}

/** Split a query into lowercased tokens (≥2 chars). */
function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

/**
 * Rank deferred tools against a keyword query: name hits count double, description hits single,
 * server-label hits single. Zero-score tools are dropped. Stable order for equal scores.
 */
export function searchDeferred(query: string, candidates = deferredTools(), limit = FIND_TOOLS_LIMIT): ToolDefinition[] {
  const qs = tokens(query)
  if (qs.length === 0) return []
  const scored = candidates
    .map((tool) => {
      const name = tool.name.toLowerCase()
      const desc = tool.description.toLowerCase()
      const server = (tool.serverLabel ?? '').toLowerCase()
      let score = 0
      for (const q of qs) {
        if (name.includes(q)) score += 2
        if (desc.includes(q)) score += 1
        if (server.includes(q)) score += 1
      }
      return { tool, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.tool)
}

/**
 * The discovery tool itself. Searching LOADS the matches: from the next model call in the run
 * they appear as real callable tools (their schemas join the request). Deliberately cheap and
 * unrestricted (R0 read) — discovery has no side effects; the discovered tools keep their own
 * permission gating when actually called.
 */
export const findToolsTool: ToolDefinition = {
  name: 'find_tools',
  description:
    'Discover more tools. Beyond your core tools, connected integrations (MCP servers) provide ' +
    'additional tools that are not loaded by default. Search by task keywords (e.g. "browser ' +
    'click page", "3d model render", "printer status"); matching tools are LOADED and become ' +
    'directly callable from your next step. Call this whenever a task needs a capability you do ' +
    'not currently see in your tool list.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Task keywords to match against tool names and descriptions.'
      }
    },
    required: ['query']
  },
  resource: 'mcp',
  action: 'read',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: (a) => `Find tools: ${String(a.query ?? '').slice(0, 60)}`,
  async run(args, ctx) {
    const query = String(args.query ?? '').trim()
    if (!query) throw new Error('query is required and must be a non-empty string.')
    const matches = searchDeferred(query)
    const loaded = loadDeferred(ctx.threadMeta.id, matches.map((t) => t.name))
    return {
      found: matches.map((t) => ({
        name: t.name,
        server: t.serverLabel,
        description: t.description.slice(0, 160),
        status: loaded.includes(t.name) ? 'loaded — callable from your next step' : 'already loaded'
      })),
      note:
        matches.length === 0
          ? 'No tools matched. Try different keywords, or the capability may not be connected.'
          : 'The listed tools are now available to call directly.'
    }
  }
}
