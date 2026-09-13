/**
 * Voice-note transcription. Two providers:
 *
 *  - `local`: faster-whisper on this machine, run through a Python that can import it. Free, private,
 *    and no key — a Telegram voice note (OGG/Opus) decodes through PyAV without a separate ffmpeg.
 *    The `small` model takes a few seconds per note on an Apple-silicon CPU.
 *  - `openai` (the default for configs that name a `baseUrl`): any OpenAI-compatible
 *    `/audio/transcriptions` endpoint — OpenAI, Groq's free tier, or a local whisper server.
 *
 * Optional: without it the router asks the owner to type instead.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptionConfig } from './config'
import type { InboundAttachment } from './types'

export const DEFAULT_LOCAL_WHISPER_MODEL = 'small'

/** Prints one JSON line: {"text": …, "language": …, "duration": …}. */
export const LOCAL_WHISPER_SCRIPT = [
  'import json, os, sys',
  "os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')",
  'from faster_whisper import WhisperModel',
  'path, model, language = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "") or None',
  "whisper = WhisperModel(model, device='cpu', compute_type='int8')",
  'segments, info = whisper.transcribe(path, language=language, vad_filter=True, beam_size=5)',
  "text = ' '.join(segment.text.strip() for segment in segments).strip()",
  "print(json.dumps({'text': text, 'language': info.language, 'duration': round(info.duration, 2)}))"
].join('\n')

export type ExecFileFn = (file: string, args: string[], options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>

export const execFileAsync: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr).trim().split('\n').filter(Boolean).at(-1)
        reject(new Error(detail ? `${error.message.split('\n')[0]}: ${detail}` : error.message))
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })

/** The JSON line the script printed; faster-whisper and its libraries may log around it. */
export function parseWhisperOutput(stdout: string): { text: string; language?: string; duration?: number } {
  const line = stdout
    .split('\n')
    .map((item) => item.trim())
    .reverse()
    .find((item) => item.startsWith('{') && item.endsWith('}'))
  if (!line) throw new Error('faster-whisper printed no result')
  const parsed = JSON.parse(line) as { text?: unknown; language?: unknown; duration?: unknown }
  return {
    text: typeof parsed.text === 'string' ? parsed.text : '',
    language: typeof parsed.language === 'string' ? parsed.language : undefined,
    duration: typeof parsed.duration === 'number' ? parsed.duration : undefined
  }
}

export async function transcribeLocally(
  config: Pick<TranscriptionConfig, 'python' | 'model' | 'language'>,
  audioPath: string,
  run: ExecFileFn = execFileAsync
): Promise<{ text: string; language?: string; duration?: number }> {
  if (!config.python) throw new Error('local transcription has no Python configured; run `lattice channels setup transcription --local`')
  const { stdout } = await run(config.python, ['-c', LOCAL_WHISPER_SCRIPT, audioPath, config.model || DEFAULT_LOCAL_WHISPER_MODEL, config.language ?? ''], {
    timeout: 5 * 60_000,
    maxBuffer: 4 * 1024 * 1024
  })
  return parseWhisperOutput(stdout)
}

/** Interpreters worth trying, most specific first: an explicit override, Hermes Agent's venv, then PATH. */
export function whisperPythonCandidates(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const candidates = [
    env.LATTICE_WHISPER_PYTHON,
    join(env.HERMES_HOME ?? join(home, '.hermes'), 'hermes-agent', 'venv', 'bin', 'python'),
    'python3'
  ].filter((item): item is string => !!item)
  return [...new Set(candidates)].filter((item) => !item.includes('/') || existsSync(item))
}

/** The first candidate that can import faster_whisper, or undefined. */
export async function findWhisperPython(candidates = whisperPythonCandidates(), run: ExecFileFn = execFileAsync): Promise<string | undefined> {
  for (const python of candidates) {
    try {
      await run(python, ['-c', 'import faster_whisper'], { timeout: 60_000, maxBuffer: 1024 * 1024 })
      return python
    } catch {
      /* not this one */
    }
  }
  return undefined
}

export function describeTranscription(config: TranscriptionConfig | undefined): string {
  if (!config) return 'off'
  if (config.provider === 'local') return `faster-whisper ${config.model || DEFAULT_LOCAL_WHISPER_MODEL} on this machine (${config.python ?? 'no python'})`
  return `${config.baseUrl ?? '(no URL)'} (${config.model})`
}

export function createTranscriber(config: TranscriptionConfig, fetchImpl: typeof fetch = fetch, run: ExecFileFn = execFileAsync): (attachment: InboundAttachment) => Promise<string> {
  if (config.provider === 'local') {
    return async (attachment) => (await transcribeLocally(config, attachment.path, run)).text
  }
  const url = `${(config.baseUrl ?? '').replace(/\/$/, '')}/audio/transcriptions`
  return async (attachment) => {
    const form = new FormData()
    form.append('model', config.model)
    if (config.language) form.append('language', config.language)
    form.append('file', new Blob([readFileSync(attachment.path)], { type: attachment.mime }), attachment.name)
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      body: form
    })
    if (!response.ok) throw new Error(`transcription failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
    const body = (await response.json()) as { text?: string }
    return body.text ?? ''
  }
}
