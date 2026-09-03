import { describe, expect, it } from 'vitest'
import type { McpServerConfig, McpServerStatus, ThreadMeta } from '@shared/types'
import type { ToolDefinition } from '../tools/types'
import { buildToolInventory } from './toolInventory'

const tool = (over: Partial<ToolDefinition>): ToolDefinition =>
  ({
    name: 'x',
    description: 'd',
    parameters: { type: 'object' },
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: () => '',
    run: async () => ({}),
    ...over
  }) as ToolDefinition
const meta = { id: 't1', mode: 'act', permissionPreset: 'workspace' } as ThreadMeta

describe('buildToolInventory', () => {
  it('lists builtins with their effect and MCP tools with health + loaded state', () => {
    const servers = [
      {
        config: { id: 'gh', label: 'GitHub', enabled: true } as McpServerConfig,
        status: { id: 'gh', connected: false, tools: [], error: 'ECONNREFUSED' } as McpServerStatus
      }
    ]
    const out = buildToolInventory({
      meta,
      core: [tool({ name: 'fs_read' }), tool({ name: 'shell', resource: 'shell', action: 'execute', riskTier: 'R2' })],
      deferred: [tool({ name: 'mcp__gh__list_prs', mcpServerId: 'gh' }), tool({ name: 'mcp__gh__merge', mcpServerId: 'gh' })],
      loadedNames: new Set(['mcp__gh__list_prs']),
      servers,
      effectOf: (t) => (t.riskTier === 'R2' ? 'ask' : 'allow')
    })
    expect(out.map((e) => [e.name, e.source, e.effect])).toEqual([
      ['fs_read', 'builtin', 'allow'],
      ['shell', 'builtin', 'ask'],
      ['mcp__gh__list_prs', 'mcp', 'allow'],
      ['mcp__gh__merge', 'mcp', 'allow']
    ])
    expect(out[2]).toMatchObject({ serverLabel: 'GitHub', healthy: false, error: 'ECONNREFUSED', loaded: true })
    expect(out[3]).toMatchObject({ loaded: false })
    expect(out[0]).not.toHaveProperty('loaded')
  })
})
