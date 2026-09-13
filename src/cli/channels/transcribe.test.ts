import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTranscriber,
  describeTranscription,
  findWhisperPython,
  LOCAL_WHISPER_SCRIPT,
  parseWhisperOutput,
  whisperPythonCandidates,
  type ExecFileFn
} from './transcribe'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lattice-transcribe-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const note = { path: '/tmp/voice-1.ogg', name: 'voice-1.ogg', mime: 'audio/ogg', kind: 'audio' as const }

describe('local faster-whisper transcription', () => {
  it('runs the script with the audio path, model and language, and reads the JSON line', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const run: ExecFileFn = async (file, args) => {
      calls.push({ file, args })
      return { stdout: 'some library warning\n{"text": "call grandma on sunday", "language": "en", "duration": 3.1}\n', stderr: '' }
    }
    const transcribe = createTranscriber({ provider: 'local', python: '/venv/bin/python', model: 'small', language: 'en' }, fetch, run)
    await expect(transcribe(note)).resolves.toBe('call grandma on sunday')
    expect(calls).toEqual([{ file: '/venv/bin/python', args: ['-c', LOCAL_WHISPER_SCRIPT, '/tmp/voice-1.ogg', 'small', 'en'] }])
  })

  it('fails clearly when the script prints no result or no python is configured', async () => {
    expect(() => parseWhisperOutput('Traceback: boom')).toThrow(/no result/)
    await expect(createTranscriber({ provider: 'local', model: 'small' })(note)).rejects.toThrow(/no Python configured/)
  })

  it('finds the first interpreter that can import faster_whisper', async () => {
    const tried: string[] = []
    const run: ExecFileFn = async (file) => {
      tried.push(file)
      if (file !== '/b/python') throw new Error('ModuleNotFoundError')
      return { stdout: '', stderr: '' }
    }
    await expect(findWhisperPython(['/a/python', '/b/python', 'python3'], run)).resolves.toBe('/b/python')
    expect(tried).toEqual(['/a/python', '/b/python'])
    await expect(findWhisperPython(['/a/python'], run)).resolves.toBeUndefined()
  })

  it('tries an override, then Hermes Agent’s venv when present, then python3', () => {
    const hermes = join(dir, '.hermes')
    mkdirSync(join(hermes, 'hermes-agent', 'venv', 'bin'), { recursive: true })
    writeFileSync(join(hermes, 'hermes-agent', 'venv', 'bin', 'python'), '')
    expect(whisperPythonCandidates({ HERMES_HOME: hermes }, dir)).toEqual([join(hermes, 'hermes-agent', 'venv', 'bin', 'python'), 'python3'])
    expect(whisperPythonCandidates({ LATTICE_WHISPER_PYTHON: 'python3.12' }, join(dir, 'nobody'))).toEqual(['python3.12', 'python3'])
  })
})

describe('OpenAI-compatible transcription', () => {
  it('posts the file as multipart with the model and key', async () => {
    const audio = join(dir, 'v.ogg')
    writeFileSync(audio, 'OggS')
    let seen: { url: string; auth?: string; model?: unknown; language?: unknown } | undefined
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const form = init.body as FormData
      seen = { url, auth: (init.headers as Record<string, string>).authorization, model: form.get('model'), language: form.get('language') }
      return new Response(JSON.stringify({ text: 'hello there' }), { status: 200 })
    }) as unknown as typeof fetch
    const transcribe = createTranscriber({ baseUrl: 'https://api.groq.com/openai/v1/', apiKey: 'k', model: 'whisper-large-v3-turbo' }, fakeFetch)
    await expect(transcribe({ ...note, path: audio })).resolves.toBe('hello there')
    expect(seen).toEqual({ url: 'https://api.groq.com/openai/v1/audio/transcriptions', auth: 'Bearer k', model: 'whisper-large-v3-turbo', language: null })
  })

  it('describes each provider for `channels status`', () => {
    expect(describeTranscription(undefined)).toBe('off')
    expect(describeTranscription({ provider: 'local', python: '/p', model: 'small' })).toBe('faster-whisper small on this machine (/p)')
    expect(describeTranscription({ baseUrl: 'https://x/v1', model: 'whisper-1' })).toBe('https://x/v1 (whisper-1)')
  })
})
