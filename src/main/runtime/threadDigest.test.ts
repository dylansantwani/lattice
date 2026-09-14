import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ProviderConfig, ThreadMeta } from '@shared/types'

const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-digest-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import {
  CONTINUITY_CUE,
  DIGEST_MIN_NEW_CHARS,
  buildRecentWorkBlock,
  digestMatchScore,
  fallbackDigest,
  maybeUpdateThreadDigest
} from './threadDigest'

let wsId: string

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM thread_digests')
  wsId = store.ensureDefaultWorkspace().id
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

const provider: ProviderConfig = { id: 'p', label: 'p', kind: 'openai-compat', baseUrl: 'http://x', apiKey: '', enabled: true } as ProviderConfig

function thread(title = 'eBay sourcing'): ThreadMeta {
  return store.createThread({ workspaceId: wsId, title, model: 'm/x' })
}

function say(threadId: string, role: 'user' | 'assistant', text: string): ChatMessage {
  const msg: ChatMessage = { id: `${threadId}-${Math.random().toString(36).slice(2, 8)}`, threadId, role, createdAt: Date.now(), text }
  store.insertMessage(msg)
  return msg
}

/** A fake streaming provider that returns `reply` as one text chunk. */
function streamOf(reply: string, calls: string[] = []) {
  return async function* (_p: ProviderConfig, req: { messages: { content: string }[] }) {
    calls.push(String(req.messages.at(-1)?.content ?? ''))
    yield { type: 'text' as const, text: reply }
  } as unknown as typeof import('../providers/openaiCompat').streamChat
}

describe('maybeUpdateThreadDigest', () => {
  it('does nothing until the thread gained enough new text', async () => {
    const meta = thread()
    say(meta.id, 'user', 'hi')
    say(meta.id, 'assistant', 'hello')
    const out = await maybeUpdateThreadDigest({ meta, messages: store.listMessages(meta.id), model: 'm/u', provider, stream: streamOf('x') })
    expect(out).toBeNull()
    expect(store.getThreadDigest(meta.id)).toBeNull()
  })

  it('writes a model digest with the previous digest and the new turns in the prompt, and marks the watermark', async () => {
    const meta = thread()
    say(meta.id, 'user', 'Find me 3D printed knife stands selling on eBay under $15 that print in under two hours in black PLA. '.repeat(4))
    say(meta.id, 'assistant', 'Found three: a 4-slot stand at $12.99 (sold 40/90d), a magnetic strip mount, and a kitchen block. Next: check STR.'.repeat(3))
    const calls: string[] = []
    const first = await maybeUpdateThreadDigest({ meta, messages: store.listMessages(meta.id), model: 'm/u', provider, stream: streamOf('Sourcing eBay knife stands; found three candidates; next STR check.', calls) })
    expect(first?.digest).toContain('knife stands')
    expect(calls[0]).toContain('PREVIOUS DIGEST: (none')
    expect(first?.markId).toBe(store.listMessages(meta.id).at(-1)!.id)
    expect(store.getThreadDigest(meta.id)?.digest).toBe(first?.digest)

    // A second pass shortly after with little new text is throttled.
    say(meta.id, 'user', 'ok')
    const again = await maybeUpdateThreadDigest({ meta, messages: store.listMessages(meta.id), model: 'm/u', provider, stream: streamOf('unused', calls) })
    expect(again).toBeNull()
    expect(calls.length).toBe(1)

    // A large new span rewrites with the previous digest in the prompt.
    say(meta.id, 'assistant', 'STR results: the 4-slot stand is 62%, the block 18%. Recommend the stand. '.repeat(80))
    const third = await maybeUpdateThreadDigest({ meta, messages: store.listMessages(meta.id), model: 'm/u', provider, stream: streamOf('Sourcing eBay knife stands; STR done, 4-slot stand recommended.', calls), now: Date.now() + 1 })
    expect(third?.digest).toContain('STR done')
    expect(calls[1]).toContain('PREVIOUS DIGEST:\nSourcing eBay knife stands; found three candidates')
  })

  it('falls back to a deterministic digest when there is no provider or the model fails', async () => {
    const meta = thread()
    say(meta.id, 'user', 'Please set up the printer farm monitoring dashboard for the three Bambu printers. '.repeat(6))
    say(meta.id, 'assistant', 'Dashboard is up at http://localhost:8099 with per-printer status cards. '.repeat(6))
    const noProvider = await maybeUpdateThreadDigest({ meta, messages: store.listMessages(meta.id), model: 'm/u', provider: null })
    expect(noProvider?.digest).toContain('Asked: Please set up the printer farm')
    expect(noProvider?.digest).toContain('Latest: Dashboard is up')
    const failing = async function* () {
      throw new Error('boom')
    } as unknown as typeof import('../providers/openaiCompat').streamChat
    store.deleteThreadDigest(meta.id)
    const failed = await maybeUpdateThreadDigest({ meta, messages: store.listMessages(meta.id), model: 'm/u', provider, stream: failing })
    expect(failed?.digest).toContain('Latest:')
    expect(DIGEST_MIN_NEW_CHARS).toBeGreaterThan(0)
  })

  it('fallbackDigest keeps the previous digest ahead of the latest answer', () => {
    const msgs: ChatMessage[] = [
      { id: 'a', threadId: 't', role: 'user', createdAt: 1, text: 'first ask' },
      { id: 'b', threadId: 't', role: 'assistant', createdAt: 2, text: 'latest answer' }
    ]
    expect(fallbackDigest(msgs, 'old digest')).toBe('old digest Latest: latest answer')
  })
})

