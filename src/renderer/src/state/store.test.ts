import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushEvent } from '@shared/ipc'
import type { ChatMessage, RunEvent, ThreadMeta } from '@shared/types'

// The store subscribes to window.lattice.onPush at import time and drives every action through
// window.lattice.*. Stub that bridge BEFORE importing the store so we capture the push handler
// and can assert how /btw aside events are routed. Node env, no DOM needed — the store is plain
// zustand.
let pushHandler: ((event: PushEvent) => void) | undefined
const lattice = {
  onPush: vi.fn((fn: (event: PushEvent) => void) => {
    pushHandler = fn
  }),
  createThread: vi.fn(async () => meta('new', 'New thread')),
  getThread: vi.fn(async (id: string) => ({
    meta: meta(id, id === 'new' ? 'New thread' : id === 'parent' ? 'Parent' : id),
    messages: [] as ChatMessage[],
    events: [] as RunEvent[]
  })),
  forkThread: vi.fn(async (_id: string, opts?: { titlePrefix?: string }) => meta('child', `${opts?.titlePrefix}: Parent`)),
  send: vi.fn(async () => ({ runId: 'r1', messageId: 'sent' })),
  getContextBudget: vi.fn(async () => null),
  deleteThread: vi.fn(async () => {}),
  cancelRun: vi.fn(async () => {}),
  // Mirror the main process: merge the patch into the persisted settings and echo the result back,
  // so saveSettings-backed actions (e.g. toggleSubagentModel) can be exercised end to end.
  setSettings: vi.fn(async (patch: Record<string, unknown>) => {
    storedSettings = { ...storedSettings, ...patch }
    return storedSettings
  })
}
let storedSettings: Record<string, unknown> = {}
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
  lattice.createThread.mockClear()
  lattice.getThread.mockClear()
  lattice.send.mockClear()
  lattice.deleteThread.mockClear()
  lattice.cancelRun.mockClear()
  lattice.setSettings.mockClear()
  storedSettings = {}
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

