import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@shared/types'
import { sourceKey, chipLabel } from './modelCatalog'

/** Minimal ModelInfo builder — only the fields the source-grouping logic reads. */
function model(partial: Partial<ModelInfo>): ModelInfo {
  return {
    id: 'm',
    name: 'M',
    provider: 'default',
    contextLength: 8000,
    maxOutputTokens: 4096,
    capabilities: { vision: false, tools: true, reasoning: false, effortTiers: [] },
    ...partial
  }
}

describe('sourceKey — which section a model groups under', () => {
  it('groups a dedicated vLLM endpoint under its configured provider label, not "vllm"', () => {
    // The exact shape runpod2 returns: bare id, owned_by "vllm".
    const m = model({ id: 'qwen27b', ownedBy: 'vllm', providerId: 'rp2', providerLabel: 'runpod2' })
    expect(sourceKey(m)).toBe('runpod2')
  })

  it('keeps a recognized gateway backend grouped by owned_by (OmniRoute stays split by source)', () => {
    const m = model({ id: 'openrouter/openai/gpt', ownedBy: 'openrouter', provider: 'openrouter', providerLabel: 'OmniRoute' })
    expect(sourceKey(m)).toBe('openrouter')
  })

  it('keeps a meaningful (non-generic) backend as its own section even when unrecognized', () => {
    // e.g. OmniRoute exposing an nvidia-nim backend — still more useful than the gateway label.
    const m = model({ id: 'nim/llama', ownedBy: 'nvidia-nim', provider: 'nim', providerLabel: 'OmniRoute' })
    expect(sourceKey(m)).toBe('nvidia-nim')
  })

  it('falls back to owned_by when a generic backend has no provider label (pre-upgrade cache)', () => {
    const m = model({ id: 'qwen27b', ownedBy: 'vllm' })
    expect(sourceKey(m)).toBe('vllm')
  })

  it('routes no-think wrapper models to their own bucket', () => {
    const m = model({ id: 'no-think/cc/opus', provider: 'no-think', ownedBy: 'claude' })
    expect(sourceKey(m)).toBe('no-think')
  })
})

describe('chipLabel — the per-row provider chip', () => {
  it('shows the provider label instead of "default" for a prefix-less id', () => {
    const m = model({ id: 'qwen27b', ownedBy: 'vllm', providerLabel: 'runpod2' })
    expect(chipLabel(m)).toBe('runpod2')
  })

  it('keeps the route prefix when the id has one', () => {
    const m = model({ id: 'openrouter/openai/gpt', provider: 'openrouter', providerLabel: 'OmniRoute' })
    expect(chipLabel(m)).toBe('openrouter')
  })
})
