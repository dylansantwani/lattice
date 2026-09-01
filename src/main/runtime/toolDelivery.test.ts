import { describe, expect, it } from 'vitest'
import type { ThreadMeta } from '@shared/types'
import { availableTools, subagentTools, toWireTool } from './runManager'

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

describe('subagentTools — allowlist scoping', () => {
  // A subagent can't spawn/track further agents (run_agent, agent_result), manage the thread's
  // background jobs (job_status, stop_job), block on the user (ask_user), or rename the user's
  // thread (set_thread_title) — all six are stripped.
  const SUBAGENT_STRIPPED = [
    'run_agent',
    'agent_result',
    'job_status',
    'stop_job',
    'ask_user',
    'set_thread_title'
  ]

  it('inherits the full set minus the never-for-subagents tools when no allowlist is given', () => {
    const set = subagentTools(meta({}))
    const parent = names(meta({}))
    for (const n of SUBAGENT_STRIPPED) expect(set.map((t) => t.name)).not.toContain(n)
    // everything else the parent had is still present
    for (const n of parent.filter((n) => !SUBAGENT_STRIPPED.includes(n))) {
      expect(set.map((t) => t.name)).toContain(n)
    }
  })

  it('narrows to exactly the requested tools when an allowlist is given', () => {
    const set = subagentTools(meta({}), ['fs_read', 'grep_search'])
    expect(set.map((t) => t.name).sort()).toEqual(['fs_read', 'grep_search'])
  })

  it('never grants the never-for-subagents tools even if the allowlist names them', () => {
    const set = subagentTools(meta({}), [
      'fs_read',
      'run_agent',
      'ask_user',
      'agent_result',
      'job_status',
      'stop_job',
      'set_thread_title'
    ])
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
