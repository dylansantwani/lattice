import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadMeta } from '@shared/types'
import type { ToolContext, ToolDefinition } from '../tools/types'

// Fake MCP registry, mutable per test. Mocked BEFORE importing the catalog/runManager so both
// see the same fake through the module graph.
const fakeMcp: ToolDefinition[] = []
vi.mock('../mcp/manager', () => ({ mcpTools: () => fakeMcp }))

const { clearLoaded, findToolsTool, loadDeferred, loadedDeferredTools, searchDeferred, MAX_LOADED_PER_THREAD } =
  await import('./toolCatalog')
const { availableTools, describeTools } = await import('./runManager')

const mcpTool = (name: string, description: string, server = 'browser'): ToolDefinition => ({
  name,
  description,
  parameters: { type: 'object', properties: {} },
  resource: 'mcp',
  action: 'execute',
  riskTier: 'R2',
  allowedInPlan: false,
  mcpServerId: server,
  serverLabel: server,
  summarize: () => name,
  run: async () => ({})
})

const meta = (over: Partial<ThreadMeta> = {}): ThreadMeta =>
  ({
    id: 'thread-1',
    workspaceId: 'w',
    mode: 'act',
    permissionPreset: 'workspace',
    ...over
  }) as ThreadMeta

beforeEach(() => {
  fakeMcp.length = 0
  clearLoaded('thread-1')
})

describe('searchDeferred', () => {
  it('ranks name matches above description matches and drops zero-score tools', () => {
    fakeMcp.push(
      mcpTool('page_screenshot', 'capture the current page'),
      mcpTool('navigate', 'open a url in the browser page'),
      mcpTool('printer_status', 'read the 3d printer state', 'bambu')
    )
    const out = searchDeferred('page').map((t) => t.name)
    expect(out[0]).toBe('page_screenshot') // name hit outranks description hit
    expect(out).toContain('navigate')
    expect(out).not.toContain('printer_status')
  })

  it('returns nothing for an empty or stopword-length query', () => {
    fakeMcp.push(mcpTool('navigate', 'open a url'))
    expect(searchDeferred('')).toEqual([])
    expect(searchDeferred('a')).toEqual([])
  })
})

describe('loadDeferred / loadedDeferredTools', () => {
  it('appends in load order, dedupes, and ignores unknown names', () => {
    fakeMcp.push(mcpTool('b_tool', 'x'), mcpTool('a_tool', 'x'))
    expect(loadDeferred('thread-1', ['b_tool', 'nope'])).toEqual(['b_tool'])
    expect(loadDeferred('thread-1', ['a_tool', 'b_tool'])).toEqual(['a_tool'])
    // load order preserved (append-only — the cache-stability invariant), not alphabetical
    expect(loadedDeferredTools('thread-1').map((t) => t.name)).toEqual(['b_tool', 'a_tool'])
  })

  it('caps the loaded set per thread', () => {
    for (let i = 0; i < MAX_LOADED_PER_THREAD + 10; i++) fakeMcp.push(mcpTool(`t${i}`, 'x'))
    loadDeferred('thread-1', fakeMcp.map((t) => t.name))
    expect(loadedDeferredTools('thread-1').length).toBe(MAX_LOADED_PER_THREAD)
  })

  it('drops loaded tools whose server disconnected (they vanish from the registry)', () => {
    fakeMcp.push(mcpTool('gone_tool', 'x'))
    loadDeferred('thread-1', ['gone_tool'])
    fakeMcp.length = 0
    expect(loadedDeferredTools('thread-1')).toEqual([])
  })
})

describe('findToolsTool', () => {
  const ctx = { threadMeta: meta() } as unknown as ToolContext

  it('loads its matches so they become callable next round', async () => {
    fakeMcp.push(mcpTool('page_click', 'click an element on the page'))
    const res = (await findToolsTool.run({ query: 'click page' }, ctx)) as {
      found: { name: string; status: string }[]
    }
    expect(res.found.map((f) => f.name)).toContain('page_click')
    expect(loadedDeferredTools('thread-1').map((t) => t.name)).toContain('page_click')
  })

  it('reports already-loaded tools without duplicating them', async () => {
    fakeMcp.push(mcpTool('page_click', 'click an element on the page'))
    await findToolsTool.run({ query: 'click' }, ctx)
    const res = (await findToolsTool.run({ query: 'click' }, ctx)) as { found: { status: string }[] }
    expect(res.found[0]!.status).toBe('already loaded')
    expect(loadedDeferredTools('thread-1').length).toBe(1)
  })
})

describe('availableTools — deferred discovery integration', () => {
  it('sends core + find_tools but NOT unloaded MCP schemas', () => {
    fakeMcp.push(mcpTool('page_click', 'click'), mcpTool('page_type', 'type'))
    const names = availableTools(meta()).map((t) => t.name)
    expect(names).toContain('find_tools')
    expect(names).toContain('fs_read')
    expect(names).not.toContain('page_click')
    expect(names).not.toContain('page_type')
  })

  it('appends loaded tools after the core, in load order', () => {
    fakeMcp.push(mcpTool('z_tool', 'x'), mcpTool('a_tool', 'x'))
    loadDeferred('thread-1', ['z_tool', 'a_tool'])
    const names = availableTools(meta()).map((t) => t.name)
    expect(names.slice(-2)).toEqual(['z_tool', 'a_tool'])
  })

  it('omits find_tools when no deferred tool could run (manual preset, review mode, none connected)', () => {
    expect(availableTools(meta()).map((t) => t.name)).not.toContain('find_tools') // none connected
    fakeMcp.push(mcpTool('page_click', 'click'))
    expect(availableTools(meta({ permissionPreset: 'manual' })).map((t) => t.name)).not.toContain('find_tools')
    expect(availableTools(meta({ mode: 'review' })).map((t) => t.name)).not.toContain('find_tools')
    expect(availableTools(meta()).map((t) => t.name)).toContain('find_tools')
  })

  it('keeps the system-prompt inventory stable across loads (loaded tools are excluded from it)', () => {
    fakeMcp.push(mcpTool('page_click', 'click'))
    const inventoryOf = (m: ThreadMeta): string =>
      describeTools(availableTools(m).filter((t) => !t.mcpServerId))
    const before = inventoryOf(meta())
    loadDeferred('thread-1', ['page_click'])
    expect(inventoryOf(meta())).toBe(before)
    expect(before).toContain('find_tools')
    expect(before).toContain('instead of saying you lack the capability')
  })
})
