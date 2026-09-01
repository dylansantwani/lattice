import { describe, expect, it } from 'vitest'
import type { ThreadMeta } from '@shared/types'
import { availableTools, executableTool, subagentTools, toWireTool } from './runManager'

// Regression guard for "the models aren't getting run_agent / ask_user". These assert the
// two tools survive filtering and serialize into valid OpenAI function tools, so the only
// remaining ways a model can miss them are a stale main process or a model that doesn't
// emit tool calls — never this code path.

const meta = (over: Partial<ThreadMeta>): ThreadMeta =>
  ({ mode: 'act', permissionPreset: 'workspace', ...over }) as ThreadMeta

const names = (m: ThreadMeta): string[] => availableTools(m).map((t) => t.name)

describe('tool delivery — run_agent', () => {
  it('is offered to the model in the default act/workspace thread', () => {
    expect(names(meta({}))).toContain('run_agent')
  })
  it('is offered under plan and full', () => {
    expect(names(meta({ mode: 'plan' }))).toContain('run_agent')
    expect(names(meta({ permissionPreset: 'full' }))).toContain('run_agent')
  })
  it('is intentionally withheld in review mode and the manual preset', () => {
    // run_agent is a network/execute action, so restrictive contexts strip it by design.
    expect(names(meta({ mode: 'review' }))).not.toContain('run_agent')
    expect(names(meta({ permissionPreset: 'manual' }))).not.toContain('run_agent')
  })
})

describe('tool delivery — ask_user', () => {
  it('is offered to the model in every mode and preset', () => {
    for (const mode of ['act', 'plan', 'review'] as const) {
      for (const permissionPreset of ['manual', 'workspace', 'full'] as const) {
        expect(names(meta({ mode, permissionPreset }))).toContain('ask_user')
      }
    }
  })
})

// Tools a subagent can never have: agent-management + ask_user.
const AGENT_ONLY = ['run_agent', 'message_agent', 'collect_agent', 'list_agents', 'stop_agent', 'ask_user']

describe('subagentTools — allowlist scoping', () => {
  it('inherits the full set minus the agent-management + ask_user tools when no allowlist is given', () => {
    const set = subagentTools(meta({})).map((t) => t.name)
    const parent = names(meta({}))
    for (const forbidden of AGENT_ONLY) expect(set).not.toContain(forbidden)
    // everything else the parent had is still present
    for (const n of parent.filter((n) => !AGENT_ONLY.includes(n))) {
      expect(set).toContain(n)
    }
  })

  it('narrows to exactly the requested tools when an allowlist is given', () => {
    const set = subagentTools(meta({}), ['fs_read', 'grep_search'])
    expect(set.map((t) => t.name).sort()).toEqual(['fs_read', 'grep_search'])
  })

  it('never grants run_agent or ask_user even if the allowlist names them', () => {
    const set = subagentTools(meta({}), ['fs_read', 'run_agent', 'ask_user'])
    expect(set.map((t) => t.name)).toEqual(['fs_read'])
  })

  it('drops requested tools the current preset denies (cannot exceed parent access)', () => {
    // shell is R2 → denied under the manual preset, so it can't be granted to a subagent there.
    const set = subagentTools(meta({ permissionPreset: 'manual' }), ['fs_read', 'shell'])
    expect(set.map((t) => t.name)).toEqual(['fs_read'])
  })

  it('yields an empty set for an empty allowlist (a text-only subagent)', () => {
    expect(subagentTools(meta({}), [])).toEqual([])
  })

  it('enforces the advertised allowlist again when executing a provider tool call', () => {
    const allowed = new Set(['fs_read'])
    expect(executableTool(meta({}), 'fs_read', allowed)?.name).toBe('fs_read')
    // `shell` is parent-available in workspace mode, but must not execute for this subagent.
    expect(availableTools(meta({})).some((tool) => tool.name === 'shell')).toBe(true)
    expect(executableTool(meta({}), 'shell', allowed)).toBeUndefined()
    // An empty allowlist is a genuinely text-only subagent at execution time too.
    expect(executableTool(meta({}), 'fs_read', new Set())).toBeUndefined()
  })
})

describe('tool delivery — wire shape', () => {
  it('serializes both tools as valid OpenAI function tools with a name and schema', () => {
    for (const name of ['run_agent', 'ask_user']) {
      const def = availableTools(meta({})).find((t) => t.name === name)
      expect(def, `${name} must be available`).toBeTruthy()
      const wire = toWireTool(def!)
      expect(wire.type).toBe('function')
      expect(wire.function.name).toBe(name)
      expect(wire.function.description).toBeTruthy()
      expect(wire.function.parameters).toMatchObject({ type: 'object' })
    }
  })
})
