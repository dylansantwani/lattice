import { afterEach, describe, expect, it } from 'vitest'
import type { PushEvent } from '@shared/ipc'
import type { RunEvent } from '@shared/types'
import type { VoiceConfig } from './config'
import type { VoiceRunState } from './router'
import { callerAllowed, lastUtterance, VoiceServer, type VoiceRouter } from './voice'
import { EventHub } from './gateway'

const SECRET = 'voice-secret-123'

function config(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return { enabled: true, port: 0, bind: '127.0.0.1', secret: SECRET, allowedCallers: ['+1 (630) 555-0100'], maxWaitMs: 2_000, quickTunnel: false, ...overrides }
}

class ScriptedRouter implements VoiceRouter {
  connected = true
  busy = false
  turns: string[] = []
  states: Array<[string, VoiceRunState]> = []
  constructor(private readonly onTurn: (runId: string) => void) {}
  async sendVoiceTurn(utterance: string): Promise<{ threadId: string; runId: string; busy: boolean }> {
    this.turns.push(utterance)
    const runId = `run${this.turns.length}`
    this.onTurn(runId)
    return { threadId: 't1', runId, busy: this.busy }
  }
  setVoiceRunState(runId: string, state: VoiceRunState): void {
    this.states.push([runId, state])
  }
}

function event(runId: string, body: RunEvent['body']): PushEvent {
  return { kind: 'run.event', event: { id: 'e', runId, threadId: 't1', seq: 1, ts: 0, body } as RunEvent }
}

let server: VoiceServer | null = null

afterEach(async () => {
  await server?.stop()
  server = null
})

async function startServer(router: VoiceRouter, hub: EventHub, overrides: Partial<VoiceConfig> = {}, fillerAfterMs = 60_000): Promise<string> {
  server = new VoiceServer({ config: config(overrides), router, subscribe: (listener) => hub.subscribe(listener), log: () => undefined, fillerAfterMs })
  const port = await server.start()
  return `http://127.0.0.1:${port}`
}

function chat(base: string, body: Record<string, unknown>, secret = SECRET): Promise<Response> {
  return fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function sseText(raw: string): string {
  return raw
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: ') && !frame.includes('[DONE]'))
    .map((frame) => (JSON.parse(frame.slice(6)) as { choices: Array<{ delta: { content?: string } }> }).choices[0]!.delta.content ?? '')
    .join('')
}

const caller = { call: { customer: { number: '+16305550100' } } }

describe('voice helpers', () => {
  it('matches callers by digits, tolerating formatting and the US country code', () => {
    expect(callerAllowed('+16305550100', ['(630) 555-0100'])).toBe(true)
    expect(callerAllowed('6305550100', ['+1 630 555 0100'])).toBe(true)
    expect(callerAllowed('+16305550199', ['+16305550100'])).toBe(false)
    expect(callerAllowed(undefined, ['+16305550100'])).toBe(false)
    expect(callerAllowed(undefined, [])).toBe(true)
  })

  it('takes the latest user utterance from string or part content', () => {
    expect(lastUtterance({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: [{ type: 'text', text: 'second' }] }] })).toBe('second')
    expect(lastUtterance({})).toBe('')
  })
})

describe('VoiceServer', () => {
  it('rejects requests without the bearer secret', async () => {
    const hub = new EventHub(() => undefined)
    const base = await startServer(new ScriptedRouter(() => undefined), hub)
    expect((await chat(base, { messages: [] }, 'wrong')).status).toBe(401)
    expect((await fetch(`${base}/health`)).status).toBe(200)
  })

  it('refuses callers outside the allowlist without touching the assistant', async () => {
    const hub = new EventHub(() => undefined)
    const router = new ScriptedRouter(() => undefined)
    const base = await startServer(router, hub)
    const response = await chat(base, { stream: true, call: { customer: { number: '+12125550000' } }, messages: [{ role: 'user', content: 'hi' }] })
    expect(sseText(await response.text())).toBe('Sorry, this line is private.')
    expect(router.turns).toHaveLength(0)
  })

  it('streams the run text as OpenAI SSE chunks, including deltas that raced ahead of send()', async () => {
    const hub = new EventHub(() => undefined)
    const router = new ScriptedRouter((runId) => {
      // Emitted before sendVoiceTurn resolves: must be buffered, not lost.
      hub.emit(event(runId, { type: 'text.delta', text: '**You** have ' } as RunEvent['body']))
      setTimeout(() => {
        hub.emit(event(runId, { type: 'text.delta', text: 'two meetings.' } as RunEvent['body']))
        hub.emit(event('someone-else', { type: 'text.delta', text: 'NOPE' } as RunEvent['body']))
        hub.emit(event(runId, { type: 'run.completed', reason: 'done' }))
      }, 20)
    })
    const base = await startServer(router, hub)
    const response = await chat(base, { stream: true, ...caller, messages: [{ role: 'user', content: "what's today" }] })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const raw = await response.text()
    expect(sseText(raw)).toBe('You have two meetings.')
    expect(raw.trim().endsWith('data: [DONE]')).toBe(true)
    expect(router.turns).toEqual(["what's today"])
    expect(router.states).toEqual([['run1', 'spoken']])
  })

  it('answers non-streaming requests with one completion body', async () => {
    const hub = new EventHub(() => undefined)
    const router = new ScriptedRouter((runId) => {
      setTimeout(() => {
        hub.emit(event(runId, { type: 'text.delta', text: 'Sure.' } as RunEvent['body']))
        hub.emit(event(runId, { type: 'run.completed', reason: 'done' }))
      }, 10)
    })
    const base = await startServer(router, hub)
    const response = await chat(base, { stream: false, ...caller, messages: [{ role: 'user', content: 'ok?' }] })
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]!.message.content).toBe('Sure.')
  })

  it('hands a slow answer off to text and marks the run for text delivery', async () => {
    const hub = new EventHub(() => undefined)
    const router = new ScriptedRouter(() => undefined)
    const base = await startServer(router, hub, { maxWaitMs: 150 }, 50)
    const raw = await (await chat(base, { stream: true, ...caller, messages: [{ role: 'user', content: 'research flights' }] })).text()
    expect(sseText(raw)).toBe("One sec.  This is taking a bit, so I'll text you when it's done.")
    expect(router.states).toEqual([['run1', 'overflow']])
  })

  it('tells the caller when the assistant is busy', async () => {
    const hub = new EventHub(() => undefined)
    const router = new ScriptedRouter(() => undefined)
    router.busy = true
    const base = await startServer(router, hub)
    const raw = await (await chat(base, { stream: true, ...caller, messages: [{ role: 'user', content: 'also this' }] })).text()
    expect(sseText(raw)).toContain("I'll text you the answer")
  })

  it('says Lattice is unreachable when the runtime is down', async () => {
    const hub = new EventHub(() => undefined)
    const router = new ScriptedRouter(() => undefined)
    router.connected = false
    const base = await startServer(router, hub)
    const raw = await (await chat(base, { stream: true, ...caller, messages: [{ role: 'user', content: 'hello' }] })).text()
    expect(sseText(raw)).toContain("isn't reachable")
    expect(router.turns).toHaveLength(0)
  })
})
