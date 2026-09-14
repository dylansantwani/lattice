import { describe, expect, it } from 'vitest'
import {
  compactTool,
  isLocalModel,
  LEAN_PARTS,
  LEAN_SYSTEM_PROMPT,
  leadingSentences,
  leanParts,
  leanToolInventory,
  leanToolSet,
  resolveContextProfile
} from './contextProfile'

describe('isLocalModel', () => {
  it('recognizes local route prefixes and local gateway owners', () => {
    expect(isLocalModel('mac/qwen3:30b-a3b')).toBe(true)
    expect(isLocalModel('llamacpp/qwen36-q4kxl')).toBe(true)
    expect(isLocalModel('pc5080/qwen3:8b')).toBe(true)
    expect(isLocalModel('qwen36-q4kxl', { ownedBy: 'llamacpp', provider: 'default' })).toBe(true)
    expect(isLocalModel('qwen3.6-35b-a3b', { ownedBy: 'pc5080', provider: 'default' })).toBe(true)
  })

  it('treats hosted routes as not local, even behind a localhost gateway', () => {
    expect(isLocalModel('cc/claude-fable-5', { ownedBy: 'claude', provider: 'cc' })).toBe(false)
    expect(isLocalModel('deepseek/deepseek-v4-flash')).toBe(false)
    expect(isLocalModel('openrouter/z-ai/glm-5.2:free', { ownedBy: 'openrouter', provider: 'openrouter' })).toBe(false)
    expect(isLocalModel(undefined)).toBe(false)
  })
})

describe('resolveContextProfile', () => {
  it('auto picks lean for local models and full for hosted ones', () => {
    expect(resolveContextProfile('auto', 'llamacpp/qwen36-q4kxl', null, {})).toBe('lean')
    expect(resolveContextProfile(undefined, 'cc/claude-fable-5', null, {})).toBe('full')
  })

  it('an explicit setting wins over auto, and the env override wins over both', () => {
    expect(resolveContextProfile('full', 'mac/qwen3:30b-a3b', null, {})).toBe('full')
    expect(resolveContextProfile('lean', 'cc/claude-fable-5', null, {})).toBe('lean')
    expect(resolveContextProfile('lean', 'mac/qwen3:30b-a3b', null, { LATTICE_CONTEXT_PROFILE: 'full' })).toBe('full')
  })
})

describe('leanParts', () => {
  it('is empty for full, everything for lean, and narrows by env for ablations', () => {
    expect([...leanParts('full', {})]).toEqual([])
    expect([...leanParts('lean', {})]).toEqual([...LEAN_PARTS])
    expect([...leanParts('lean', { LATTICE_LEAN_PARTS: 'schema, prompt,bogus' })]).toEqual(['schema', 'prompt'])
  })
})

describe('leanToolSet', () => {
  const names = ['fs_read', 'shell', 'run_agent', 'agent_result', 'peek_agents', 'send_message', 'check_inbox', 'list_sessions', 'peek_session', 'set_thread_title', 'show_image', 'fetch_image', 'show_image_data', 'web_fetch'].map((name) => ({ name }))

  it('drops orchestration, messaging and titling tools, and image tools for text-only models', () => {
    expect(leanToolSet(names, { vision: false }).map((tool) => tool.name)).toEqual(['fs_read', 'shell', 'web_fetch'])
  })

  it('keeps image tools for a vision model', () => {
    expect(leanToolSet(names, { vision: true }).map((tool) => tool.name)).toEqual(['fs_read', 'shell', 'show_image', 'fetch_image', 'show_image_data', 'web_fetch'])
  })

  it('keeps explicitly kept tools through the lean cut (a fleet agent must still message its orchestrator)', () => {
    const kept = leanToolSet(names, { vision: false, keep: new Set(['send_message', 'check_inbox']) }).map((tool) => tool.name)
    expect(kept).toEqual(['fs_read', 'shell', 'send_message', 'check_inbox', 'web_fetch'])
  })

  it('drops the fleet-building verbs for a lean thread', () => {
    const fleetish = ['create_fleet', 'add_agent', 'update_agent', 'remove_agent', 'list_fleet', 'delegate_to_agent'].map((name) => ({ name }))
    expect(leanToolSet(fleetish, { vision: false }).map((tool) => tool.name)).toEqual(['list_fleet', 'delegate_to_agent'])
  })
})

describe('compactTool', () => {
  const tool = {
    name: 'shell',
    description: 'Run a command in a persistent login shell rooted at the workspace and return its output. Combine independent commands into one call. Working directory persists across calls. A foreground command may block you for at most 20 seconds, after which it moves to the background automatically, and so on at great length.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run — just the command, no explanatory comment lines (put the explanation in `purpose`). Really.' },
        mode: { type: 'string', enum: ['fg', 'bg'], description: 'Short.' },
        nested: { type: 'object', properties: { inner: { type: 'number', description: `${'Long inner description. '.repeat(20)}` } }, examples: [{ inner: 1 }] }
      },
      required: ['command']
    },
    run: () => 'kept'
  }

  it('shortens descriptions to leading sentences while keeping names, types, enums and required', () => {
    const next = compactTool(tool)
    expect(next.description.length).toBeLessThanOrEqual(320)
    expect(next.description.startsWith('Run a command in a persistent login shell')).toBe(true)
    const props = (next.parameters as { properties: Record<string, { description?: string; enum?: string[]; properties?: Record<string, { description?: string }>; examples?: unknown }> }).properties
    expect(props.command!.description!.length).toBeLessThanOrEqual(140)
    expect(props.mode!.enum).toEqual(['fg', 'bg'])
    expect(props.nested!.properties!.inner!.description!.length).toBeLessThanOrEqual(140)
    expect(props.nested!.examples).toBeUndefined()
    expect((next.parameters as { required: string[] }).required).toEqual(['command'])
    expect(next.run()).toBe('kept')
  })

  it('returns the identical object on every call so request bytes stay cache-stable', () => {
    expect(compactTool(tool)).toBe(compactTool(tool))
  })

  it('leaves find_mcp’s catalog description whole', () => {
    const catalog = { name: 'find_mcp', description: `Servers: ${'server-x provides many tools. '.repeat(30)}`, parameters: {} }
    expect(compactTool(catalog).description).toBe(catalog.description)
  })
})

describe('leadingSentences', () => {
  it('keeps whole sentences within the limit and clips a single long sentence at a word', () => {
    expect(leadingSentences('One. Two words here. Three!', 20)).toBe('One. Two words here.')
    const clipped = leadingSentences(`${'word '.repeat(80)}end.`, 50)
    expect(clipped.length).toBeLessThanOrEqual(50)
    expect(clipped.endsWith('…')).toBe(true)
  })
})

describe('lean prompt pieces', () => {
  it('keeps the inventory to a couple of lines and mentions find_mcp only when present', () => {
    expect(leanToolInventory([{ name: 'shell' }]).split('\n')).toHaveLength(2)
    expect(leanToolInventory([{ name: 'shell' }, { name: 'find_mcp' }])).toContain('find_mcp')
  })

  it('is a small fraction of the full base prompt', () => {
    expect(LEAN_SYSTEM_PROMPT.length).toBeLessThan(2000)
    expect(LEAN_SYSTEM_PROMPT).toContain('background')
    expect(LEAN_SYSTEM_PROMPT).toContain('todo_write')
  })
})
