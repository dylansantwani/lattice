import type { LatticeApi, PushEvent } from '@shared/ipc'

export type TransportMode = 'attached' | 'embedded' | 'remote'

export interface LatticeTransport {
  readonly api: LatticeApi
  readonly events: AsyncIterable<PushEvent>
  readonly mode: TransportMode
  close(): Promise<void>
}

/** Small bounded async queue used by socket, remote, and embedded event subscriptions. */
export class PushEventQueue implements AsyncIterable<PushEvent> {
  private readonly values: PushEvent[] = []
  private readonly waiters: Array<(result: IteratorResult<PushEvent>) => void> = []
  private closed = false
  private overflowed = false

  constructor(private readonly limit = 10_000) {}

  push(value: PushEvent): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
      return
    }
    if (this.values.length >= this.limit) {
      this.values.length = 0
      if (!this.overflowed) {
        this.overflowed = true
        this.values.push({ kind: 'notice', tone: 'warn', text: 'event stream overflowed; refetching thread state' })
      }
      return
    }
    this.values.push(value)
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true })
  }

  async next(): Promise<IteratorResult<PushEvent>> {
    if (this.values.length) return { value: this.values.shift()!, done: false }
    if (this.closed) return { value: undefined, done: true }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  [Symbol.asyncIterator](): AsyncIterator<PushEvent> {
    return this
  }
}

export function createApiProxy(request: (method: string, args: unknown[]) => Promise<unknown>): LatticeApi {
  return new Proxy({} as LatticeApi, {
    get(_target, property: string | symbol) {
      if (typeof property !== 'string') return undefined
      return (...args: unknown[]) => request(property, args)
    }
  })
}

export class TransportError extends Error {
  readonly exitCode = 3

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TransportError'
  }
}
