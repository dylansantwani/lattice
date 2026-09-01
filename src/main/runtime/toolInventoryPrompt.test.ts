import { describe, expect, it } from 'vitest'
import type { ThreadMeta } from '@shared/types'
import { availableTools, describeTools } from './runManager'

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
})
