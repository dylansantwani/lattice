/**
 * Vision for models that cannot see.
 *
 * A thread on DeepSeek V4 Flash (or most local models) used to receive a user's photo, or a browser
 * screenshot a tool returned, as an `image_url` part the route either rejected with a 400 or quietly
 * dropped, so "what does this say?" got a confident guess. Nothing checked the model's vision flag.
 *
 * Now, before each request of such a model, every image in the wire is replaced by what a vision
 * model saw in it: one call per distinct image (keyed by the bytes' sha256 and stored), then the
 * same text on every later turn, so the replayed prefix stays byte-identical and cacheable.
 */
import { createHash } from 'node:crypto'
import type { AppSettings, ModelInfo, ProviderConfig, TurnTelemetry } from '@shared/types'
import type { StreamRequest, StreamChunk, WireContentPart, WireMessage } from '../providers/openaiCompat'

export const IMAGE_DESCRIPTION_PROMPT =
  'You are the eyes for an assistant that cannot see images. Describe this image so the assistant ' +
  'can answer questions about it without seeing it. Transcribe every piece of legible text exactly ' +
  '(headings, labels, messages, numbers, prices, error text, URLs), then describe what the image ' +
  'shows: the kind of image (photo, screenshot of which app or site, chart, document), layout, key ' +
  'objects or people, state (selected tabs, warnings, dialogs, progress), and anything unusual. Be ' +
  'factual, never guess at what is not visible, and stay under 300 words. Plain text, no preamble.'

/** Longest description kept; a runaway model cannot bloat every later turn with one image. */
const MAX_DESCRIPTION_CHARS = 2_400

export function imageSha256(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return createHash('sha256').update(payload).digest('hex')
}

/** Whether `modelId` can take image input, per the provider's listing (unknown models count as able). */
export function modelSeesImages(modelId: string, models: ModelInfo[]): boolean {
  const info = models.find((model) => model.id === modelId)
  return info ? info.capabilities.vision : true
}

function baseName(id: string): string {
  // "deepseek/deepseek-v4-flash-high" → "deepseek-v4-flash"
  const tail = id.split('/').pop() ?? id
  return tail.replace(/-(?:none|low|medium|high|xhigh|max)$/i, '').replace(/:[\w-]+$/, '')
}

function routePrefix(id: string): string {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : ''
}

/** Cheap, fast vision families: good at reading screenshots, priced for a per-image side call. */
const CHEAP_VISION = /haiku|flash|mini|nano|lite|small|gemma|qwen.*vl|pixtral/i
/** Effort-tier aliases of one model: describing an image never needs the xhigh variant. */
const EFFORT_ALIAS = /-(?:none|low|medium|high|xhigh|max)$/i

/**
 * The model that describes images for `threadModel`, or undefined when there is none. Order:
 * the user's `visionModel` setting; a vision sibling of the thread's model on the same route
 * ("deepseek/deepseek-v4-flash" → "deepseek/deepseek-v4-flash-vision-exp"), which shares its
 * billing and latency; the utility model when it has vision; then a cheap vision model on the same
 * route; then a cheap vision model anywhere. Chat models only, never an effort-tier alias.
 */
export function pickVisionModel(
  threadModel: string,
  models: ModelInfo[],
  settings: Pick<AppSettings, 'visionModel' | 'utilityModel'>
): string | undefined {
  const configured = settings.visionModel?.trim()
  if (configured) return configured
  const chat = models.filter((model) => (model.kind ?? 'chat') === 'chat' && model.capabilities.vision && model.id !== threadModel)
  const prefix = routePrefix(threadModel)
  const base = baseName(threadModel)
  const sameRoute = chat.filter((model) => routePrefix(model.id) === prefix && !EFFORT_ALIAS.test(model.id))
  const sibling = sameRoute
    .filter((model) => baseName(model.id).startsWith(base) || model.id.includes(`${base}-vision`))
    .sort((a, b) => a.id.length - b.id.length)[0]
  if (sibling) return sibling.id
  const utility = settings.utilityModel?.trim()
  if (utility && chat.some((model) => model.id === utility)) return utility
  const cheapSameRoute = sameRoute.filter((model) => CHEAP_VISION.test(model.id)).sort((a, b) => a.id.length - b.id.length)[0]
  if (cheapSameRoute) return cheapSameRoute.id
  const cheap = chat.filter((model) => CHEAP_VISION.test(model.id) && !EFFORT_ALIAS.test(model.id)).sort((a, b) => a.id.length - b.id.length)[0]
  return cheap?.id
}

export interface VisionDeps {
  visionModel: string
  provider: ProviderConfig
  stream: (provider: ProviderConfig, req: StreamRequest) => AsyncGenerator<StreamChunk>
  lookup: (sha256: string) => string | null
  store: (sha256: string, model: string, description: string) => void
  onUsage?: (usage: Partial<TurnTelemetry>) => void
  signal?: AbortSignal
  timeoutMs?: number
}

export async function describeImage(dataUrl: string, deps: VisionDeps): Promise<string> {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? 60_000)
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout
  let text = ''
  for await (const chunk of deps.stream(deps.provider, {
    model: deps.visionModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: IMAGE_DESCRIPTION_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    tools: [],
    cache: false,
    signal
  })) {
    if (chunk.type === 'text') text += chunk.text
    else if (chunk.type === 'usage') deps.onUsage?.(chunk.usage)
  }
  const description = text.trim()
  if (!description) throw new Error(`${deps.visionModel} returned no description`)
  return description.length > MAX_DESCRIPTION_CHARS ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}…` : description
}

/** The text part an image becomes. Deterministic for a given description, which keeps caching intact. */
export function describedImagePart(description: string): WireContentPart {
  return { type: 'text', text: `[image, described by a vision model because you cannot see images]\n${description}` }
}

const UNDESCRIBED_PART: WireContentPart = {
  type: 'text',
  text: '[an image was attached here, but no vision model was available to describe it; say you cannot see it if it matters]'
}

/**
 * Replace every image part in `wire` (in place) with its description. Each distinct image is
 * described at most once (stored via `deps.store`); an image whose description fails becomes a
 * short note instead of an image the model's route would reject. Returns how many images were
 * newly described. With no deps (no vision model anywhere) every image becomes the note.
 */
export async function describeWireImages(wire: WireMessage[], deps: VisionDeps | undefined): Promise<number> {
  let described = 0
  const pending = new Map<string, Promise<string | null>>()
  const resolveOne = (url: string): Promise<string | null> => {
    const sha = imageSha256(url)
    const cached = deps?.lookup(sha)
    if (cached) return Promise.resolve(cached)
    if (!deps) return Promise.resolve(null)
    let job = pending.get(sha)
    if (!job) {
      job = describeImage(url, deps).then(
        (description) => {
          deps.store(sha, deps.visionModel, description)
          described += 1
          return description
        },
        () => null
      )
      pending.set(sha, job)
    }
    return job
  }
  for (const message of wire) {
    if (!Array.isArray(message.content)) continue
    const parts = message.content
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!
      if (part.type !== 'image_url' || !part.image_url?.url) continue
      const description = await resolveOne(part.image_url.url)
      parts[index] = description ? describedImagePart(description) : UNDESCRIBED_PART
    }
  }
  return described
}

/** True when any message in `wire` still carries an image part. */
export function wireHasImages(wire: WireMessage[]): boolean {
  return wire.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'))
}
