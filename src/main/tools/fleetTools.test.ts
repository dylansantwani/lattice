import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import type { ToolContext, ToolDefinition } from './types'

const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-fleettools-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from '../store/eventStore'
import * as agentStore from '../store/agents'
import { getDb, closeDb } from '../store/db'
import * as sm from '../runtime/sessionMessaging'
import { fleetTools } from './fleetTools'

const listFleet = fleetTools.find((t) => t.name === 'list_fleet')!
const delegate = fleetTools.find((t) => t.name === 'delegate_to_agent')!

let wsId: string
let runningIds: Set<string>

beforeEach(() => {
  getDb().exec(
    'DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM session_messages; DELETE FROM fleets; DELETE FROM agent_profiles'
  )
  agentStore.resetAgentCache()
  wsId = store.ensureDefaultWorkspace().id
  runningIds = new Set()
  sm.configureSessionMessaging({
    push: (_e: PushEvent) => {},
    isRunning: (id) => runningIds.has(id),
    steer: () => {}
  })
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

function ctxFor(threadId: string): ToolContext {
  const threadMeta = store.getThreadMeta(threadId)!
  const workspace = store.listWorkspaces()[0]!
  return {
    threadMeta,
    workspace,
    runId: 'run-test',
    signal: new AbortController().signal
  } as ToolContext
}

function setup(): { orchThread: string; ebayName: string } {
  const fleetId = agentStore.createFleet({ workspaceId: wsId, name: 'Sourcing' }).id
  const o = agentStore.createAgent({ fleetId, name: 'Conductor', kind: 'orchestrator', model: 'm/x' })
  agentStore.createAgent({ fleetId, name: 'eBay', kind: 'worker', model: 'm/x', role: 'sources parts' })
  return { orchThread: o.thread.id, ebayName: 'eBay' }
}

describe('list_fleet tool', () => {
  it('lists the orchestrator\'s workers (excluding itself)', async () => {
    const { orchThread } = setup()
    const res = (await listFleet.run({}, ctxFor(orchThread))) as {
      count: number
      agents: { name: string; role?: string }[]
    }
    expect(res.count).toBe(1)
    expect(res.agents[0]!.name).toBe('eBay')
    expect(res.agents[0]!.role).toBe('sources parts')
  })

  it('refuses on a thread that is not an orchestrator', async () => {
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    const res = (await listFleet.run({}, ctxFor(plain))) as { ok?: boolean }
    expect(res.ok).toBe(false)
  })
})

describe('delegate_to_agent tool', () => {
  it('delegates a task to a named worker', async () => {
    const { orchThread, ebayName } = setup()
    const res = (await delegate.run({ agent: ebayName, task: 'find DDR4' }, ctxFor(orchThread))) as {
      ok: boolean
      delivery: string
      agent: string
    }
    expect(res.ok).toBe(true)
    expect(res.delivery).toBe('woken')
    expect(res.agent).toBe('eBay')
  })

  it('validates arguments', async () => {
    const { orchThread } = setup()
    expect(((await delegate.run({ agent: '', task: 'x' }, ctxFor(orchThread))) as { ok?: boolean }).ok).toBe(false)
    expect(((await delegate.run({ agent: 'eBay', task: '' }, ctxFor(orchThread))) as { ok?: boolean }).ok).toBe(false)
  })

  it('errors when the agent is unknown', async () => {
    const { orchThread } = setup()
    const res = (await delegate.run({ agent: 'ghost', task: 'x' }, ctxFor(orchThread))) as { ok?: boolean }
    expect(res.ok).toBe(false)
  })
})

// The declared tool contracts (a defensive check that nothing drifts).
describe('fleet tool contracts', () => {
  it('exposes exactly the two fleet tools as R0 external_action tools', () => {
    expect(fleetTools.map((t: ToolDefinition) => t.name).sort()).toEqual(['delegate_to_agent', 'list_fleet'])
    for (const t of fleetTools) {
      expect(t.resource).toBe('external_action')
      expect(t.riskTier).toBe('R0')
    }
  })
})
