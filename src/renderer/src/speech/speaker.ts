/**
 * Plays replies aloud. One speaker for the whole window: starting a message stops whatever was
 * playing, and every surface (the transcript's speaker button, auto-read, /read) observes the same
 * state through `subscribe`.
 *
 * Two engines:
 *  - `system` queues one Web Speech utterance per sentence-sized chunk (a single long utterance is
 *    silently cut off by Chromium after ~15s).
 *  - `openai` synthesizes chunk by chunk in the main process and plays each as it arrives, fetching
 *    the next chunk while the current one plays. If the endpoint fails before anything is heard, the
 *    rest is read with the system voice instead and the error is reported once.
 */
import type { SpeechAudio } from '@shared/ipc'
import { resolveSpeechSettings, speechTextFromMarkdown, splitForSpeech, type SpeechSettings } from '@shared/speech'

export type SpeakerStatus = 'idle' | 'loading' | 'speaking'

export interface SpeakerState {
  /** The message being read, or null. */
  id: string | null
  status: SpeakerStatus
}

/** The slice of HTMLAudioElement the speaker drives. */
export interface AudioLike {
  play(): Promise<void>
  pause(): void
  onended: (() => void) | null
  onerror: (() => void) | null
}

export interface SpeakerDeps {
  synth: Pick<SpeechSynthesis, 'speak' | 'cancel' | 'getVoices'> | null
  makeUtterance: (text: string) => SpeechSynthesisUtterance
  synthesize: (text: string, overrides?: Partial<SpeechSettings>) => Promise<SpeechAudio>
  makeAudio: (audio: SpeechAudio) => { element: AudioLike; release: () => void }
  onError: (message: string) => void
}

export class Speaker {
  private state: SpeakerState = { id: null, status: 'idle' }
  private readonly listeners = new Set<(state: SpeakerState) => void>()
  /** Bumped on every start/stop; async work from an older session sees the change and bails. */
  private session = 0
  /** The clip playing now; `finish` settles the loop awaiting it, so stop() never strands a promise. */
  private current: { element: AudioLike; finish: () => void } | null = null

  constructor(private readonly deps: SpeakerDeps) {}

  getState(): SpeakerState {
    return this.state
  }

