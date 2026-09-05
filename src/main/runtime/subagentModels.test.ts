import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Settings live in SQLite; electron's `app` is unavailable under vitest, so point the db at a
// throwaway dir. The provider model cache is empty here, so names fall back to raw ids.
const dataDir = mkdtempSync(join(tmpdir(), 'lattice-subagent-models-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))

import type { ModelInfo } from '@shared/types'
import { describeSubagentModels, subagentModelChoices } from './runManager'
import { closeDb } from '../store/db'
import { setSettings, setCachedModels } from '../store/eventStore'

/** Minimal cached ModelInfo carrying just the fields the prompt block reads (id, name, window). */
function cachedModel(id: string, contextLength: number): ModelInfo {
  return {
    id,
    name: id,
    provider: id.split('/')[0] ?? 'default',
    contextLength,
    maxOutputTokens: 4096,
    capabilities: { vision: false, tools: true, reasoning: false, effortTiers: [] }
  }
}

beforeEach(() => {
  setSettings({ subagentModels: [] })
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// The user designates subagent models in Settings; the orchestrator must see exactly its own model
// plus those (nothing else), in a stable order, and be told the list is exhaustive.

describe('subagentModelChoices', () => {
  it('is just the own model when nothing is designated', () => {
    expect(subagentModelChoices('cc/claude-fable-5')).toEqual([{ id: 'cc/claude-fable-5', own: true }])
  })

  it('lists the own model first, then the designated ones in settings order, de-duplicated', () => {
    setSettings({ subagentModels: ['openrouter/z-ai/glm-5.3-flash', 'cc/claude-fable-5', 'mac/qwen3', 'mac/qwen3'] })
    expect(subagentModelChoices('cc/claude-fable-5').map((c) => [c.id, c.own])).toEqual([
      ['cc/claude-fable-5', true],
      ['openrouter/z-ai/glm-5.3-flash', false],
      ['mac/qwen3', false]
    ])
  })

  it('ignores junk entries a hand-edited settings row might carry', () => {
    setSettings({ subagentModels: ['', 'mac/qwen3'] as string[] })
    expect(subagentModelChoices('cc/claude-fable-5').map((c) => c.id)).toEqual(['cc/claude-fable-5', 'mac/qwen3'])
  })
})

describe('describeSubagentModels — the # Subagent models prompt block', () => {
  it('names every choice, marks the own model as the default, and says the list is exhaustive', () => {
    setSettings({ subagentModels: ['openrouter/z-ai/glm-5.3-flash'] })
    const block = describeSubagentModels('cc/claude-fable-5')
    expect(block.startsWith('# Subagent models')).toBe(true)
    expect(block).toContain('`cc/claude-fable-5`')
    expect(block).toContain('your own model; the default when `model` is omitted')
    expect(block).toContain('`openrouter/z-ai/glm-5.3-flash`')
    expect(block).toMatch(/only models you may use/)
    // With a real choice on offer, it teaches matching the model to the task.
    expect(block).toMatch(/cheaper or faster model for bounded/)
  })

  it('tells the model where the user adds choices when none are designated', () => {
    const block = describeSubagentModels('cc/claude-fable-5')
    expect(block).toContain('Settings → General → Subagent models')
    expect(block).not.toMatch(/cheaper or faster/)
  })

  it('is empty without a model', () => {
    expect(describeSubagentModels(undefined)).toBe('')
  })

  it('flags a subagent model whose window is smaller than the main agent, with its size', () => {
    setSettings({
      subagentModels: ['llamacpp/qwen3.6-35b-a3b'],
      providers: [{ id: 'omni', label: 'OmniRoute', kind: 'openai-compat', baseUrl: 'http://x', apiKey: 'k', enabled: true }]
    })
    setCachedModels('omni', [
      cachedModel('cc/claude-fable-5', 200000),
      cachedModel('llamacpp/qwen3.6-35b-a3b', 65536)
    ])
    const block = describeSubagentModels('cc/claude-fable-5')
    // The small model shows its real window and a caveat relative to the main agent's.
    expect(block).toContain('64k ctx')
    expect(block).toMatch(/small context, less than your 200k/)
    expect(block).toMatch(/truncates large tool output and holds less history/)
    // The trailing guidance explains what ⚠ small context means for delegation.
    expect(block).toMatch(/bounded, well-specified job/)
  })

  it('does not flag a subagent model with a full-size window', () => {
    setSettings({
      subagentModels: ['openrouter/big-model'],
      providers: [{ id: 'omni', label: 'OmniRoute', kind: 'openai-compat', baseUrl: 'http://x', apiKey: 'k', enabled: true }]
    })
    setCachedModels('omni', [
      cachedModel('cc/claude-fable-5', 200000),
      cachedModel('openrouter/big-model', 128000)
    ])
    const block = describeSubagentModels('cc/claude-fable-5')
    expect(block).toContain('128k ctx')
    expect(block).not.toMatch(/small context/)
  })
})
