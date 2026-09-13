import { describe, expect, it } from 'vitest'
import type { ModelInfo, ProviderConfig } from '@shared/types'
import type { StreamChunk, StreamRequest, WireMessage } from '../providers/openaiCompat'
import { describeWireImages, imageSha256, modelSeesImages, pickVisionModel, wireHasImages, type VisionDeps } from './visionFallback'

function model(id: string, vision: boolean, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: id,
    provider: id.split('/')[0] ?? '',
    contextLength: 128_000,
    maxOutputTokens: 4_096,
    capabilities: { vision, tools: true, reasoning: false, effortTiers: [] },
    ...extra
  }
}

const MODELS = [
  model('deepseek/deepseek-v4-flash', false),
  model('deepseek/deepseek-v4-flash-high', false),
  model('deepseek/deepseek-v4-flash-vision-exp', true),
  model('deepseek/deepseek-v4-flash-vision-exp-xhigh', true),
  model('cc/claude-opus-5', true),
  model('cc/claude-haiku-4-5-20251001', true),
  model('openrouter/some/image-gen', true, { kind: 'image' }),
  model('mac/qwen3:30b-a3b', false)
]

describe('pickVisionModel', () => {
  it('prefers the configured setting', () => {
    expect(pickVisionModel('deepseek/deepseek-v4-flash', MODELS, { visionModel: 'cc/claude-opus-5' })).toBe('cc/claude-opus-5')
  })

  it('finds the vision sibling on the same route, not an effort alias', () => {
    expect(pickVisionModel('deepseek/deepseek-v4-flash', MODELS, {})).toBe('deepseek/deepseek-v4-flash-vision-exp')
    expect(pickVisionModel('deepseek/deepseek-v4-flash-high', MODELS, {})).toBe('deepseek/deepseek-v4-flash-vision-exp')
  })

  it('falls back to a vision-capable utility model, then a cheap vision chat model anywhere', () => {
    expect(pickVisionModel('mac/qwen3:30b-a3b', MODELS, { utilityModel: 'cc/claude-opus-5' })).toBe('cc/claude-opus-5')
    expect(pickVisionModel('mac/qwen3:30b-a3b', MODELS, {})).toBe('cc/claude-haiku-4-5-20251001')
  })

  it('never picks a non-chat model and returns undefined when nothing can see', () => {
    expect(pickVisionModel('mac/qwen3:30b-a3b', [model('mac/qwen3:30b-a3b', false), model('x/image-gen', true, { kind: 'image' })], {})).toBeUndefined()
  })
})

describe('modelSeesImages', () => {
  it('reads the listing and assumes unknown models can see', () => {
    expect(modelSeesImages('deepseek/deepseek-v4-flash', MODELS)).toBe(false)
    expect(modelSeesImages('cc/claude-opus-5', MODELS)).toBe(true)
    expect(modelSeesImages('unlisted/model', MODELS)).toBe(true)
  })
})

describe('describeWireImages', () => {
  const PHOTO = 'data:image/jpeg;base64,/9j/PHOTO'
  const SHOT = 'data:image/png;base64,iVBORSHOT'

  function harness(fail = false): { deps: VisionDeps; calls: StreamRequest[]; stored: Map<string, string> } {
    const calls: StreamRequest[] = []
    const stored = new Map<string, string>()
    const deps: VisionDeps = {
      visionModel: 'deepseek/deepseek-v4-flash-vision-exp',
      provider: { id: 'p' } as ProviderConfig,
      stream: async function* (_provider, req): AsyncGenerator<StreamChunk> {
        calls.push(req)
        if (fail) throw new Error('boom')
        const url = (req.messages[0]!.content as { image_url?: { url: string } }[])[1]!.image_url!.url
        yield { type: 'text', text: url === PHOTO ? 'A receipt for $12.40 from Blue Bottle.' : 'eBay captcha page.' }
        yield { type: 'usage', usage: { tokensIn: 900, tokensOut: 20 } }
      },
      lookup: (sha) => stored.get(sha) ?? null,
      store: (sha, _model, description) => stored.set(sha, description)
    }
    return { deps, calls, stored }
  }

  function wire(): WireMessage[] {
    return [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: PHOTO } }] },
      { role: 'assistant', content: null, tool_calls: [] },
      { role: 'user', content: [{ type: 'text', text: 'Image returned by the tool call above:' }, { type: 'image_url', image_url: { url: SHOT } }, { type: 'image_url', image_url: { url: PHOTO } }] }
    ]
  }

  it('replaces every image with its description, describing each distinct image once', async () => {
    const { deps, calls, stored } = harness()
    const w = wire()
    expect(wireHasImages(w)).toBe(true)
    expect(await describeWireImages(w, deps)).toBe(2)
    expect(calls).toHaveLength(2)
    expect(wireHasImages(w)).toBe(false)
    expect(JSON.stringify(w)).toContain('A receipt for $12.40 from Blue Bottle.')
    expect(JSON.stringify(w)).toContain('eBay captcha page.')
    expect(stored.get(imageSha256(PHOTO))).toBe('A receipt for $12.40 from Blue Bottle.')
    // The next turn replays the same images: served from the store, byte-identical text.
    const again = wire()
    expect(await describeWireImages(again, deps)).toBe(0)
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(again)).toBe(JSON.stringify(w))
  })

  it('turns an image it could not describe into a note instead of a part the route rejects', async () => {
    const { deps } = harness(true)
    const w = wire()
    await describeWireImages(w, deps)
    expect(wireHasImages(w)).toBe(false)
    expect(JSON.stringify(w)).toContain('no vision model was available')
    const none = wire()
    await describeWireImages(none, undefined)
    expect(wireHasImages(none)).toBe(false)
  })
})