describe('new thread cleanup on navigation', () => {
  const userMessage = (threadId = 'new'): ChatMessage => ({
    id: 'first-user',
    threadId,
    role: 'user',
    createdAt: 1,
    text: 'first prompt'
  })

  const assistantMessage = (status: ChatMessage['status'] = 'complete', threadId = 'new'): ChatMessage => ({
    id: 'first-assistant',
    threadId,
    role: 'assistant',
    runId: 'run-1',
    createdAt: 2,
    text: status === 'error' ? '' : 'first reply',
    status
  })

  beforeEach(() => {
    useStore.setState({
      activeThreadId: 'parent',
      threads: [meta('parent', 'Parent')],
      messages: [],
      events: []
    })
  })

  it('deletes an untouched new thread when selecting another thread', async () => {
    await useStore.getState().newThread()
    await useStore.getState().selectThread('parent')

    expect(lattice.deleteThread).toHaveBeenCalledWith('new')
    expect(useStore.getState().threads.map((thread) => thread.id)).toEqual(['parent'])
  })

  it('still recognizes a new thread after it is renamed before the first message', async () => {
    await useStore.getState().newThread()
    useStore.setState({
      threads: [meta('new', 'My draft chat'), meta('parent', 'Parent')]
    })

    await useStore.getState().selectThread('parent')

    expect(lattice.deleteThread).toHaveBeenCalledWith('new')
  })

  it('deletes a new thread whose first turn errored', async () => {
    await useStore.getState().newThread()
    emit({ kind: 'message.updated', message: userMessage() })
    emit({ kind: 'message.updated', message: assistantMessage('error') })

    await useStore.getState().selectThread('parent')

    expect(lattice.deleteThread).toHaveBeenCalledWith('new')
  })

  it('deletes a new thread when the first run emits an error event', async () => {
    await useStore.getState().newThread()
    emit({ kind: 'message.updated', message: userMessage() })
    emit({ kind: 'message.updated', message: assistantMessage() })
    emit({
      kind: 'run.event',
      event: {
        id: 'first-error',
        runId: 'run-1',
        threadId: 'new',
        seq: 1,
        ts: 3,
        body: { type: 'error', category: 'unknown', message: 'provider failed', retryable: true }
      }
    })

    await useStore.getState().selectThread('parent')

    expect(lattice.deleteThread).toHaveBeenCalledWith('new')
  })

  it('keeps a new thread after a successful first turn', async () => {
    await useStore.getState().newThread()
    emit({ kind: 'message.updated', message: userMessage() })
    emit({ kind: 'message.updated', message: assistantMessage() })

    await useStore.getState().selectThread('parent')

    expect(lattice.deleteThread).not.toHaveBeenCalledWith('new')
    expect(useStore.getState().threads.map((thread) => thread.id)).toContain('new')
  })

  it('keeps a new thread while its first turn is still running', async () => {
    await useStore.getState().newThread()
    useStore.setState({
      threads: [meta('new', 'New thread', { running: true }), meta('parent', 'Parent')]
    })

    await useStore.getState().selectThread('parent')

    expect(lattice.deleteThread).not.toHaveBeenCalledWith('new')
  })

  it('cleans up when the first-run error arrives after the user leaves', async () => {
    await useStore.getState().newThread()
    useStore.setState({
      threads: [meta('new', 'New thread', { running: true }), meta('parent', 'Parent')]
    })
    await useStore.getState().selectThread('parent')

    emit({
      kind: 'run.event',
      event: {
        id: 'late-error',
        runId: 'run-1',
        threadId: 'new',
        seq: 1,
        ts: 3,
        body: { type: 'error', category: 'unknown', message: 'provider failed', retryable: true }
      }
    })
    await vi.waitFor(() => expect(lattice.deleteThread).toHaveBeenCalledWith('new'))
  })

  it('does not reap another client\'s "New thread" when its first turn errors', async () => {
    // A phone (remote bridge client) creates a thread and sends; the bridge pushes it to this
    // window as a plain thread.updated. Its first turn then fails. This window never created it,
    // so it must NOT be deleted — the remote user needs to see the error and retry.
    emit({ kind: 'thread.updated', meta: meta('remote', 'New thread', { running: true }) })
    // The bridge's persisted snapshot: still untitled, one user message, no reply.
    lattice.getThread.mockImplementation(async (id: string) => ({
      meta: meta(id, 'New thread'),
      messages: [msg('u1', id, 'user', 'hello')],
      events: [] as RunEvent[]
    }))
    emit({
      kind: 'run.event',
      event: {
        id: 'remote-error',
        runId: 'run-r',
        threadId: 'remote',
        seq: 1,
        ts: 3,
        body: { type: 'error', category: 'unknown', message: 'HTTP 502', retryable: true }
      }
    })
    emit({ kind: 'thread.updated', meta: meta('remote', 'New thread', { running: false }) })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(lattice.deleteThread).not.toHaveBeenCalledWith('remote')
    expect(useStore.getState().threads.map((thread) => thread.id)).toContain('remote')
    lattice.getThread.mockImplementation(async (id: string) => ({
      meta: meta(id, id === 'new' ? 'New thread' : id === 'parent' ? 'Parent' : id),
      messages: [] as ChatMessage[],
      events: [] as RunEvent[]
    }))
  })

  it('rechecks persisted content before deleting a locally empty thread', async () => {
    await useStore.getState().newThread()
    lattice.getThread.mockImplementationOnce(async (id: string) => ({
      meta: meta(id, 'New thread'),
      messages: [userMessage(), assistantMessage()],
      events: []
    }))

    await useStore.getState().selectThread('parent')

    expect(lattice.deleteThread).not.toHaveBeenCalledWith('new')
  })

  it('does not delete the thread if the user returns before cleanup finishes', async () => {
    await useStore.getState().newThread()
    let releaseSnapshot!: () => void
    const snapshotReady = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    let holdNextNewRead = true
    lattice.getThread.mockImplementation(async (id: string) => {
      if (id === 'new' && holdNextNewRead) {
        holdNextNewRead = false
        await snapshotReady
      }
      return {
        meta: meta(id, id === 'new' ? 'New thread' : 'Parent'),
        messages: [] as ChatMessage[],
        events: [] as RunEvent[]
      }
    })

    const leave = useStore.getState().selectThread('parent')
    await Promise.resolve()
    const back = useStore.getState().selectThread('new')
    releaseSnapshot()
    await Promise.all([leave, back])

    expect(lattice.deleteThread).not.toHaveBeenCalledWith('new')
    expect(useStore.getState().activeThreadId).toBe('new')
  })
})