describe('buildRecentWorkBlock', () => {
  function seed(): { a: ThreadMeta; b: ThreadMeta; agent: ThreadMeta } {
    const a = thread('eBay knife stands')
    const b = thread('Tax forms')
    const agent = store.createThread({ workspaceId: wsId, title: 'Worker', model: 'm/x', isAgent: true })
    store.upsertThreadDigest({ threadId: a.id, digest: 'Sourcing 3D printed knife stands on eBay; three candidates found.', updatedAt: Date.now() - 60_000 })
    store.upsertThreadDigest({ threadId: b.id, digest: 'Filled the W-4 and saved it to ~/tax/w4.pdf.', updatedAt: Date.now() - 3_600_000 })
    store.upsertThreadDigest({ threadId: agent.id, digest: 'Worker digest: checked comps.', updatedAt: Date.now() })
    return { a, b, agent }
  }

  it('injects the freshest digests for a new thread and excludes the thread itself and agents', () => {
    const { a, agent } = seed()
    const me = thread('New chat')
    const { block, threadIds } = buildRecentWorkBlock({ threadId: me.id, workspaceId: wsId, text: 'hey', humanTurns: 1 })
    expect(block).toContain('[recent work]')
    expect(block).toContain(`session ${a.id}`)
    expect(threadIds).not.toContain(agent.id)
    expect(threadIds).not.toContain(me.id)
    expect(block.length).toBeLessThanOrEqual(900)
  })

  it('stays silent deep into a thread unless the turn reaches back or matches a digest', () => {
    const { a, b } = seed()
    const me = thread('Deep thread')
    expect(buildRecentWorkBlock({ threadId: me.id, workspaceId: wsId, text: 'now change the button color', humanTurns: 9 }).block).toBe('')
    const cue = buildRecentWorkBlock({ threadId: me.id, workspaceId: wsId, text: 'what were we doing yesterday?', humanTurns: 9 })
    expect(cue.threadIds[0]).toBe(a.id)
    const match = buildRecentWorkBlock({ threadId: me.id, workspaceId: wsId, text: 'the W-4 tax pdf I saved', humanTurns: 9 })
    expect(match.threadIds[0]).toBe(b.id)
    expect(CONTINUITY_CUE.test('continue')).toBe(true)
  })

  it('includes fleet agents for an orchestrator when asked', () => {
    const { agent } = seed()
    const me = thread('Orchestrator-ish')
    const { threadIds } = buildRecentWorkBlock({ threadId: me.id, workspaceId: wsId, text: 'status', humanTurns: 1, includeAgents: true })
    expect(threadIds).toContain(agent.id)
  })

  it('scores digests by distinct shared keywords', () => {
    const q = new Set(['knife', 'stands', 'ebay'])
    expect(digestMatchScore(q, 'Sourcing knife stands on eBay', 'x')).toBe(3)
    expect(digestMatchScore(q, 'tax forms', 'x')).toBe(0)
  })
})

describe('thread digest store', () => {
  it('lists newest first, skips archived threads, and is removed with the thread', () => {
    const a = thread('A')
    const b = thread('B')
    store.upsertThreadDigest({ threadId: a.id, digest: 'a', updatedAt: 1 })
    store.upsertThreadDigest({ threadId: b.id, digest: 'b', updatedAt: 2 })
    expect(store.listThreadDigests({ workspaceId: wsId }).map((d) => d.digest)).toEqual(['b', 'a'])
    store.updateThread(b.id, { archived: true })
    expect(store.listThreadDigests({ workspaceId: wsId }).map((d) => d.digest)).toEqual(['a'])
    store.deleteThread(a.id)
    expect(store.getThreadDigest(a.id)).toBeNull()
  })

  it('round-trips a persisted recall block on a user message', () => {
    const t = thread('R')
    const msg: ChatMessage = { id: 'r1', threadId: t.id, role: 'user', createdAt: 1, text: 'hello', recallText: '[recalled memory]\n- fact' }
    store.insertMessage(msg)
    expect(store.listMessages(t.id)[0]!.recallText).toBe('[recalled memory]\n- fact')
    const legacy: ChatMessage = { id: 'r2', threadId: t.id, role: 'user', createdAt: 2, text: 'old' }
    store.insertMessage(legacy)
    expect(store.listMessages(t.id)[1]!.recallText).toBeUndefined()
    store.updateMessage('r2', { recallText: '' })
    expect(store.listMessages(t.id)[1]!.recallText).toBe('')
  })
})
