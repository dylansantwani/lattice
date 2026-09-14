import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The deferred-tool catalog behind availableTools() hydrates a thread's loaded set from SQLite;
// electron's `app` is unavailable under vitest, so point the db at a throwaway dir.
const dataDir = mkdtempSync(join(tmpdir(), 'lattice-tool-delivery-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))

import type { ThreadMeta } from '@shared/types'
import { availableTools, subagentTools, toWireTool } from './runManager'
import { closeDb } from '../store/db'

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

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
  // A subagent can't spawn/track further agents (run_agent, agent_result, peek_agents), manage the
  // thread's background jobs (start_job, job_status, stop_job), block on the user (ask_user), rename
  // the user's thread (set_thread_title), or build/drive a fleet — all of these are stripped.
  const SUBAGENT_STRIPPED = [
    'run_agent',
    'agent_result',
    'peek_agents',
    'start_job',
    'job_status',
    'stop_job',
    'ask_user',
    'set_thread_title',
    'delegate_to_agent',
    'create_fleet',
    'add_agent',
    'update_agent',
    'remove_agent',
    'list_fleet'
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

  it('narrows to the requested tools when an allowlist is given (plus the inert batch wrapper)', () => {
    const set = subagentTools(meta({}), ['fs_read', 'grep_search'])
    // `batch` rides along with any non-empty narrowed set: it grants no capability of its own —
    // each sub-call re-enters the broker under this same allowlist.
    expect(set.map((t) => t.name).sort()).toEqual(['batch', 'fs_read', 'grep_search'])
  })

  it('never grants the never-for-subagents tools even if the allowlist names them', () => {
    const set = subagentTools(meta({}), [
      'fs_read',
      'run_agent',
      'ask_user',
      'agent_result',
      'peek_agents',
      'start_job',
      'job_status',
      'stop_job',
      'set_thread_title'
    ])
    expect(set.map((t) => t.name)).toEqual(['batch', 'fs_read'])
  })

  it('drops requested tools the current preset denies (cannot exceed parent access)', () => {
    // shell is R2 → denied under the manual preset, so it can't be granted to a subagent there.
    const set = subagentTools(meta({ permissionPreset: 'manual' }), ['fs_read', 'shell'])
    expect(set.map((t) => t.name)).toEqual(['batch', 'fs_read'])
  })

  it('yields an empty set for an empty allowlist (a text-only subagent) — no lone batch wrapper', () => {
    expect(subagentTools(meta({}), [])).toEqual([])
  })

  it('lets a parent explicitly hand web search and page fetch to a subagent', () => {
    expect(subagentTools(meta({}), ['web_search', 'web_fetch']).map((t) => t.name)).toEqual([
      'batch',
      'web_search',
      'web_fetch'
    ])
  })
})

describe('tool delivery — web search', () => {
  it('is exposed to the parent and inherited by subagents in the default workspace preset', () => {
    expect(names(meta({}))).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
    expect(subagentTools(meta({})).map((t) => t.name)).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
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
