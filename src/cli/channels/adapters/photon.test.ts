import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InboundMessage } from '../types'
import { PhotonAdapter, photonSdkInstalled } from './photon'

/** A push-driven async iterable standing in for `app.messages`. */
class MessageStream<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private waiter: ((result: IteratorResult<T>) => void) | null = null
  push(value: T): void {
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter({ value, done: false })
    } else this.values.push(value)
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => (this.values.length ? Promise.resolve({ value: this.values.shift()!, done: false }) : new Promise((resolve) => (this.waiter = resolve)))
    }
  }
}

interface FakeSpace {
  id: string
  sent: unknown[]
  send(content: unknown): Promise<unknown>
  getMessage(id: string): Promise<undefined>
}

function space(id: string, failWith?: string): FakeSpace {
  return {
    id,
    sent: [],
    async send(content) {
      if (failWith) throw new Error(failWith)
      this.sent.push(content)
      return { id: 'out-1' }
    },
    async getMessage() {
      return undefined
    }
  }
}

function message(id: string, content: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const state = { read: 0, reactions: [] as string[] }
  return {
    state,
    value: {
      id,
      content,
      direction: 'inbound',
      sender: { id: '+16305550100' },
      timestamp: new Date(1_700_000_000_000),
      async read() {
        state.read += 1
      },
      async react(emoji: string) {
        state.reactions.push(emoji)
      },
      ...extra
    }
  }
}

let dir: string
let stream: MessageStream<[FakeSpace, unknown]>
let created: string[]
let received: InboundMessage[]
let adapter: PhotonAdapter

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lattice-photon-'))
  stream = new MessageStream()
  created = []
  received = []
  const module = {
    async Spectrum(options: { projectId: string; projectSecret: string }) {
      expect(options).toMatchObject({ projectId: 'proj', projectSecret: 'secret' })
      return { messages: stream, async stop() {} }
    },
    text: (source: string) => ({ type: 'text', text: source }),
    typing: (state?: string) => ({ type: 'typing', state }),
    imessage: Object.assign(
      () => ({
        space: {
          async get(id: string) {
            return space(id)
          },
          async create(handle: string) {
            created.push(handle)
            return space(`dm-${handle}`)
          }
        }
      }),
      { config: () => ({ provider: 'imessage' }) }
    )
  }
  adapter = new PhotonAdapter({ projectId: 'proj', projectSecret: 'secret', sdkDir: join(dir, 'sdk'), mediaDir: join(dir, 'media'), log: () => undefined, loadModule: async () => module as never })
  await adapter.start((inbound) => received.push(inbound))
})

afterEach(async () => {
  await adapter.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('PhotonAdapter', () => {
  it('normalizes inbound text, marks it read, and skips our own outbound echoes', async () => {
    const dm = space('space-1')
    const inbound = message('m1', { type: 'text', text: 'hey' })
    stream.push([dm, { ...message('m0', { type: 'text', text: 'echo' }).value, direction: 'outbound' }])
    stream.push([dm, inbound.value])
    await waitFor(() => received.length === 1 && inbound.state.read === 1)
    expect(received[0]).toEqual({ channel: 'imessage', conversationId: 'space-1', senderId: '+16305550100', messageId: 'm1', text: 'hey', attachments: [], receivedAt: 1_700_000_000_000 })
  })

  it('flattens grouped bubbles and saves attachment bytes', async () => {
    const photo = { type: 'attachment', name: 'IMG_1.heic', mimeType: 'image/heic', size: 4, read: async () => Buffer.from('heic') }
    const grouped = message('m2', { type: 'group', items: [{ content: { type: 'text', text: 'look' } }, { content: photo }] })
    stream.push([space('space-1'), grouped.value])
    await waitFor(() => received.length === 1)
    const [attachment] = received[0]!.attachments
    expect(received[0]!.text).toBe('look')
    expect(attachment).toMatchObject({ name: 'IMG_1.heic', mime: 'image/heic', kind: 'image' })
    expect(existsSync(attachment!.path) && readFileSync(attachment!.path, 'utf8')).toBe('heic')
  })

  it('does not fetch attachments from senders who are not paired', async () => {
    await adapter.stop()
    let reads = 0
    const module = (adapter as unknown as { sdk: unknown }).sdk
    adapter = new PhotonAdapter({ projectId: 'proj', projectSecret: 'secret', sdkDir: join(dir, 'sdk'), mediaDir: join(dir, 'media'), log: () => undefined, loadModule: async () => module as never, mayDownload: () => false })
    await adapter.start((inbound) => received.push(inbound))
    const file = { type: 'attachment', name: 'big.mov', mimeType: 'video/quicktime', read: async () => { reads += 1; return Buffer.from('x') } }
    stream.push([space('space-1'), message('m9', { type: 'group', items: [{ content: { type: 'text', text: 'hi' } }, { content: file }] }).value])
    await waitFor(() => received.length === 1)
    expect(received[0]).toMatchObject({ text: 'hi', attachments: [] })
    expect(reads).toBe(0)
  })

  it('ignores reactions and read receipts', async () => {
    stream.push([space('space-1'), message('m3', { type: 'reaction', emoji: '👍' }).value])
    stream.push([space('space-1'), message('m4', { type: 'text', text: 'after' }).value])
    await waitFor(() => received.length === 1)
    expect(received[0]!.text).toBe('after')
  })

  it('replies into the known space and addresses a bare number as a new DM', async () => {
    const dm = space('space-9')
    stream.push([dm, message('m5', { type: 'text', text: 'hi' }).value])
    await waitFor(() => received.length === 1)
    await adapter.send('space-9', 'hello back')
    await adapter.typing('space-9', true)
    expect(dm.sent).toEqual([{ type: 'text', text: 'hello back' }, { type: 'typing', state: 'start' }])
    await adapter.send('+16305550100', 'proactive')
    expect(created).toEqual(['+16305550100'])
  })

  it('reacts to a recent inbound message', async () => {
    const inbound = message('m6', { type: 'text', text: 'react to me' })
    stream.push([space('space-1'), inbound.value])
    await waitFor(() => received.length === 1)
    await adapter.react('space-1', 'm6', '👀')
    expect(inbound.state.reactions).toEqual(['👀'])
  })

  it('reports an uninstalled SDK', () => {
    expect(photonSdkInstalled(join(dir, 'nope'))).toBe(false)
  })
})
