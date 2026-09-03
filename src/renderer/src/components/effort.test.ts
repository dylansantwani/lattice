import { describe, expect, it } from 'vitest'
import { knownEffortTiers, orderTiers, resolveEffortTiers } from './effort'

function reasoningModel(id: string, effortTiers: string[] = []) {
  return {
    id,
    name: id,
    capabilities: { reasoning: true, effortTiers }
  }
}

describe('knownEffortTiers', () => {
  it('fills the complete GPT-5.6 ladder when the provider omits metadata', () => {
    const expected = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
    expect(knownEffortTiers('openrouter/openai/gpt-5.6-sol')).toEqual(expected)
    expect(knownEffortTiers('openrouter/openai/gpt-5.6-terra')).toEqual(expected)
    expect(knownEffortTiers('openrouter/openai/gpt-5.6-luna')).toEqual(expected)
  })

  it('keeps the gateway-only Ultra tier limited to the routes that support it', () => {
    expect(knownEffortTiers('cx/gpt-5.6-sol')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra'
    ])
    expect(knownEffortTiers('codex/gpt-5.6-terra')).toContain('ultra')
    expect(knownEffortTiers('codex/gpt-5.6-luna')).not.toContain('ultra')
    expect(knownEffortTiers('openrouter/openai/gpt-5.6-sol')).not.toContain('ultra')
  })

  it('uses model-specific GPT-5 ranges instead of the generic fallback', () => {
    expect(knownEffortTiers('gpt-5.5')).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(knownEffortTiers('gpt-5.5-pro')).toEqual(['medium', 'high', 'xhigh'])
    expect(knownEffortTiers('gpt-5.4-mini')).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(knownEffortTiers('gpt-5.3-codex')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(knownEffortTiers('gpt-5.2')).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(knownEffortTiers('gpt-5.1')).toEqual(['none', 'low', 'medium', 'high'])
    expect(knownEffortTiers('gpt-5')).toEqual(['minimal', 'low', 'medium', 'high'])
  })
})

describe('effort tier composition', () => {
  it('orders all standard and gateway-specific tiers', () => {
    expect(orderTiers(['ultra', 'max', 'low', 'none', 'xhigh'])).toEqual([
      'none',
      'low',
      'xhigh',
      'max',
      'ultra'
    ])
  })

  it('restores GPT-5.6 Luna max when the gateway only declares lower tiers', () => {
    expect(
      resolveEffortTiers(
        reasoningModel('openrouter/openai/gpt-5.6-luna', ['none', 'low', 'medium', 'high', 'xhigh'])
      )
    ).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('preserves declared gateway tiers that are not part of the standard OpenAI ladder', () => {
    expect(
      resolveEffortTiers(reasoningModel('gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']))
    ).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  })
})
