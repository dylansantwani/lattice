import { describe, expect, it } from 'vitest'
import type { ThreadMeta } from '@shared/types'
import { availableTools, toWireTool } from './runManager'

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
