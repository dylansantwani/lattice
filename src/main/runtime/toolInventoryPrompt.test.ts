import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The deferred-tool catalog behind availableTools() hydrates a thread's loaded set from SQLite;
// electron's `app` is unavailable under vitest, so point the db at a throwaway dir.
const dataDir = mkdtempSync(join(tmpdir(), 'lattice-tool-inventory-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))

import type { ThreadMeta } from '@shared/types'
import { AGENTIC_EXECUTION_PROTOCOL, availableTools, describeTools } from './runManager'
import { closeDb } from '../store/db'

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// Guards the "# Your tools" system-prompt block that stops weaker models (e.g. GPT Luna)
// from falsely claiming "I can't create subagents" / "I can't run commands" when the tool
// is right there. The block is built from the SAME availableTools() the model is handed,
// so it must list run_agent/ask_user when they're offered and stay silent when they're not.

const meta = (over: Partial<ThreadMeta>): ThreadMeta =>
  ({ mode: 'act', permissionPreset: 'workspace', ...over }) as ThreadMeta

describe('describeTools — capability grounding', () => {
  it('lists run_agent and ask_user and asserts subagents are real in the default thread', () => {
    const block = describeTools(availableTools(meta({})))
    expect(block).toContain('`run_agent`')
    expect(block).toContain('`ask_user`')
    expect(block).toMatch(/CAN create\/spawn subagents/i)
  })

  it('never advertises a tool the current mode/preset withholds', () => {
    // review mode strips run_agent; the inventory must not promise it, or the model would
    // try a tool it doesn't have and (rightly) report it can't.
    const block = describeTools(availableTools(meta({ mode: 'review' })))
    expect(block).not.toContain('`run_agent`')
  })

  it('does not crash and returns a header for an empty tool set', () => {
    expect(describeTools([])).toContain('# Your tools')
  })

  it('teaches background jobs with a literal start_job call and the notify-on-completion contract', () => {
    // Weaker tool-callers (DeepSeek V4 Flash) never set an optional boolean they only read about;
    // the inventory has to show the exact call and promise the result comes back on its own.
    const block = describeTools(availableTools(meta({})))
    expect(block).toContain('`start_job`')
    expect(block).toContain('start_job({"command": "npm test"})')
    expect(block).toContain('shell({"command": "npm test", "background": true})')
    expect(block).toMatch(/delivered to you automatically/)
    expect(block).toMatch(/Never wait by running `sleep`/)
  })

  it('withholds start_job (and the job note) where shell itself is withheld', () => {
    const block = describeTools(availableTools(meta({ permissionPreset: 'manual' })))
    expect(block).not.toContain('`start_job`')
    expect(block).not.toContain('BACKGROUND JOBS')
  })
})

describe('AGENTIC_EXECUTION_PROTOCOL — recovery and completion discipline', () => {
  it('requires decomposition, changed-strategy recovery, verification, and a final audit', () => {
    expect(AGENTIC_EXECUTION_PROTOCOL).toContain('Define the deliverables, constraints, and acceptance checks')
    expect(AGENTIC_EXECUTION_PROTOCOL).toContain('try the next reasonable distinct route')
    expect(AGENTIC_EXECUTION_PROTOCOL).toContain('Verify each deliverable with an independent check')
    expect(AGENTIC_EXECUTION_PROTOCOL).toContain('Run a completion audit before replying')
  })

  it('prevents blind retries and premature success claims', () => {
    expect(AGENTIC_EXECUTION_PROTOCOL).toContain('Never repeat an identical failed attempt')
    expect(AGENTIC_EXECUTION_PROTOCOL).toContain('Never claim success based only on an intention, plan, tool invocation, or assumption')
    expect(AGENTIC_EXECUTION_PROTOCOL).toContain('never use it to request tool permission or approval')
  })
})
