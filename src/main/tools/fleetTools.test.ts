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

const tool = (name: string): ToolDefinition => fleetTools.find((t) => t.name === name)!
const listFleet = tool('list_fleet')
const delegate = tool('delegate_to_agent')
const createFleet = tool('create_fleet')
const addAgent = tool('add_agent')
const updateAgent = tool('update_agent')
const removeAgent = tool('remove_agent')

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

  it('from a plain thread lists every fleet with its orchestrator session, or one fleet by name', async () => {
    setup()
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    const all = (await listFleet.run({}, ctxFor(plain))) as {
      count: number
      fleets: { name: string; orchestrator: string; orchestrator_session: string; agents: { name: string; session: string }[] }[]
    }
    expect(all.count).toBe(1)
    expect(all.fleets[0]!.name).toBe('Sourcing')
    expect(all.fleets[0]!.orchestrator).toBe('Conductor')
    expect(all.fleets[0]!.agents.map((a) => a.name)).toEqual(['Conductor', 'eBay'])
    const one = (await listFleet.run({ fleet: 'sourcing' }, ctxFor(plain))) as { fleet: string; count: number }
    expect(one.fleet).toBe('Sourcing')
    expect(one.count).toBe(2)
    expect((await listFleet.run({ fleet: 'nope' }, ctxFor(plain))) as { ok?: boolean }).toHaveProperty('ok', false)
  })

  it('refuses a worker', async () => {
    setup()
    const worker = agentStore.listAgents(agentStore.listFleets(wsId)[0]!.id).find((a) => a.kind === 'worker')!
    const res = (await listFleet.run({}, ctxFor(worker.threadId))) as { ok?: boolean }
    expect(res.ok).toBe(false)
  })

  it('includes each agent\'s session id so the orchestrator can peek_session it', async () => {
    const { orchThread } = setup()
    const res = (await listFleet.run({}, ctxFor(orchThread))) as { agents: { name: string; session: string; permissions: string }[] }
    const worker = agentStore.listAgents(agentStore.listFleets(wsId)[0]!.id).find((a) => a.kind === 'worker')!
    expect(res.agents[0]!.session).toBe(worker.threadId)
    expect(res.agents[0]!.permissions).toBe('workspace')
  })
})

describe('create_fleet / add_agent / update_agent / remove_agent tools', () => {
  it('builds a whole fleet from one call and tells the caller how to drive it', async () => {
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    const res = (await createFleet.run(
      {
        name: '3D Print Desk',
        orchestrator: { name: 'Desk Lead', role: 'coordinate' },
        agents: [
          { name: 'Product Sourcer', role: 'find products', tools: ['web_search', 'web_fetch'] },
          { name: 'Listing Maker', role: 'write listings', permissions: 'workspace' }
        ]
      },
      ctxFor(plain)
    )) as { ok: boolean; fleet: { name: string; agents: { name: string; kind: string; session: string; permissions: string }[] }; next: string }
    expect(res.ok).toBe(true)
    expect(res.fleet.agents.map((a) => `${a.kind}:${a.name}`)).toEqual([
      'orchestrator:Desk Lead',
      'worker:Product Sourcer',
      'worker:Listing Maker'
    ])
    expect(res.fleet.agents[1]!.permissions).toBe('full')
    expect(res.fleet.agents[2]!.permissions).toBe('workspace')
    expect(res.next).toContain(res.fleet.agents[0]!.session)
    // The orchestrator thread now really is one: it gets the fleet prompt and role.
    expect(store.getThreadMeta(res.fleet.agents[0]!.session)?.goal).toBe('coordinate')
    expect(agentStore.agentForThread(res.fleet.agents[0]!.session)?.kind).toBe('orchestrator')
  })

  it('an orchestrator can add to, edit and prune its own fleet without naming it', async () => {
    const { orchThread } = setup()
    const added = (await addAgent.run({ name: 'Comp Scout', role: 'checks comps' }, ctxFor(orchThread))) as {
      ok: boolean
      fleet: string
      agent: { name: string; session: string }
    }
    expect(added.ok).toBe(true)
    expect(added.fleet).toBe('Sourcing')
    const upd = (await updateAgent.run({ agent: 'comp', role: 'checks SOLD comps', permissions: 'manual' }, ctxFor(orchThread))) as {
      ok: boolean
      agent: { permissions: string }
    }
    expect(upd.ok).toBe(true)
    expect(upd.agent.permissions).toBe('manual')
    expect(store.getThreadMeta(added.agent.session)?.goal).toBe('checks SOLD comps')
    expect(((await updateAgent.run({ agent: 'comp' }, ctxFor(orchThread))) as { ok: boolean }).ok).toBe(false)
    const gone = (await removeAgent.run({ agent: 'Comp Scout' }, ctxFor(orchThread))) as { ok: boolean; removed: string }
    expect(gone.ok).toBe(true)
    expect(gone.removed).toBe('Comp Scout')
    expect(store.getThreadMeta(added.agent.session)).toBeFalsy()
    expect(((await removeAgent.run({ agent: 'Conductor' }, ctxFor(orchThread))) as { ok: boolean }).ok).toBe(false)
  })

  it('a plain thread must name the fleet when several exist, and workers are refused', async () => {
    setup()
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    expect(((await addAgent.run({ name: 'X' }, ctxFor(plain))) as { ok: boolean }).ok).toBe(true) // only one fleet
    await createFleet.run({ name: 'Second', agents: [] }, ctxFor(plain))
    const ambiguous = (await addAgent.run({ name: 'Y' }, ctxFor(plain))) as { ok: boolean; error: string }
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.error).toContain('Second')
    expect(((await addAgent.run({ name: 'Y', fleet: 'Second' }, ctxFor(plain))) as { ok: boolean }).ok).toBe(true)
    const worker = agentStore.listAgents(agentStore.listFleets(wsId)[0]!.id).find((a) => a.kind === 'worker')!
    for (const t of [createFleet, addAgent, updateAgent, removeAgent]) {
      const args = t === createFleet ? { name: 'Z', agents: [] } : { agent: 'X', name: 'Z' }
      expect(((await t.run(args, ctxFor(worker.threadId))) as { ok: boolean }).ok).toBe(false)
    }
  })

  it('validates a spec and names the bad field', async () => {
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    const bad = (await createFleet.run({ name: 'Bad', agents: [{ name: 'A', permissions: 'yolo' }] }, ctxFor(plain))) as {
      ok: boolean
      error: string
      created_so_far?: { agents: { name: string }[] }
    }
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('permissions')
    expect(bad.created_so_far?.agents.map((a) => a.name)).toEqual(['Bad Lead'])
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
  it('exposes the six fleet tools as external_action tools; only remove_agent asks (R1)', () => {
    expect(fleetTools.map((t: ToolDefinition) => t.name).sort()).toEqual([
      'add_agent',
      'create_fleet',
      'delegate_to_agent',
      'list_fleet',
      'remove_agent',
      'update_agent'
    ])
    for (const t of fleetTools) {
      expect(t.resource).toBe('external_action')
      expect(t.riskTier).toBe(t.name === 'remove_agent' ? 'R1' : 'R0')
    }
  })
})
