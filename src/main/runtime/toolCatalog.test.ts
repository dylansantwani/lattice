import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig, McpServerStatus, ThreadMeta } from '@shared/types'
import type { ToolContext, ToolDefinition } from '../tools/types'

// electron's `app` is unavailable under vitest; point the db (which backs the loaded set) at a
// throwaway dir.
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-catalog-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

// Fake MCP registry, mutable per test. Mocked BEFORE importing the catalog/runManager so both
// see the same fake through the module graph.
const fakeMcp: ToolDefinition[] = []
const fakeServers: { config: McpServerConfig; status: McpServerStatus }[] = []
vi.mock('../mcp/manager', () => ({ mcpTools: () => fakeMcp, mcpStatuses: () => fakeServers }))

const {
  clearLoaded,
  findMcpTool,
  loadDeferred,
  loadedDeferredTools,
  mcpCatalog,
  resetCatalogCache,
  resolveDeferred,
  MAX_LOADED_PER_THREAD
} = await import('./toolCatalog')
const { availableTools, describeTools, resolveToolCall, subagentTools } = await import('./runManager')
const { listThreadTools } = await import('../store/eventStore')
const { closeDb } = await import('../store/db')

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

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
  fakeServers.length = 0
  clearLoaded('thread-1')
})

describe('mcpCatalog', () => {
  it('lists one entry per MCP rather than one entry per tool', () => {
    fakeMcp.push(
      mcpTool('page_screenshot', 'capture the current page'),
      mcpTool('navigate', 'open a url in the browser page'),
      mcpTool('printer_status', 'read the 3d printer state', 'bambu')
    )
    const out = mcpCatalog()
    expect(out.map((mcp) => mcp.id)).toEqual(['browser', 'bambu'])
    expect(out[0]?.tools.map((tool) => tool.name)).toEqual(['page_screenshot', 'navigate'])
    expect(out[0]?.description).toContain('Provides 2 tools')
  })

  it('uses the MCP server\'s own instructions as its description when provided', () => {
    fakeMcp.push(mcpTool('navigate', 'open a url'))
    fakeServers.push({
      config: { id: 'browser', label: 'Browser', enabled: true } as McpServerConfig,
      status: { id: 'browser', connected: true, instructions: 'Control the live browser safely.', tools: [] }
    })
    expect(mcpCatalog()[0]).toMatchObject({ id: 'browser', label: 'Browser', description: 'Control the live browser safely.' })
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

describe('findMcpTool', () => {
  const ctx = { threadMeta: meta() } as unknown as ToolContext

  it('loads every tool from the selected MCP and no tools from another MCP', async () => {
    fakeMcp.push(
      mcpTool('page_click', 'click an element on the page'),
      mcpTool('page_snapshot', 'read the page'),
      mcpTool('printer_status', 'read the printer', 'bambu')
    )
    const res = (await findMcpTool().run({ server: 'browser' }, ctx)) as {
      tools: { name: string }[]
    }
    expect(res.tools.map((tool) => tool.name)).toEqual(['page_click', 'page_snapshot'])
    expect(loadedDeferredTools('thread-1').map((t) => t.name)).toEqual(['page_click', 'page_snapshot'])
  })

  it('reports an already-loaded MCP without duplicating its schemas', async () => {
    fakeMcp.push(mcpTool('page_click', 'click an element on the page'))
    await findMcpTool().run({ server: 'browser' }, ctx)
    const res = (await findMcpTool().run({ server: 'browser' }, ctx)) as { status: string }
    expect(res.status).toBe('already loaded')
    expect(loadedDeferredTools('thread-1').length).toBe(1)
  })

  it('loads the selected MCP whole even when it has more tools than the direct-load ceiling', async () => {
    for (let i = 0; i < MAX_LOADED_PER_THREAD + 3; i++) fakeMcp.push(mcpTool(`browser_${i}`, 'x'))
    await findMcpTool().run({ server: 'browser' }, ctx)
    expect(loadedDeferredTools('thread-1')).toHaveLength(MAX_LOADED_PER_THREAD + 3)
    fakeMcp.push(mcpTool('printer_status', 'x', 'bambu'))
    expect(resolveDeferred('thread-1', 'printer_status').kind).toBe('full')
  })

  it('advertises each MCP once with its id and description in the discovery schema', () => {
    fakeMcp.push(mcpTool('page_click', 'click the page'), mcpTool('page_snapshot', 'read the page'))
    const tool = findMcpTool()
    expect(tool.description.split('\n').filter((line) => line.startsWith('- browser '))).toHaveLength(1)
    expect(tool.description).toContain('Provides 2 tools')
    expect(tool.parameters).toMatchObject({ properties: { server: { enum: ['browser'] } } })
  })
})

describe('availableTools — deferred discovery integration', () => {
  it('sends core + find_mcp but NOT unloaded MCP schemas', () => {
    fakeMcp.push(mcpTool('page_click', 'click'), mcpTool('page_type', 'type'))
    const names = availableTools(meta()).map((t) => t.name)
    expect(names).toContain('find_mcp')
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

  it('omits find_mcp when no deferred tool could run (manual preset, review mode, none connected)', () => {
    expect(availableTools(meta()).map((t) => t.name)).not.toContain('find_mcp') // none connected
    fakeMcp.push(mcpTool('page_click', 'click'))
    expect(availableTools(meta({ permissionPreset: 'manual' })).map((t) => t.name)).not.toContain('find_mcp')
    expect(availableTools(meta({ mode: 'review' })).map((t) => t.name)).not.toContain('find_mcp')
    expect(availableTools(meta()).map((t) => t.name)).toContain('find_mcp')
  })

  it('keeps the system-prompt inventory stable across loads (loaded tools are excluded from it)', () => {
    fakeMcp.push(mcpTool('page_click', 'click'))
    const inventoryOf = (m: ThreadMeta): string =>
      describeTools(availableTools(m).filter((t) => !t.mcpServerId))
    const before = inventoryOf(meta())
    loadDeferred('thread-1', ['page_click'])
    expect(inventoryOf(meta())).toBe(before)
    expect(before).toContain('find_mcp')
    expect(before).toContain('browser')
    expect(before).toContain('load ALL of that MCP\'s tool schemas')
  })
})

describe('persistence — the loaded set survives a relaunch', () => {
  it('writes loads through to the store and rehydrates after the cache is dropped', () => {
    fakeMcp.push(mcpTool('mcp__browser__navigate', 'open a url'), mcpTool('mcp__browser__snapshot', 'read the page'))
    loadDeferred('thread-1', ['mcp__browser__navigate', 'mcp__browser__snapshot'])
    expect(listThreadTools('thread-1')).toEqual(['mcp__browser__navigate', 'mcp__browser__snapshot'])
    resetCatalogCache() // what an app relaunch does to the in-memory set
    expect(loadedDeferredTools('thread-1').map((t) => t.name)).toEqual([
      'mcp__browser__navigate',
      'mcp__browser__snapshot'
    ])
    // and the rehydrated set still appends (not resets) on the next load
    fakeMcp.push(mcpTool('mcp__browser__click', 'click'))
    loadDeferred('thread-1', ['mcp__browser__click'])
    expect(listThreadTools('thread-1')).toEqual([
      'mcp__browser__navigate',
      'mcp__browser__snapshot',
      'mcp__browser__click'
    ])
  })

  it('keeps a dormant name whose server is disconnected, so it resolves again on reconnect', () => {
    fakeMcp.push(mcpTool('mcp__browser__navigate', 'open a url'))
    loadDeferred('thread-1', ['mcp__browser__navigate'])
    fakeMcp.length = 0
    expect(loadedDeferredTools('thread-1')).toEqual([])
    fakeMcp.push(mcpTool('mcp__browser__navigate', 'open a url'))
    expect(loadedDeferredTools('thread-1').map((t) => t.name)).toEqual(['mcp__browser__navigate'])
  })

  it('persists an MCP selection and includes new server tools after reconnect', async () => {
    const ctx = { threadMeta: meta() } as unknown as ToolContext
    fakeMcp.push(mcpTool('mcp__browser__navigate', 'open a url'))
    await findMcpTool().run({ server: 'browser' }, ctx)
    resetCatalogCache()
    fakeMcp.push(mcpTool('mcp__browser__snapshot', 'read the page'))
    expect(loadedDeferredTools('thread-1').map((tool) => tool.name)).toEqual([
      'mcp__browser__navigate',
      'mcp__browser__snapshot'
    ])
  })

  it('clearLoaded forgets both the cache and the persisted rows', () => {
    fakeMcp.push(mcpTool('mcp__browser__navigate', 'open a url'))
    loadDeferred('thread-1', ['mcp__browser__navigate'])
    clearLoaded('thread-1')
    resetCatalogCache()
    expect(listThreadTools('thread-1')).toEqual([])
    expect(loadedDeferredTools('thread-1')).toEqual([])
  })
})

describe('resolveDeferred — calling a deferred tool by name', () => {
  const server = (id: string, over: Partial<McpServerStatus> = {}, enabled = true): void => {
    fakeServers.push({
      config: { id, label: id, transport: 'stdio', command: 'x', enabled } as McpServerConfig,
      status: { id, connected: true, tools: [], ...over }
    })
  }

  it('loads a connected, unloaded tool on the spot', () => {
    fakeMcp.push(mcpTool('mcp__browser__navigate', 'open a url'))
    const res = resolveDeferred('thread-1', 'mcp__browser__navigate')
    expect(res.kind).toBe('deferred')
    expect(loadedDeferredTools('thread-1').map((t) => t.name)).toEqual(['mcp__browser__navigate'])
    expect(listThreadTools('thread-1')).toEqual(['mcp__browser__navigate'])
  })

  it('explains a full loaded set instead of silently failing', () => {
    for (let i = 0; i < MAX_LOADED_PER_THREAD; i++) fakeMcp.push(mcpTool(`t${i}`, 'x'))
    loadDeferred('thread-1', fakeMcp.map((t) => t.name))
    fakeMcp.push(mcpTool('mcp__browser__navigate', 'open a url'))
    const res = resolveDeferred('thread-1', 'mcp__browser__navigate')
    expect(res.kind).toBe('full')
    expect(res.kind === 'full' && res.message).toContain(`${MAX_LOADED_PER_THREAD}`)
  })

  it('names an unconfigured integration and points at find_mcp', () => {
    const res = resolveDeferred('thread-1', 'mcp__nothere__navigate')
    expect(res.kind).toBe('unknown')
    expect(res.kind === 'unknown' && res.message).toMatch(/no integration named "nothere".*find_mcp/)
  })

  it('reports a disconnected integration with its connect error', () => {
    server('browser', { connected: false, error: 'connect timed out after 15000ms' })
    const res = resolveDeferred('thread-1', 'mcp__browser__navigate')
    expect(res.kind === 'unknown' && res.message).toContain('not connected (connect timed out after 15000ms)')
  })

  it('reports a disabled integration', () => {
    server('browser', { connected: false }, false)
    const res = resolveDeferred('thread-1', 'mcp__browser__navigate')
    expect(res.kind === 'unknown' && res.message).toContain('disabled in Settings')
  })

  it('reports a connected integration that lacks the tool', () => {
    server('browser')
    fakeMcp.push(mcpTool('mcp__browser__snapshot', 'read the page'))
    const res = resolveDeferred('thread-1', 'mcp__browser__navigate')
    expect(res.kind === 'unknown' && res.message).toContain('provides no tool named "navigate"')
  })

  it('reports a name that is neither core nor mcp-shaped', () => {
    const res = resolveDeferred('thread-1', 'teleport')
    expect(res.kind === 'unknown' && res.message).toMatch(/^Unknown tool teleport\./)
  })
})

describe('resolveToolCall — what executeToolCall runs for a called name', () => {
  it('returns a loaded tool, or auto-loads a known deferred tool called by name', () => {
    fakeMcp.push(mcpTool('mcp__browser__navigate', 'open a url'))
    const first = resolveToolCall('mcp__browser__navigate', meta())
    expect('tool' in first && first.tool.name).toBe('mcp__browser__navigate')
    // from now on it rides in the request's tool array too
    expect(availableTools(meta()).map((t) => t.name)).toContain('mcp__browser__navigate')
    const core = resolveToolCall('fs_read', meta())
    expect('tool' in core && core.tool.name).toBe('fs_read')
  })

  it('does NOT load a deferred tool the mode/preset denies, and says which one withheld it', () => {
    fakeMcp.push(mcpTool('mcp__browser__navigate', 'open a url'))
    const plan = resolveToolCall('mcp__browser__navigate', meta({ mode: 'plan' }))
    expect('error' in plan && plan.error).toContain('plan mode')
    const manual = resolveToolCall('mcp__browser__navigate', meta({ permissionPreset: 'manual' }))
    expect('error' in manual && manual.error).toContain('"manual" permission preset')
    const review = resolveToolCall('mcp__browser__navigate', meta({ mode: 'review' }))
    expect('error' in review && review.error).toContain('review mode')
    expect(loadedDeferredTools('thread-1')).toEqual([])
  })

  it('distinguishes a withheld core tool from an unknown name', () => {
    const shell = resolveToolCall('shell', meta({ mode: 'review' }))
    expect('error' in shell && shell.error).toContain('review mode')
    const nope = resolveToolCall('mcp__ghost__do', meta())
    expect('error' in nope && nope.error).toContain('no integration named "ghost"')
  })
})

describe('subagentTools — deferred names in the allow list', () => {
  it('loads allow-listed deferred tools so the subagent sees them from round one', () => {
    fakeMcp.push(mcpTool('mcp__browser__navigate', 'open a url'), mcpTool('mcp__browser__snapshot', 'read'))
    const names = subagentTools(meta(), ['fs_read', 'mcp__browser__navigate']).map((t) => t.name)
    // `batch` rides along with any non-empty narrowed set — it grants nothing of its own.
    expect(names).toEqual(['batch', 'fs_read', 'mcp__browser__navigate'])
    expect(listThreadTools('thread-1')).toEqual(['mcp__browser__navigate'])
  })

  it('never loads an allow-listed deferred tool the mode denies', () => {
    fakeMcp.push(mcpTool('mcp__browser__navigate', 'open a url'))
    const names = subagentTools(meta({ mode: 'plan' }), ['mcp__browser__navigate']).map((t) => t.name)
    // The whole allowlist was denied: the set stays empty — no lone `batch` wrapper appears.
    expect(names).toEqual([])
    expect(listThreadTools('thread-1')).toEqual([])
  })

  it('does not duplicate batch when the parent names it explicitly', () => {
    const names = subagentTools(meta(), ['batch', 'fs_read']).map((t) => t.name)
    expect(names).toEqual(['batch', 'fs_read'])
  })
})

describe('toolGist', () => {
  it('keeps the first sentence and caps its length', async () => {
    const { toolGist } = await import('./toolCatalog')
    expect(toolGist('Open a page. Then do many other things with it.')).toBe('Open a page.')
    expect(toolGist('  multi\n  line   text without a stop  ')).toBe('multi line text without a stop')
    expect(toolGist('x'.repeat(300)).length).toBe(120)
    expect(toolGist(undefined)).toBe('')
    expect(toolGist('Version 1.2 is out. Next.')).toBe('Version 1.2 is out.')
  })
})