  subscribe(listener: (state: SpeakerState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(next: SpeakerState): void {
    if (next.id === this.state.id && next.status === this.state.status) return
    this.state = next
    for (const listener of this.listeners) listener(next)
  }

  isSpeaking(id: string): boolean {
    return this.state.id === id && this.state.status !== 'idle'
  }

  stop(): void {
    this.session += 1
    this.deps.synth?.cancel()
    const playing = this.current
    if (playing) {
      playing.element.pause()
      playing.finish()
    }
    this.set({ id: null, status: 'idle' })
  }

  /** Start reading `markdown` as message `id`, or stop if that message is already being read. */
  toggle(id: string, markdown: string, stored: Partial<SpeechSettings> | undefined): Promise<void> {
    if (this.isSpeaking(id)) {
      this.stop()
      return Promise.resolve()
    }
    return this.speak(id, markdown, stored)
  }

  async speak(id: string, markdown: string, stored: Partial<SpeechSettings> | undefined): Promise<void> {
    this.stop()
    const session = this.session
    const settings = resolveSpeechSettings(stored)
    const chunks = splitForSpeech(speechTextFromMarkdown(markdown, { skipCode: settings.skipCode }))
    if (chunks.length === 0) return
    this.set({ id, status: 'loading' })
    try {
      if (settings.engine === 'openai') await this.speakEndpoint(session, id, chunks, settings)
      else await this.speakSystem(session, id, chunks, settings)
    } finally {
      if (this.session === session) this.set({ id: null, status: 'idle' })
    }
  }

  private speakSystem(session: number, id: string, chunks: string[], settings: SpeechSettings): Promise<void> {
    const synth = this.deps.synth
    if (!synth) {
      this.deps.onError('This window has no system speech voices.')
      return Promise.resolve()
    }
    const voice = settings.systemVoice ? synth.getVoices().find((candidate) => candidate.voiceURI === settings.systemVoice) : undefined
    return new Promise<void>((resolve) => {
      chunks.forEach((chunk, index) => {
        const utterance = this.deps.makeUtterance(chunk)
        if (voice) utterance.voice = voice
        utterance.rate = settings.rate
        if (index === 0) utterance.onstart = () => this.session === session && this.set({ id, status: 'speaking' })
        const last = index === chunks.length - 1
        utterance.onend = () => {
          if (last) resolve()
        }
        utterance.onerror = (event) => {
          // `interrupted`/`canceled` is our own stop(); anything else is worth saying — and the rest
          // of the queue must go too, or it keeps talking after the UI has gone idle.
          const reason = (event as SpeechSynthesisErrorEvent).error
          if (this.session === session && reason !== 'interrupted' && reason !== 'canceled') {
            this.deps.onError(`System voice failed: ${reason}`)
            synth.cancel()
          }
          resolve()
        }
        synth.speak(utterance)
      })
    })
  }

  private async speakEndpoint(session: number, id: string, chunks: string[], settings: SpeechSettings): Promise<void> {
    const pending = new Map<number, Promise<SpeechAudio>>()
    const fetchChunk = (index: number): Promise<SpeechAudio> => {
      let promise = pending.get(index)
      if (!promise) {
        promise = this.deps.synthesize(chunks[index]!)
        // Prefetched chunks that end up unused must not surface as unhandled rejections.
        promise.catch(() => undefined)
        pending.set(index, promise)
      }
      return promise
    }
    for (let index = 0; index < chunks.length; index += 1) {
      let audio: SpeechAudio
      try {
        audio = await fetchChunk(index)
      } catch (error) {
        if (this.session !== session) return
        const heardSomething = index > 0
        this.deps.onError(`Voice endpoint failed${heardSomething ? '' : ', using the system voice'}: ${(error as Error).message}`)
        if (!heardSomething) await this.speakSystem(session, id, chunks, { ...settings, engine: 'system' })
        return
      }
      if (this.session !== session) return
      if (index + 1 < chunks.length) void fetchChunk(index + 1)
      await this.play(session, id, audio)
      if (this.session !== session) return
    }
  }

  private play(session: number, id: string, audio: SpeechAudio): Promise<void> {
    const handle = this.deps.makeAudio(audio)
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        handle.element.onended = null
        handle.element.onerror = null
        handle.release()
        if (this.current?.element === handle.element) this.current = null
        resolve()
      }
      this.current = { element: handle.element, finish }
      handle.element.onended = finish
      handle.element.onerror = () => {
        if (this.session === session) this.deps.onError('Could not play the synthesized audio.')
        finish()
      }
      handle.element
        .play()
        .then(() => this.session === session && this.set({ id, status: 'speaking' }))
        .catch((error: Error) => {
          if (this.session === session) this.deps.onError(`Could not play audio: ${error.message}`)
          finish()
        })
    })
  }
}

function base64ToBlob(audio: SpeechAudio): Blob {
  const binary = atob(audio.base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: audio.mime })
}

let shared: Speaker | null = null

let errorSink: (message: string) => void = () => undefined

/** Route speaker errors somewhere visible (the app's toast). */
export function setSpeakerErrorSink(sink: (message: string) => void): void {
  errorSink = sink
}

/** The window's speaker, wired to the real Web Speech API, the main-process synthesizer and <audio>. */
export function getSpeaker(): Speaker {
  if (shared) return shared
  const hasWindow = typeof window !== 'undefined'
  shared = new Speaker({
    synth: hasWindow && 'speechSynthesis' in window ? window.speechSynthesis : null,
    makeUtterance: (text) => new SpeechSynthesisUtterance(text),
    synthesize: (text, overrides) => {
      if (!hasWindow || !window.lattice?.synthesizeSpeech) return Promise.reject(new Error('speech synthesis is not available in this window'))
      return window.lattice.synthesizeSpeech(text, overrides)
    },
    makeAudio: (audio) => {
      const url = URL.createObjectURL(base64ToBlob(audio))
      // HTMLAudioElement's handler properties carry a `this` type AudioLike leaves out.
      const element = new Audio(url) as unknown as AudioLike
      return { element, release: () => URL.revokeObjectURL(url) }
    },
    onError: (message) => errorSink(message)
  })
  return shared
}
