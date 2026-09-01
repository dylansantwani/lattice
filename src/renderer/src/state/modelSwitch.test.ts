import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@shared/types'
import { computeModelSwitchInfo, shouldWarnModelSwitch } from './modelSwitch'

function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'cc/claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'cc',
    contextLength: 200_000,
    maxOutputTokens: 64_000,
    capabilities: { tools: true, vision: false, reasoning: true },
    ...over
  } as ModelInfo
}

describe('shouldWarnModelSwitch', () => {
  it('warns on a real mid-chat switch to a different model', () => {
    expect(
      shouldWarnModelSwitch({ currentModel: 'cc/a', targetModel: 'cc/b', messageCount: 4 })
    ).toBe(true)
  })

  it('does not warn on an empty thread (no context to carry over)', () => {
    expect(
      shouldWarnModelSwitch({ currentModel: 'cc/a', targetModel: 'cc/b', messageCount: 0 })
    ).toBe(false)
  })

  it('does not warn when re-selecting the same model', () => {
    expect(
      shouldWarnModelSwitch({ currentModel: 'cc/a', targetModel: 'cc/a', messageCount: 9 })
    ).toBe(false)
  })

  it('does not warn when the thread has no current model yet', () => {
    expect(
      shouldWarnModelSwitch({ currentModel: undefined, targetModel: 'cc/b', messageCount: 3 })
    ).toBe(false)
    expect(shouldWarnModelSwitch({ currentModel: null, targetModel: 'cc/b', messageCount: 3 })).toBe(
      false
    )
  })
})

describe('computeModelSwitchInfo', () => {
  it('carries the current context tokens and the target window', () => {
    const info = computeModelSwitchInfo({
      currentModel: 'cc/a',
      currentName: 'Model A',
      targetModel: 'cc/claude-opus-5',
      target: model({ contextLength: 200_000 }),
      contextTokens: 12_345
    })
    expect(info.currentName).toBe('Model A')
    expect(info.targetName).toBe('Claude Opus 5')
    expect(info.contextTokens).toBe(12_345)
    expect(info.targetContextLength).toBe(200_000)
    expect(info.fitsInTarget).toBe(true)
  })

  it('flags when the context does not fit the new window', () => {
    const info = computeModelSwitchInfo({
      currentModel: 'cc/a',
      targetModel: 'cc/small',
      target: model({ contextLength: 8_000 }),
      contextTokens: 12_000
    })
    expect(info.fitsInTarget).toBe(false)
  })

  it('treats an unknown window as fitting (never cries wolf about an unmeasurable limit)', () => {
    const info = computeModelSwitchInfo({
      currentModel: 'cc/a',
      targetModel: 'cc/mystery',
      target: undefined,
      contextTokens: 999_999
    })
    expect(info.targetContextLength).toBe(0)
    expect(info.fitsInTarget).toBe(true)
    expect(info.targetName).toBe('cc/mystery') // falls back to the id when no ModelInfo
  })

  it('estimates input cost from the target price when pricing is known', () => {
    const info = computeModelSwitchInfo({
      currentModel: 'cc/a',
      targetModel: 'cc/priced',
      target: model({ pricing: { inputPerMTok: 15, outputPerMTok: 75 } }),
      contextTokens: 1_000_000
    })
    expect(info.estInputCost).toBeCloseTo(15, 5)
  })

  it('omits cost when the model is unpriced or the context is empty', () => {
    expect(
      computeModelSwitchInfo({
        currentModel: 'cc/a',
        targetModel: 'cc/free',
        target: model({ pricing: undefined }),
        contextTokens: 5_000
      }).estInputCost
    ).toBeUndefined()
    expect(
      computeModelSwitchInfo({
        currentModel: 'cc/a',
        targetModel: 'cc/priced',
        target: model({ pricing: { inputPerMTok: 15, outputPerMTok: 75 } }),
        contextTokens: 0
      }).estInputCost
    ).toBeUndefined()
  })
})
