import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from './types'

const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-history-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from '../store/eventStore'
import * as agentStore from '../store/agents'
import { closeDb, getDb } from '../store/db'
import { historyTools } from './historyTools'

const recall = historyTools.find((t) => t.name === 'recall_threads')!
let wsId: string

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM thread_digests; DELETE FROM fleets; DELETE FROM agent_profiles')
  agentStore.resetAgentCache()
  wsId = store.ensureDefaultWorkspace().id
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

function ctxFor(threadId: string): ToolContext {
  return { threadMeta: store.getThreadMeta(threadId)!, workspace: store.listWorkspaces()[0]!, runId: 'r', signal: new AbortController().signal } as ToolContext
}

describe('recall_threads', () => {
  it('returns recent digests without a query and keyword-ranked ones with a query, never the caller', async () => {
    const me = store.createThread({ workspaceId: wsId, title: 'me', model: 'm/x' })
    const a = store.createThread({ workspaceId: wsId, title: 'eBay knife stands', model: 'm/x' })
    const b = store.createThread({ workspaceId: wsId, title: 'Taxes', model: 'm/x' })
    store.upsertThreadDigest({ threadId: me.id, digest: 'my own digest', updatedAt: 3 })
    store.upsertThreadDigest({ threadId: a.id, digest: 'Sourcing knife stands on eBay.', updatedAt: 2 })
    store.upsertThreadDigest({ threadId: b.id, digest: 'Filed the W-4 form.', updatedAt: 1 })
    const recent = (await recall.run({}, ctxFor(me.id))) as { count: number; items: { session: string; title: string }[] }
    expect(recent.items.map((i) => i.session)).toEqual([a.id, b.id])
    const hit = (await recall.run({ query: 'knife ebay' }, ctxFor(me.id))) as { items: { session: string }[] }
    expect(hit.items.map((i) => i.session)).toEqual([a.id])
    const miss = (await recall.run({ query: 'zebra' }, ctxFor(me.id))) as { count: number; note?: string }
    expect(miss.count).toBe(0)
    expect(miss.note).toBeTruthy()
  })

  it('shows fleet agents to an orchestrator but not to a plain thread', async () => {
    const fleetId = agentStore.createFleet({ workspaceId: wsId, name: 'F' }).id
    const orch = agentStore.createAgent({ fleetId, name: 'Lead', kind: 'orchestrator', model: 'm/x' })
    const worker = agentStore.createAgent({ fleetId, name: 'W', kind: 'worker', model: 'm/x' })
    store.upsertThreadDigest({ threadId: worker.thread.id, digest: 'checked comps', updatedAt: 5 })
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' })
    const fromOrch = (await recall.run({}, ctxFor(orch.thread.id))) as { items: { session: string; kind?: string }[] }
    expect(fromOrch.items.map((i) => i.session)).toContain(worker.thread.id)
    expect(fromOrch.items[0]!.kind).toBe('fleet agent')
    const fromPlain = (await recall.run({}, ctxFor(plain.id))) as { items: { session: string }[] }
    expect(fromPlain.items.map((i) => i.session)).not.toContain(worker.thread.id)
  })
})
