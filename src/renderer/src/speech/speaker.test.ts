import { describe, expect, it } from 'vitest'
import type { SpeechAudio } from '@shared/ipc'
import { Speaker, type AudioLike, type SpeakerDeps, type SpeakerState } from './speaker'

type FakeUtterance = SpeechSynthesisUtterance & { text: string }

class FakeSynth {
  queue: FakeUtterance[] = []
  canceled = 0
  voices = [{ voiceURI: 'com.apple.voice.Samantha', name: 'Samantha' }] as SpeechSynthesisVoice[]
  speak(utterance: SpeechSynthesisUtterance): void {
    this.queue.push(utterance as FakeUtterance)
  }
  cancel(): void {
    this.canceled += 1
    const pending = this.queue.splice(0)
    for (const utterance of pending) utterance.onerror?.({ error: 'canceled' } as SpeechSynthesisErrorEvent)
  }
  getVoices(): SpeechSynthesisVoice[] {
    return this.voices
  }
  /** Play the queue to the end, firing start/end like a browser. */
  finishAll(): void {
    const pending = this.queue.splice(0)
    pending.forEach((utterance, index) => {
      if (index === 0) utterance.onstart?.({} as SpeechSynthesisEvent)
      utterance.onend?.({} as SpeechSynthesisEvent)
    })
  }
}

class FakeAudio implements AudioLike {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  paused = false
  constructor(readonly source: SpeechAudio) {}
  play(): Promise<void> {
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
}

function setup(overrides: Partial<SpeakerDeps> = {}) {
  const synth = new FakeSynth()
  const audios: FakeAudio[] = []
  const released: string[] = []
  const synthesized: string[] = []
  const errors: string[] = []
  const states: SpeakerState[] = []
  const speaker = new Speaker({
    synth,
    makeUtterance: (text) => ({ text, rate: 1 } as unknown as SpeechSynthesisUtterance),
    synthesize: async (text) => {
      synthesized.push(text)
      return { mime: 'audio/mpeg', base64: btoa(text) }
    },
    makeAudio: (audio) => {
      const element = new FakeAudio(audio)
      audios.push(element)
      return { element, release: () => released.push(audio.base64) }
    },
    onError: (message) => errors.push(message),
    ...overrides
  })
  speaker.subscribe((state) => states.push(state))
  return { speaker, synth, audios, released, synthesized, errors, states }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Speaker with the system engine', () => {
  it('queues one utterance per sentence chunk with the chosen voice and rate, skipping code', async () => {
    const { speaker, synth, states } = setup()
    const long = `${'This sentence is here to fill space. '.repeat(10)}\n\n\`\`\`ts\nconst secret = 1\n\`\`\``
    const done = speaker.speak('m1', long, { systemVoice: 'com.apple.voice.Samantha', rate: 1.5 })
    expect(synth.queue.length).toBeGreaterThan(1)
    expect(synth.queue.every((utterance) => utterance.rate === 1.5 && utterance.voice?.name === 'Samantha')).toBe(true)
    expect(synth.queue.map((utterance) => utterance.text).join(' ')).not.toContain('secret')
    expect(speaker.isSpeaking('m1')).toBe(true)
    synth.finishAll()
    await done
    expect(states.map((state) => state.status)).toEqual(['loading', 'speaking', 'idle'])
    expect(speaker.getState()).toEqual({ id: null, status: 'idle' })
  })

  it('toggle on the same message stops it; starting another message replaces it', async () => {
    const { speaker, synth } = setup()
    const first = speaker.speak('m1', 'Hello there.', {})
    const second = speaker.speak('m2', 'Another reply.', {})
    expect(synth.canceled).toBeGreaterThan(0)
    expect(speaker.getState().id).toBe('m2')
    await speaker.toggle('m2', 'Another reply.', {})
    expect(speaker.getState()).toEqual({ id: null, status: 'idle' })
    await Promise.all([first, second])
  })

  it('cancels the rest of the queue when a chunk fails for real, so nothing plays after going idle', async () => {
    const { speaker, synth, errors } = setup()
    const done = speaker.speak('m1', 'This sentence is here to fill space. '.repeat(20), {})
    const before = synth.canceled
    const queued = synth.queue.length
    expect(queued).toBeGreaterThan(2)
    synth.queue[1]!.onerror?.({ error: 'voice-unavailable' } as SpeechSynthesisErrorEvent)
    await done
    expect(errors).toEqual(['System voice failed: voice-unavailable'])
    expect(synth.canceled).toBe(before + 1)
    expect(synth.queue).toHaveLength(0)
    expect(speaker.getState().status).toBe('idle')
  })

  it('does nothing for text with nothing to say', async () => {
    const { speaker, synth, states } = setup()
    await speaker.speak('m1', '| a | b |\n|---|---|\n\n---', {})
    expect(synth.queue).toHaveLength(0)
    expect(states.filter((state) => state.status === 'speaking')).toHaveLength(0)
  })
})

describe('Speaker with an OpenAI-compatible endpoint', () => {
  it('synthesizes and plays chunks in order, prefetching the next one', async () => {
    const { speaker, audios, released, synthesized, states } = setup()
    const text = 'First sentence is long enough to stand alone here. '.repeat(8)
    const done = speaker.speak('m1', text, { engine: 'openai' })
    await tick()
    expect(audios).toHaveLength(1)
    expect(synthesized.length).toBe(2) // the playing chunk plus the prefetched next one
    while (speaker.getState().status !== 'idle') {
      audios.at(-1)!.onended?.()
      await tick()
    }
    await done
    expect(released.length).toBe(audios.length)
    expect(synthesized.length).toBe(audios.length)
    expect(states.map((state) => state.status)).toEqual(['loading', 'speaking', 'idle'])
  })

  it('falls back to the system voice when the endpoint fails before anything played', async () => {
    const { speaker, synth, errors } = setup({ synthesize: () => Promise.reject(new Error('connect ECONNREFUSED')) })
    const done = speaker.speak('m1', 'Hello there. How are you?', { engine: 'openai' })
    await tick()
    await tick()
    expect(errors).toEqual(['Voice endpoint failed, using the system voice: connect ECONNREFUSED'])
    expect(synth.queue.map((utterance) => utterance.text)).toEqual(['Hello there. How are you?'])
    synth.finishAll()
    await done
  })

  it('stops mid-clip: pauses, releases, and settles the pending read', async () => {
    const { speaker, audios, released, synthesized } = setup()
    const done = speaker.speak('m1', 'One sentence here. '.repeat(40), { engine: 'openai' })
    await tick()
    speaker.stop()
    await done
    expect(audios[0]!.paused).toBe(true)
    expect(released).toHaveLength(1)
    const before = synthesized.length
    await tick()
    expect(synthesized.length).toBe(before)
    expect(speaker.getState()).toEqual({ id: null, status: 'idle' })
  })

  it('reports a failure after audio started without switching voices', async () => {
    let calls = 0
    const { speaker, audios, errors, synth } = setup({
      synthesize: async (text) => {
        calls += 1
        if (calls > 1) throw new Error('HTTP 500')
        return { mime: 'audio/mpeg', base64: btoa(text) }
      }
    })
    const done = speaker.speak('m1', 'Chunk text that is long enough to split up. '.repeat(10), { engine: 'openai' })
    await tick()
    audios[0]!.onended?.()
    await done
    expect(errors).toEqual(['Voice endpoint failed: HTTP 500'])
    expect(synth.queue).toHaveLength(0)
  })
})
