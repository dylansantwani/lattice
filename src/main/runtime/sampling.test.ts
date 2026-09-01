import { describe, expect, it } from 'vitest'
import { samplingParams } from './runManager'

// samplingParams turns the two opt-in Settings fields into request params, omitting each
// field entirely (undefined) when the user hasn't overridden it — so the provider/model
// default is used rather than a hard-coded value.
describe('samplingParams', () => {
  it('omits both when unset (null temperature, 0 max tokens)', () => {
    expect(samplingParams({ temperature: null, maxOutputTokens: 0 })).toEqual({
      temperature: undefined,
      maxTokens: undefined
    })
  })

  it('passes a concrete temperature through, including 0', () => {
    expect(samplingParams({ temperature: 0, maxOutputTokens: 0 }).temperature).toBe(0)
    expect(samplingParams({ temperature: 0.7, maxOutputTokens: 0 }).temperature).toBe(0.7)
  })

  it('passes a positive max-output cap through and omits a non-positive one', () => {
    expect(samplingParams({ temperature: null, maxOutputTokens: 4096 }).maxTokens).toBe(4096)
    expect(samplingParams({ temperature: null, maxOutputTokens: 0 }).maxTokens).toBeUndefined()
  })
})
