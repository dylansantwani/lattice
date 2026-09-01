import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushEvent } from '@shared/ipc'
import type { ChatMessage, ThreadMeta } from '@shared/types'

// The store subscribes to window.lattice.onPush at import time and drives every action through
// window.lattice.*. Stub that bridge BEFORE importing the store so we capture the push handler
// and can assert how /btw aside events are routed. Node env, no DOM needed — the store is plain
// zustand.
let pushHandler: ((event: PushEvent) => void) | undefined
const lattice = {
  onPush: vi.fn((fn: (event: PushEvent) => void) => {
    pushHandler = fn
  }),
  forkThread: vi.fn(async (_id: string, opts?: { titlePrefix?: string }) => meta('child', `${opts?.titlePrefix}: Parent`)),
  send: vi.fn(async () => ({ runId: 'r1', messageId: 'sent' })),
  deleteThread: vi.fn(async () => {}),
  cancelRun: vi.fn(async () => {})
}
;(globalThis as unknown as { window: unknown }).window = { lattice }

const { useStore } = await import('./store')

function meta(id: string, title: string, patch: Partial<ThreadMeta> = {}): ThreadMeta {
  return {
    id,
    workspaceId: 'ws',
    title,
    model: 'test/model',
    effort: 'high',
    mode: 'act',
    permissionPreset: 'workspace',
    ...patch
  } as ThreadMeta
}

function msg(id: string, threadId: string, role: ChatMessage['role'], text: string): ChatMessage {
  return { id, threadId, role, text, createdAt: Date.now() }
}

const emit = (event: PushEvent): void => pushHandler!(event)

beforeEach(() => {
  useStore.setState({
    activeThreadId: 'parent',
    threads: [meta('parent', 'Parent')],
    messages: [],
    aside: null
  })
  lattice.forkThread.mockClear()
  lattice.send.mockClear()
  lattice.deleteThread.mockClear()
  lattice.cancelRun.mockClear()
})

afterEach(() => {
  useStore.setState({ aside: null })
})

describe('/btw quick aside', () => {
  it('opens an aside without adding the fork thread to the sidebar', async () => {
    await useStore.getState().openAside()
    const s = useStore.getState()
    expect(lattice.forkThread).toHaveBeenCalledWith('parent', { titlePrefix: 'BTW' })
    expect(s.aside).toMatchObject({ threadId: 'child', parentThreadId: 'parent', parentTitle: 'Parent' })
    // The fork is ephemeral: it must NOT appear in the thread list.
    expect(s.threads.map((t) => t.id)).toEqual(['parent'])
  })

  it('routes the aside thread’s messages into the aside slice, not the main transcript', async () => {
    await useStore.getState().openAside()
    emit({ kind: 'message.updated', message: msg('u1', 'child', 'user', 'by the way?') })
    emit({ kind: 'message.updated', message: msg('a1', 'child', 'assistant', 'here you go') })
    const s = useStore.getState()
    expect(s.aside?.messages.map((m) => m.text)).toEqual(['by the way?', 'here you go'])
    // The main transcript for the parent thread is untouched.
    expect(s.messages).toEqual([])
  })

  it('keeps the aside out of the sidebar even when its run starts (thread.updated running)', async () => {
    await useStore.getState().openAside()
    emit({ kind: 'thread.updated', meta: meta('child', 'BTW: Parent', { running: true }) })
    const s = useStore.getState()
    expect(s.aside?.running).toBe(true)
    // The critical guarantee: a running aside must not leak into the thread list.
    expect(s.threads.map((t) => t.id)).toEqual(['parent'])
  })

  it('tracks the run id for cancel-on-close and clears running on completion', async () => {
    await useStore.getState().openAside()
    const runEvent = (body: unknown, id: string): PushEvent =>
      ({ kind: 'run.event', event: { id, runId: 'run-9', threadId: 'child', seq: 1, ts: 0, body } } as unknown as PushEvent)
    emit(runEvent({ type: 'run.started', model: 'test/model', mode: 'act' }, 'e1'))
    expect(useStore.getState().aside?.runId).toBe('run-9')
    emit(runEvent({ type: 'run.completed', reason: 'done' }, 'e2'))
    expect(useStore.getState().aside?.running).toBe(false)
  })

  it('discards the ephemeral thread on close', async () => {
    await useStore.getState().openAside()
    await useStore.getState().closeAside()
    expect(useStore.getState().aside).toBeNull()
    expect(lattice.deleteThread).toHaveBeenCalledWith('child')
  })

  it('seeds the aside with a first question when opened with an arg', async () => {
    await useStore.getState().openAside('what about X?')
    expect(lattice.send).toHaveBeenCalledWith({ threadId: 'child', text: 'what about X?', disposition: 'send' })
  })
})
