/**
 * Phone calls: an OpenAI-compatible `/chat/completions` endpoint that voice platforms with a
 * "custom LLM" option (Vapi, Telnyx AI Assistants, Retell's OpenAI mode, a self-hosted Pipecat)
 * call once per caller utterance. The platform owns the phone number, speech-to-text and
 * text-to-speech; this endpoint turns each utterance into a turn on the SAME assistant thread the
 * texts use, and streams the assistant's reply back as SSE chunks while it is written.
 *
 * Calls are short and tools are slow, so a turn gets `maxWaitMs`: past that the line says the
 * answer is coming by text, the stream closes, and normal text delivery sends the result.
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { PushEvent } from '@shared/ipc'
import type { RunEvent } from '@shared/types'
import type { VoiceConfig } from './config'
import { speakable } from './format'
import type { VoiceRunState } from './router'
import type { Logger } from './types'

const MODEL_ID = 'lattice-assistant'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const FILLER_AFTER_MS = 4_000
const BUFFER_LIMIT = 5_000

export interface VoiceRouter {
  readonly connected: boolean
  sendVoiceTurn(utterance: string): Promise<{ threadId: string; runId: string; busy: boolean } | undefined>
  setVoiceRunState(runId: string, state: VoiceRunState): void
}

export interface VoiceServerOptions {
  config: VoiceConfig
  router: VoiceRouter
  subscribe: (listener: (event: PushEvent) => void) => () => void
  log: Logger
  fillerAfterMs?: number
}

interface ChatBody {
  messages?: Array<{ role?: string; content?: unknown }>
  stream?: boolean
  call?: { customer?: { number?: string } }
  customer?: { number?: string }
  metadata?: { caller?: string }
}

function secretMatches(header: string | undefined, secret: string): boolean {
  if (!secret || typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice(7).trim())
  const expected = Buffer.from(secret)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function digits(value: string): string {
  return value.replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '')
}

export function callerAllowed(caller: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true
  if (!caller) return false
  const wanted = digits(caller)
  return allowed.some((number) => digits(number) === wanted)
}

export function lastUtterance(body: ChatBody): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') return message.content.trim()
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text ?? '') : ''))
        .join(' ')
        .trim()
    }
  }
  return ''
}

async function readJson(req: IncomingMessage): Promise<ChatBody> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatBody) : {}
}

/** Writes one assistant reply either as OpenAI SSE chunks or, for `stream: false`, as one JSON body. */
class ReplyWriter {
  private readonly id = `chatcmpl-${Date.now().toString(36)}`
  private readonly created = Math.floor(Date.now() / 1000)
  private text = ''
  private started = false
  private ended = false
  wrote = false

  constructor(private readonly res: ServerResponse, private readonly stream: boolean) {}

  private begin(): void {
    if (this.started || !this.stream) return
    this.started = true
    this.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    this.chunk({ role: 'assistant', content: '' }, null)
  }

