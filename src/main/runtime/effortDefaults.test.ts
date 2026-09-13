import { describe, expect, it } from 'vitest'
import type { ThreadMeta } from '@shared/types'
import {
  BUILTIN_EFFORT_DEFAULTS,
  effortDefaultFor,
  effortForModelSwitch,
  withDerivedEffort
} from './effortDefaults'

/** The shape both helpers read, with the global default Lattice shipped before per-model tiers. */
function settings(defaultEffortByModel?: Record<string, string>, defaultEffort = 'high') {
  return { defaultEffort, defaultEffortByModel }
}

describe('effortDefaultFor — built-in opinions', () => {
  // The whole point of the change: `high` chosen for a local model must not follow the user onto a
  // hosted Claude route, where it costs seconds of time-to-first-token.
  it('gives every hosted Claude route a low tier, whatever the route prefix', () => {
    for (const model of [
      'claude-sonnet-5',
      'cc/claude-fable-5',
      'claude-opus-5',
      'openrouter/anthropic/claude-sonnet-5',
      'CLAUDE-SONNET-5'
    ]) {
      expect(effortDefaultFor(model, settings())).toBe('low')
    }
  })

  // `low`, not `none`: opus-5's tiers start at low, so `none` is not universally accepted — and low
  // already skips the long thinking phase the change is about.
  it('defaults Claude to low rather than none', () => {
    expect(BUILTIN_EFFORT_DEFAULTS['*claude*']).toBe('low')
  })

  it('has no opinion about local or other hosted models', () => {
    for (const model of ['mac/qwen3:30b-a3b', 'llamacpp/qwen3.6-35b-a3b', 'gpt-5.5', 'oc/muse-spark-1.2']) {
      expect(effortDefaultFor(model, settings())).toBeUndefined()
    }
  })

  it('has no opinion when the model is unknown', () => {
    expect(effortDefaultFor(undefined, settings())).toBeUndefined()
    expect(effortDefaultFor('', settings())).toBeUndefined()
  })
})

describe('effortDefaultFor — the user map', () => {
  it('matches exact ids, prefixes and infixes', () => {
    expect(effortDefaultFor('gpt-5.5', settings({ 'gpt-5.5': 'max' }))).toBe('max')
    expect(effortDefaultFor('openrouter/z-ai/glm-5.3', settings({ 'openrouter/*': 'medium' }))).toBe('medium')
    expect(effortDefaultFor('mac/qwen3:30b-a3b', settings({ '*qwen*': 'xhigh' }))).toBe('xhigh')
  })

  it('does not let a pattern match a longer id it only prefixes', () => {
    // `claude-opus-5` must not be captured by a pattern written for `claude-opus`.
    expect(effortDefaultFor('claude-opus-5', settings({ 'claude-opus': 'max' }))).toBe('low')
  })

  it('picks the most specific matching pattern', () => {
    const map = { '*': 'minimal', '*claude*': 'medium', 'claude-opus-5': 'max' }
    expect(effortDefaultFor('claude-opus-5', settings(map))).toBe('max')
    expect(effortDefaultFor('claude-sonnet-5', settings(map))).toBe('medium')
    expect(effortDefaultFor('mac/qwen3:30b-a3b', settings(map))).toBe('minimal')
  })

  // A user entry is the last word for the models it covers, even a broad one — otherwise there
  // would be no way to opt out of a built-in opinion.
  it('lets any matching user pattern override the built-in, however broad', () => {
    expect(effortDefaultFor('claude-sonnet-5', settings({ '*': 'max' }))).toBe('max')
    expect(effortDefaultFor('cc/claude-fable-5', settings({ '*claude*': 'high' }))).toBe('high')
  })

  it('falls back to the built-in for models the user map does not cover', () => {
    expect(effortDefaultFor('claude-sonnet-5', settings({ 'gpt-*': 'max' }))).toBe('low')
  })

  it('ignores half-filled rows instead of letting them capture everything', () => {
    expect(effortDefaultFor('mac/qwen3:30b-a3b', settings({ '': 'max' }))).toBeUndefined()
    expect(effortDefaultFor('mac/qwen3:30b-a3b', settings({ '*': '' }))).toBeUndefined()
    // A blank tier on a Claude pattern is "not configured", so the built-in still applies.
    expect(effortDefaultFor('claude-sonnet-5', settings({ '*claude*': '' }))).toBe('low')
  })

  it('treats regex metacharacters in a pattern as literals', () => {
    // `.` and `+` must not match anything but themselves, or `gpt-5.5` would capture `gpt-575`.
    expect(effortDefaultFor('gpt-575', settings({ 'gpt-5.5': 'max' }))).toBeUndefined()
    expect(effortDefaultFor('gpt-5.5', settings({ 'gpt-5.5': 'max' }))).toBe('max')
  })
})