describe('background runs do not reorder the sidebar', () => {
  it('keeps a background chat in place when its run finishes, so it cannot bury a newer chat', () => {
    // You made a fresh chat ('mine', most recent) while an older chat ('bg') was still running.
    useStore.setState({
      activeThreadId: 'mine',
      threads: [meta('mine', 'My new chat', { updatedAt: 200 }), meta('bg', 'Background chat', { updatedAt: 100, running: true })],
      messages: [],
      events: []
    })

    // The background run finishes — the DB bumps its updatedAt to "now" (300), newer than 'mine'.
    emit({ kind: 'thread.updated', meta: meta('bg', 'Background chat', { updatedAt: 300, running: false }) })

    const s = useStore.getState()
    // 'mine' stays on top; the finished background chat holds its position instead of leaping up…
    expect(s.threads.map((t) => t.id)).toEqual(['mine', 'bg'])
    // …and it is flagged completed so the sidebar can show its done marker.
    expect(s.completedThreads.has('bg')).toBe(true)
  })

  it('lets the active thread adopt its own bumped timestamp', () => {
    useStore.setState({
      activeThreadId: 'mine',
      threads: [meta('other', 'Other', { updatedAt: 500 }), meta('mine', 'My chat', { updatedAt: 100 })],
      messages: [],
      events: []
    })

    // Acting in the thread you're viewing (e.g. its run starts) should surface it by recency.
    emit({ kind: 'thread.updated', meta: meta('mine', 'My chat', { updatedAt: 600, running: true }) })

    expect(useStore.getState().threads.map((t) => t.id)).toEqual(['mine', 'other'])
  })
})

// The models menu's robot toggle (and the Settings field) both drive toggleSubagentModel, which
// flips a model's membership in settings.subagentModels and persists via setSettings. The
// orchestrator reads that same list to know which models a subagent may run on.
describe('toggleSubagentModel', () => {
  it('adds a model to an empty subagent list', async () => {
    useStore.setState({ settings: { subagentModels: [] } as never })
    await useStore.getState().toggleSubagentModel('mac/qwen3')
    expect(lattice.setSettings).toHaveBeenCalledWith({ subagentModels: ['mac/qwen3'] })
    expect((useStore.getState().settings as { subagentModels: string[] }).subagentModels).toEqual(['mac/qwen3'])
  })

  it('removes a model that is already designated, leaving the rest in order', async () => {
    useStore.setState({ settings: { subagentModels: ['a', 'b', 'c'] } as never })
    await useStore.getState().toggleSubagentModel('b')
    expect(lattice.setSettings).toHaveBeenCalledWith({ subagentModels: ['a', 'c'] })
  })

  it('appends a second model without dropping the first', async () => {
    useStore.setState({ settings: { subagentModels: ['a'] } as never })
    await useStore.getState().toggleSubagentModel('b')
    expect((useStore.getState().settings as { subagentModels: string[] }).subagentModels).toEqual(['a', 'b'])
  })

  it('treats missing settings as an empty list', async () => {
    useStore.setState({ settings: undefined as never })
    await useStore.getState().toggleSubagentModel('only')
    expect(lattice.setSettings).toHaveBeenCalledWith({ subagentModels: ['only'] })
  })
})

// The picker's star button drives toggleFavoriteModel, which flips a model's membership in
// settings.favoriteModels (order = star order) and persists via setSettings. The picker reads that
// same list to lead with a Favorites section.
describe('toggleFavoriteModel', () => {
  it('stars a model into an empty favorites list', async () => {
    useStore.setState({ settings: { favoriteModels: [] } as never })
    await useStore.getState().toggleFavoriteModel('claude-opus-5')
    expect(lattice.setSettings).toHaveBeenCalledWith({ favoriteModels: ['claude-opus-5'] })
    expect((useStore.getState().settings as { favoriteModels: string[] }).favoriteModels).toEqual(['claude-opus-5'])
  })

  it('unstars a model that is already a favorite, keeping the rest in order', async () => {
    useStore.setState({ settings: { favoriteModels: ['a', 'b', 'c'] } as never })
    await useStore.getState().toggleFavoriteModel('b')
    expect(lattice.setSettings).toHaveBeenCalledWith({ favoriteModels: ['a', 'c'] })
  })

  it('appends new stars in the order they are added', async () => {
    useStore.setState({ settings: { favoriteModels: ['a'] } as never })
    await useStore.getState().toggleFavoriteModel('b')
    expect((useStore.getState().settings as { favoriteModels: string[] }).favoriteModels).toEqual(['a', 'b'])
  })

  it('treats missing settings as an empty list', async () => {
    useStore.setState({ settings: undefined as never })
    await useStore.getState().toggleFavoriteModel('only')
    expect(lattice.setSettings).toHaveBeenCalledWith({ favoriteModels: ['only'] })
  })
})