  private chunk(delta: Record<string, unknown>, finish: string | null): void {
    this.res.write(`data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  }

  write(text: string): void {
    if (this.ended || !text) return
    this.wrote = true
    if (!this.stream) {
      this.text += text
      return
    }
    this.begin()
    this.chunk({ content: text }, null)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    if (!this.stream) {
      const body = JSON.stringify({
        id: this.id,
        object: 'chat.completion',
        created: this.created,
        model: MODEL_ID,
        choices: [{ index: 0, message: { role: 'assistant', content: this.text }, finish_reason: 'stop' }]
      })
      this.res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      this.res.end(body)
      return
    }
    this.begin()
    this.chunk({}, 'stop')
    this.res.end('data: [DONE]\n\n')
  }

  get closed(): boolean {
    return this.ended
  }

  /** Fires when the platform drops the request before the reply ended (barge-in, hang-up). */
  onAbandoned(callback: () => void): void {
    // `res` 'close', not `req` 'close': a request emits close as soon as its body is read.
    this.res.on('close', () => {
      if (this.ended) return
      this.ended = true // nothing more may be written to a dropped connection
      callback()
    })
  }
}

export class VoiceServer {
  private server: Server | null = null
  private port = 0

  constructor(private readonly options: VoiceServerOptions) {}

  get listeningPort(): number {
    return this.port
  }

  async start(): Promise<number> {
    const { config } = this.options
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.options.log(`voice: ${(error as Error).stack || String(error)}`)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'internal error' } }))
        } else res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.bind, () => resolve())
    })
    this.server = server
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : config.port
    this.options.log(`voice: OpenAI-compatible endpoint on http://${config.bind}:${this.port}/chat/completions`)
    return this.port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url || '/', 'http://localhost').pathname.replace(/\/+$/, '')
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, runtime: this.options.router.connected }))
      return
    }
    if (!secretMatches(req.headers.authorization, this.options.config.secret)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unauthorized' } }))
      return
    }
    if (req.method === 'GET' && (path === '/models' || path === '/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'lattice' }] }))
      return
    }
    if (req.method !== 'POST' || (path !== '/chat/completions' && path !== '/v1/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    let body: ChatBody
    try {
      body = await readJson(req)
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: (error as Error).message } }))
      return
    }
    const writer = new ReplyWriter(res, body.stream !== false)
    const caller = body.call?.customer?.number ?? body.customer?.number ?? body.metadata?.caller
    if (!callerAllowed(caller, this.options.config.allowedCallers)) {
      this.options.log(`voice: refused caller ${caller ?? '(no caller id in request)'}`)
      writer.write('Sorry, this line is private.')
      writer.end()
      return
    }
    const utterance = lastUtterance(body)
    if (!utterance) {
      writer.write("I'm here.")
      writer.end()
      return
    }
    await this.answer(writer, utterance)
  }

  private async answer(writer: ReplyWriter, utterance: string): Promise<void> {
    const { router, subscribe, config } = this.options
    if (!router.connected) {
      writer.write("Lattice isn't reachable right now. Try texting me instead.")
      writer.end()
      return
    }

    // Subscribe before sending: the run's first deltas can arrive before `send` returns its id.
    const buffered: RunEvent[] = []
    let runId: string | undefined
    // Filler ("One sec.") is not an answer: only real reply text decides whether the call heard it.
    let answered = false
    let finish: (() => void) | undefined
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const onRun = (event: RunEvent): void => {
      if (event.agent || event.runId !== runId || writer.closed) return
      if (event.body.type === 'text.delta') {
        const text = speakable(event.body.text)
        if (text.trim()) answered = true
        writer.write(text)
      } else if (event.body.type === 'run.completed') {
        if (event.body.reason === 'error' && !answered) writer.write('Sorry, that hit an error.')
        router.setVoiceRunState(runId, answered && event.body.reason !== 'error' ? 'spoken' : 'overflow')
        writer.end()
        finish?.()
      }
    }
    const unsubscribe = subscribe((event) => {
      if (event.kind !== 'run.event') return
      if (runId === undefined) {
        if (buffered.length < BUFFER_LIMIT) buffered.push(event.event)
        return
      }
      onRun(event.event)
    })

    const timers: Array<ReturnType<typeof setTimeout>> = []
    let abandoned = false
    const handOff = (line: string): void => {
      if (writer.closed) return
      if (runId) router.setVoiceRunState(runId, 'overflow')
      writer.write(line)
      writer.end()
      finish?.()
    }
    writer.onAbandoned(() => {
      // The caller barged in or hung up. A partly spoken answer counts as heard; an unheard one is texted.
      abandoned = true
      if (runId) router.setVoiceRunState(runId, answered ? 'spoken' : 'overflow')
      finish?.()
    })

    try {
      const turn = await router.sendVoiceTurn(utterance)
      if (!turn) {
        writer.write("Lattice isn't reachable right now. Try texting me instead.")
        writer.end()
        return
      }
      if (turn.busy) {
        writer.write("I'm in the middle of something else. I'll text you the answer.")
        writer.end()
        return
      }
      runId = turn.runId
      for (const event of buffered.splice(0)) onRun(event)
      timers.push(setTimeout(() => {
        if (!writer.wrote && !writer.closed) writer.write('One sec. ')
      }, this.options.fillerAfterMs ?? FILLER_AFTER_MS))
      timers.push(setTimeout(() => handOff(" This is taking a bit, so I'll text you when it's done."), config.maxWaitMs))
      await done
    } finally {
      for (const timer of timers) clearTimeout(timer)
      unsubscribe()
      if (!writer.closed && !abandoned) writer.end()
    }
  }
}
