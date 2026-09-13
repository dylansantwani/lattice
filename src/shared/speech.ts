/**
 * Text-to-speech: settings and the text shaping shared by the renderer (playback) and the main
 * process (synthesis through an OpenAI-compatible endpoint). Pure — no DOM, no Node.
 */

export type SpeechEngine = 'system' | 'openai'

export interface SpeechSettings {
  /**
   * `system` — the operating system's voices through the Web Speech API: offline, free, instant.
   * `openai` — any OpenAI-compatible `/audio/speech` endpoint: a local Kokoro server, OpenAI, or a
   * gateway that fronts one. Falls back to `system` when the endpoint fails.
   */
  engine: SpeechEngine
  /** Read each reply aloud when it finishes in the open thread. */
  autoRead: boolean
  /** Speaking rate, 0.5–2 (1 = normal). */
  rate: number
  /** Skip fenced code blocks instead of reading them out. */
  skipCode: boolean
  /** System voice (`SpeechSynthesisVoice.voiceURI`); empty = the OS default voice. */
  systemVoice: string
  /** OpenAI-compatible base URL including `/v1`, e.g. a local Kokoro server at http://127.0.0.1:8880/v1. */
  baseUrl: string
  apiKey: string
  /** `kokoro`, `tts-1`, `gpt-4o-mini-tts`, … */
  model: string
  /** `af_heart` (Kokoro), `alloy` (OpenAI), … */
  voice: string
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  engine: 'system',
  autoRead: false,
  rate: 1,
  skipCode: true,
  systemVoice: '',
  baseUrl: 'http://127.0.0.1:8880/v1',
  apiKey: '',
  model: 'kokoro',
  voice: 'af_heart'
}

/** Presets for the OpenAI-compatible engine, offered as one-click fills in Settings. */
export const SPEECH_PRESETS: Array<{ id: string; label: string; baseUrl: string; model: string; voice: string; needsKey: boolean }> = [
  { id: 'kokoro', label: 'Kokoro (local, free)', baseUrl: 'http://127.0.0.1:8880/v1', model: 'kokoro', voice: 'af_heart', needsKey: false },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy', needsKey: true }
]

/** Settings stored before speech existed, or partially, resolved against the defaults. */
export function resolveSpeechSettings(stored: Partial<SpeechSettings> | undefined): SpeechSettings {
  const merged = { ...DEFAULT_SPEECH_SETTINGS, ...(stored ?? {}) }
  const rate = Number(merged.rate)
  return { ...merged, rate: Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1 }
}

const FENCE = /^\s*(```|~~~)/

/**
 * Markdown → words worth hearing. Code blocks are skipped (or announced), tables are dropped,
 * links read as their label, emphasis and heading marks vanish, bare URLs are shortened to their
 * host so the voice does not spell out a query string.
 */
export function speechTextFromMarkdown(markdown: string, options: { skipCode?: boolean } = {}): string {
  const skipCode = options.skipCode ?? true
  const out: string[] = []
  let inCode = false
  let announced = false
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE.test(raw)) {
      inCode = !inCode
      if (inCode && skipCode && !announced) {
        out.push('(code block)')
        announced = true
      }
      if (!inCode) announced = false
      continue
    }
    if (inCode) {
      if (!skipCode) out.push(raw)
      continue
    }
    let line = raw
    // Table rows and separators carry layout, not sentences.
    if (/^\s*\|.*\|\s*$/.test(line)) continue
    line = line.replace(/<[^>]+>/g, '')
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '')
    line = line.replace(/^\s*>\s?/, '')
    line = line.replace(/^(\s*)([-*+]|\d+[.)])\s+/, '$1')
    line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    line = line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Keep sentence punctuation that follows a URL: it belongs to the sentence, not the address.
    line = line.replace(/https?:\/\/([^/\s)]+)[^\s)]*?([.,!?;:]*)(?=\s|\)|$)/g, (_m, host: string, tail: string) => host.replace(/^www\./, '') + tail)
    line = line.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a: string | undefined, b: string | undefined) => a ?? b ?? '')
    line = line.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    line = line.replace(/~~([^~]+)~~/g, '$1')
    line = line.replace(/`([^`]+)`/g, '$1')
    line = line.replace(/^\s*[-*_]{3,}\s*$/, '')
    out.push(line)
  }
  return out
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Split speech text into chunks of at most `max` characters at sentence boundaries. Short chunks
 * start playing sooner (the first sentence is audible while the rest synthesizes) and avoid the
 * Web Speech API's habit of silently stopping long utterances.
 */
export function splitForSpeech(text: string, max = 280): string[] {
  const chunks: string[] = []
  const paragraphs = text.split(/\n{2,}/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean)
  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) ?? [paragraph]
    let current = ''
    for (const raw of sentences) {
      const sentence = raw.trim()
      if (!sentence) continue
      if (sentence.length > max) {
        if (current) {
          chunks.push(current)
          current = ''
        }
        // A run-on sentence: break at commas, then words.
        let rest = sentence
        while (rest.length > max) {
          const window = rest.slice(0, max)
          const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' '))
          const at = cut > max * 0.4 ? cut + 1 : max
          chunks.push(rest.slice(0, at).trim())
          rest = rest.slice(at).trim()
        }
        current = rest
        continue
      }
      if (current && current.length + 1 + sentence.length > max) {
        chunks.push(current)
        current = sentence
      } else {
        current = current ? `${current} ${sentence}` : sentence
      }
    }
    if (current) chunks.push(current)
  }
  return chunks
}
