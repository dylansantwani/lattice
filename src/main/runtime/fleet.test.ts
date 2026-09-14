import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import type { SendOptions } from '@shared/types'
import type { ToolDefinition } from '../tools/types'

const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-fleet-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from '../store/eventStore'
import * as agentStore from '../store/agents'
import { getDb, closeDb } from '../store/db'
import * as sm from './sessionMessaging'
import { delegateToAgent, gateFleetTools, resolveWorker } from './fleet'

let wsId: string
let steers: SendOptions[]
let runningIds: Set<string>

beforeEach(() => {
  getDb().exec(
    'DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM session_messages; DELETE FROM fleets; DELETE FROM agent_profiles'
  )
  agentStore.resetAgentCache()
  wsId = store.ensureDefaultWorkspace().id
  steers = []
  runningIds = new Set()
  sm.configureSessionMessaging({
    push: (_e: PushEvent) => {},
    isRunning: (id) => runningIds.has(id),
    steer: (opts) => steers.push(opts)
  })
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

function fleetWithAgents(): {
  fleetId: string
  orch: { id: string; threadId: string }
  ebay: { id: string; threadId: string }
} {
  const fleetId = agentStore.createFleet({ workspaceId: wsId, name: 'Sourcing' }).id
  const o = agentStore.createAgent({ fleetId, name: 'Conductor', kind: 'orchestrator', model: 'm/x' })
  const e = agentStore.createAgent({ fleetId, name: 'eBay', kind: 'worker', model: 'm/x' })
  return {
    fleetId,
    orch: { id: o.profile.id, threadId: o.thread.id },
    ebay: { id: e.profile.id, threadId: e.thread.id }
  }
}

describe('resolveWorker', () => {
  it('resolves by exact name, prefix, and id', () => {
    const { fleetId, ebay } = fleetWithAgents()
    expect((resolveWorker(fleetId, 'eBay') as { id: string }).id).toBe(ebay.id)
    expect((resolveWorker(fleetId, 'eb') as { id: string }).id).toBe(ebay.id)
    expect((resolveWorker(fleetId, ebay.threadId) as { id: string }).id).toBe(ebay.id)
  })

  it('errors on an unknown agent', () => {
    const { fleetId } = fleetWithAgents()
    expect(resolveWorker(fleetId, 'nope')).toHaveProperty('error')
  })
})

describe('delegateToAgent', () => {
  it('wakes an idle worker (delegate)', () => {
    const { orch, ebay } = fleetWithAgents()
    const res = delegateToAgent(orch.threadId, 'eBay', 'Find 16GB DDR4 kits')
    expect(res.ok).toBe(true)
    expect(res.delivery).toBe('woken')
    expect(res.agent).toBe('eBay')
    // the task reached the worker thread via the messaging steer lane
    expect(steers.at(-1)?.threadId).toBe(ebay.threadId)
    expect(steers.at(-1)?.text).toContain('Find 16GB DDR4 kits')
  })

  it('injects into a running worker (steer)', () => {
    const { orch, ebay } = fleetWithAgents()
    runningIds.add(ebay.threadId)
    const res = delegateToAgent(orch.threadId, 'eBay', 'also check RAM prices')
    expect(res.delivery).toBe('injected')
  })

  it('refuses to delegate from a non-orchestrator thread', () => {
    const { ebay } = fleetWithAgents()
    const res = delegateToAgent(ebay.threadId, 'eBay', 'x')
    expect(res.ok).toBe(false)
  })

  it('refuses an unknown target', () => {
    const { orch } = fleetWithAgents()
    expect(delegateToAgent(orch.threadId, 'ghost', 'x').ok).toBe(false)
  })

  it('supports the round trip: a worker reports back to its idle orchestrator', () => {
    const { orch, ebay } = fleetWithAgents()
    // orchestrator delegates → worker wakes
    expect(delegateToAgent(orch.threadId, 'eBay', 'source parts').delivery).toBe('woken')
    // worker finishes and reports back → orchestrator (idle) is woken with the result
    const back = sm.sendSessionMessage({ fromThreadId: ebay.threadId, to: orch.threadId, body: 'Found 8 kits.' })
    expect(back.ok).toBe(true)
    expect(back.delivery).toBe('woken')
    expect(steers.at(-1)?.threadId).toBe(orch.threadId)
    expect(steers.at(-1)?.text).toContain('Found 8 kits.')
  })

  it('folds a follow-up into a busy agent (steer/queue while it works)', () => {
    const { orch, ebay } = fleetWithAgents()
    runningIds.add(ebay.threadId)
    // two rapid delegations to a busy worker both fold into its live run
    expect(delegateToAgent(orch.threadId, 'eBay', 'first').delivery).toBe('injected')
    expect(delegateToAgent(orch.threadId, 'eBay', 'second').delivery).toBe('injected')
    expect(steers.filter((s) => s.threadId === ebay.threadId)).toHaveLength(2)
  })
})

describe('gateFleetTools', () => {
  const tool = (name: string, mcpServerId?: string): ToolDefinition =>
    ({ name, ...(mcpServerId ? { mcpServerId } : {}) }) as unknown as ToolDefinition
  const base = (): ToolDefinition[] => [
    tool('delegate_to_agent'),
    tool('list_fleet'),
    tool('fs_read'),
    tool('shell'),
    tool('send_message'),
    tool('memory_search'),
    tool('mcp__x__do', 'x')
  ]

  it('keeps fleet tools for an orchestrator and strips them for a worker', () => {
    const { orch, ebay } = fleetWithAgents()
    const forOrch = gateFleetTools(base(), orch.threadId).map((t) => t.name)
    expect(forOrch).toContain('delegate_to_agent')
    expect(forOrch).toContain('list_fleet')
    const forWorker = gateFleetTools(base(), ebay.threadId).map((t) => t.name)
    expect(forWorker).not.toContain('delegate_to_agent')
    expect(forWorker).not.toContain('list_fleet')
  })

  it('narrows a worker with an allowlist but keeps coordination tools and MCP', () => {
    const fleetId = agentStore.createFleet({ workspaceId: wsId, name: 'F' }).id
    const w = agentStore.createAgent({
      fleetId,
      name: 'Narrow',
      kind: 'worker',
      model: 'm/x',
      allowedTools: ['fs_read']
    })
    const names = gateFleetTools(base(), w.thread.id).map((t) => t.name)
    expect(names).toContain('fs_read')
    expect(names).not.toContain('shell') // not in the allowlist
    expect(names).toContain('send_message') // always kept for reporting back
    expect(names).toContain('memory_search') // always kept for recall
    expect(names).toContain('mcp__x__do') // MCP tools it loaded are kept
  })

  it('leaves a plain (non-agent) thread untouched', () => {
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    const names = gateFleetTools(base(), plain).map((t) => t.name)
    // non-orchestrator, so fleet tools are stripped, but nothing else is narrowed
    expect(names).toEqual(['fs_read', 'shell', 'send_message', 'memory_search', 'mcp__x__do'])
  })
})
