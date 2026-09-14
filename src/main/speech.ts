/**
 * Speech synthesis through an OpenAI-compatible `/audio/speech` endpoint (a local Kokoro server,
 * OpenAI, or a gateway in front of either). Runs in the main process so the API key never reaches
 * the renderer and local HTTP servers need no CORS headers. The system engine (Web Speech API) is
 * handled entirely in the renderer and never comes through here.
 */
import type { SpeechAudio } from '@shared/ipc'
import { resolveSpeechSettings, type SpeechSettings } from '@shared/speech'

const TIMEOUT_MS = 60_000
/** One request per sentence-sized chunk; anything longer is a caller bug, not a reply to read. */
const MAX_INPUT_CHARS = 4_096
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']

const normalizeBase = (url: string | undefined): string => (url ?? '').trim().replace(/\/+$/, '').toLowerCase()

/**
 * Stored settings with the caller's overrides applied — except the stored API key, which is only
 * ever sent to the stored endpoint. An override that points somewhere else must bring its own key;
 * otherwise a caller could aim the main process (and the user's real key) at any host it likes.
 */
export function effectiveSpeechSettings(stored: Partial<SpeechSettings> | undefined, overrides: Partial<SpeechSettings> = {}): SpeechSettings {
  const sameEndpoint = overrides.baseUrl === undefined || normalizeBase(overrides.baseUrl) === normalizeBase(stored?.baseUrl)
  const apiKey = overrides.apiKey !== undefined ? overrides.apiKey : sameEndpoint ? stored?.apiKey ?? '' : ''
  return resolveSpeechSettings({ ...stored, ...overrides, apiKey })
}

function endpoint(settings: SpeechSettings, path: string): string {
  const base = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new Error('Set an http(s) base URL for the speech endpoint in Settings → Voice.')
  return `${base}${path}`
}

function headers(settings: SpeechSettings): Record<string, string> {
  return { 'content-type': 'application/json', ...(settings.apiKey.trim() ? { authorization: `Bearer ${settings.apiKey.trim()}` } : {}) }
}

async function failure(response: Response, what: string): Promise<Error> {
  let detail = ''
  try {
    const body = await response.text()
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; detail?: unknown }
    detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? (parsed.detail ? JSON.stringify(parsed.detail) : body)
  } catch {
    /* non-JSON error body */
  }
  return new Error(`${what} failed: HTTP ${response.status}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
}

export async function synthesizeSpeech(
  text: string,
  stored: Partial<SpeechSettings> | undefined,
  overrides: Partial<SpeechSettings> = {},
  fetchImpl: typeof fetch = fetch
): Promise<SpeechAudio> {
  const settings = effectiveSpeechSettings(stored, overrides)
  const input = text.trim()
  if (!input) throw new Error('Nothing to read.')
  if (input.length > MAX_INPUT_CHARS) throw new Error(`Speech input is ${input.length} characters; split it (max ${MAX_INPUT_CHARS}).`)
  let response: Response
  try {
    response = await fetchImpl(endpoint(settings, '/audio/speech'), {
      method: 'POST',
      headers: headers(settings),
      body: JSON.stringify({ model: settings.model, voice: settings.voice, input, response_format: 'mp3', speed: settings.rate }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (error) {
    const reason = (error as Error).name === 'TimeoutError' ? 'timed out' : (error as Error).message
    throw new Error(`Could not reach the speech endpoint at ${settings.baseUrl} (${reason}).`)
  }
  if (!response.ok) throw await failure(response, 'Speech synthesis')
  const mime = (response.headers.get('content-type') ?? 'audio/mpeg').split(';')[0]!.trim()
  if (mime.startsWith('application/json') || mime.startsWith('text/')) throw await failure(response, 'Speech synthesis (non-audio reply)')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('The speech endpoint returned no audio.')
  return { mime: mime || 'audio/mpeg', base64: bytes.toString('base64') }
}

export async function listSpeechVoices(
  stored: Partial<SpeechSettings> | undefined,
  overrides: Partial<SpeechSettings> = {},
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const settings = effectiveSpeechSettings(stored, overrides)
  if (/api\.openai\.com/i.test(settings.baseUrl)) return OPENAI_VOICES
  try {
    // Kokoro-FastAPI and most local servers: GET /audio/voices → { voices: [...] } or [...]
    const response = await fetchImpl(endpoint(settings, '/audio/voices'), { headers: headers(settings), signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return OPENAI_VOICES
    const body = (await response.json()) as unknown
    const list = Array.isArray(body) ? body : (body as { voices?: unknown }).voices
    if (!Array.isArray(list)) return OPENAI_VOICES
    const names = list.map((voice) => (typeof voice === 'string' ? voice : (voice as { id?: string; name?: string }).id ?? (voice as { name?: string }).name)).filter((name): name is string => !!name)
    return names.length ? names : OPENAI_VOICES
  } catch {
    return OPENAI_VOICES
  }
}