describe('effortForModelSwitch', () => {
  // The path that actually matters for Dylan's setup: a thread is created on the default local
  // model at the global `high`, then re-pointed at Claude from the composer.
  it('re-derives an inherited tier when the model switches to Claude', () => {
    expect(effortForModelSwitch('high', 'mac/qwen3:30b-a3b', 'claude-sonnet-5', settings())).toBe('low')
  })

  it('re-derives back to the global default when switching away from Claude', () => {
    expect(effortForModelSwitch('low', 'claude-sonnet-5', 'mac/qwen3:30b-a3b', settings())).toBe('high')
  })

  // A tier the user chose for this thread is a deliberate act and outranks any default.
  it('leaves a hand-picked tier alone', () => {
    expect(effortForModelSwitch('max', 'mac/qwen3:30b-a3b', 'claude-sonnet-5', settings())).toBe('max')
    expect(effortForModelSwitch('minimal', 'claude-sonnet-5', 'gpt-5.5', settings())).toBe('minimal')
  })

  it('leaves a tier alone when the switch does not change which default applies', () => {
    expect(effortForModelSwitch('low', 'claude-sonnet-5', 'cc/claude-fable-5', settings())).toBe('low')
    expect(effortForModelSwitch('high', 'mac/qwen3:30b-a3b', 'gpt-5.5', settings())).toBe('high')
  })

  it('honours the user map on both sides of the switch', () => {
    const s = settings({ '*claude*': 'medium', 'gpt-*': 'xhigh' })
    expect(effortForModelSwitch('medium', 'claude-sonnet-5', 'gpt-5.5', s)).toBe('xhigh')
    expect(effortForModelSwitch('xhigh', 'gpt-5.5', 'claude-sonnet-5', s)).toBe('medium')
  })

  it('treats a thread with no effort as inheriting an unset global default', () => {
    const s = { defaultEffort: undefined, defaultEffortByModel: undefined }
    expect(effortForModelSwitch(undefined, 'mac/qwen3:30b-a3b', 'claude-sonnet-5', s)).toBe('low')
    // …but an explicit tier on a thread whose global default is unset is still hand-picked.
    expect(effortForModelSwitch('high', 'mac/qwen3:30b-a3b', 'claude-sonnet-5', s)).toBe('high')
  })
})

describe('withDerivedEffort — the thread-update patch', () => {
  const meta = { model: 'mac/qwen3:30b-a3b', effort: 'high' }

  it('carries the tier along with a model switch', () => {
    expect(withDerivedEffort({ model: 'claude-sonnet-5' }, meta, settings())).toEqual({
      model: 'claude-sonnet-5',
      effort: 'low'
    })
  })

  it('leaves a patch that names its own effort exactly as it is', () => {
    const patch: Partial<ThreadMeta> = { model: 'claude-sonnet-5', effort: 'max' }
    expect(withDerivedEffort(patch, meta, settings())).toBe(patch)
  })

  it('leaves patches that do not touch the model alone', () => {
    const patch: Partial<ThreadMeta> = { title: 'renamed' }
    expect(withDerivedEffort(patch, meta, settings())).toBe(patch)
  })

  it('does nothing when the patch re-sets the same model', () => {
    const patch: Partial<ThreadMeta> = { model: meta.model }
    expect(withDerivedEffort(patch, meta, settings())).toBe(patch)
  })

  it('does nothing for an unknown thread, leaving the store to reject the update', () => {
    const patch: Partial<ThreadMeta> = { model: 'claude-sonnet-5' }
    expect(withDerivedEffort(patch, undefined, settings())).toBe(patch)
  })

  it('does not add an effort key when the derived tier is the one already stored', () => {
    // Switching between two models that share a default must not write a redundant field.
    const onClaude = { model: 'claude-sonnet-5', effort: 'low' }
    const patch: Partial<ThreadMeta> = { model: 'cc/claude-fable-5' }
    expect(withDerivedEffort(patch, onClaude, settings())).toBe(patch)
  })

  it('leaves a hand-picked tier alone across a model switch', () => {
    const handPicked = { model: 'mac/qwen3:30b-a3b', effort: 'max' }
    const patch: Partial<ThreadMeta> = { model: 'claude-sonnet-5' }
    expect(withDerivedEffort(patch, handPicked, settings())).toBe(patch)
  })
})
