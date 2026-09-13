import { describe, expect, it, vi } from 'vitest'

vi.mock('../store/eventStore', () => ({
  readToolResult: (_threadId: string, callId: string) => (callId === 'known' ? { content: 'stored output', total: 13 } : null),
  searchToolResults: () => ({ items: [] })
}))

import { resultTools } from './resultTools'
import type { ToolContext } from './types'

const ctx = { threadMeta: { id: 'thread-1' } } as unknown as ToolContext
const tool = (name: string) => resultTools.find((candidate) => candidate.name === name)!

describe('read_tool_result', () => {
  it('says it is for pruned results only and points file reads at fs_read', () => {
    expect(tool('read_tool_result').description).toMatch(/pruned/)
    expect(tool('read_tool_result').description).toMatch(/fs_read/)
    expect(tool('search_tool_results').description).toMatch(/grep_search/)
  })

  it('returns a stored result, and a one-step recovery hint for an invented id', async () => {
    expect(await tool('read_tool_result').run({ call_id: 'known' }, ctx)).toMatchObject({ found: true, content: 'stored output' })
    const missing = (await tool('read_tool_result').run({ call_id: '7a9f9e0c-dc1e-4178-a53a-4f9686972a17' }, ctx)) as { found: boolean; hint: string }
    expect(missing.found).toBe(false)
    expect(missing.hint).toContain('fs_read')
  })
})
