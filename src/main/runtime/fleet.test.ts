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
import {
  configureFleet,
  createAgentFromSpec,
  createFleetFromSpec,
  delegateToAgent,
  fleetForCall,
  fleetLeanKeep,
  fleetPromptSection,
  gateFleetTools,
  logScreenUpdate,
  removeAgent,
  reportWorkerRun,
  resetFleet,
  resolveWorker,
  snapshotAgent,
  updateAgentFromSpec
} from './fleet'
import { readWorkingMemory, workingMemoryPath, writeWorkingMemory } from './agentMemory'

let wsId: string
let steers: SendOptions[]
let runningIds: Set<string>

beforeEach(() => {
  getDb().exec(
    'DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM session_messages; DELETE FROM fleets; DELETE FROM agent_profiles; DELETE FROM fleet_changes'
  )
  agentStore.resetAgentCache()
  resetFleet()
  // Root the workspace in the temp dir: agents default their cwd (and their WORKING_MEMORY.md) to
  // <root>/fleet/<slug>, and the real default root is the user's home directory.
  wsId = store.updateWorkspace(store.ensureDefaultWorkspace().id, { roots: [mockDataDir] }).id
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

  it('starts an idle fresh-per-task worker on a clean context before the task lands', () => {
    const fleetId = agentStore.createFleet({ workspaceId: wsId, name: 'Desk' }).id
    const orch = agentStore.createAgent({ fleetId, name: 'Lead', kind: 'orchestrator', model: 'm/x', rolling: true })
    const worker = agentStore.createAgent({ fleetId, name: 'Puller', kind: 'worker', model: 'm/x', rolling: true })
    const order: string[] = []
    configureFleet({
      push: () => {},
      isPathInsideRoots: async () => true,
      startFreshTask: (threadId) => {
        order.push(`fresh:${threadId}`)
        return 7
      }
    })
    const originalSteer = steers.push.bind(steers)
    steers.push = (...items: SendOptions[]) => {
      order.push('steer')
      return originalSteer(...items)
    }
    const res = delegateToAgent(orch.thread.id, 'Puller', 'Pull photos for item 188803918063')
    expect(res).toMatchObject({ ok: true, delivery: 'woken', freshContext: true, setAside: 7 })
    // The boundary is drawn before the task is delivered, so the task is the first thing in the new context.
    expect(order).toEqual([`fresh:${worker.thread.id}`, 'steer'])

    // A busy worker gets a follow-up, never a boundary.
    order.length = 0
    runningIds.add(worker.thread.id)
    expect(delegateToAgent(orch.thread.id, 'Puller', 'also the second item')).toMatchObject({ delivery: 'injected', setAside: 0 })
    expect(order).toEqual(['steer'])
  })

  it('never draws a boundary for a worker without the fresh-per-task policy', () => {
    const { orch } = fleetWithAgents()
    let called = false
    configureFleet({ push: () => {}, isPathInsideRoots: async () => true, startFreshTask: () => ((called = true), 1) })
    expect(delegateToAgent(orch.threadId, 'eBay', 'x')).toMatchObject({ ok: true, freshContext: false, setAside: 0 })
    expect(called).toBe(false)
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
    tool('ask_user'),
    tool('mcp__x__do', 'x')
  ]

  it('keeps fleet tools + ask_user for an orchestrator, strips both from a worker', () => {
    const { orch, ebay } = fleetWithAgents()
    const forOrch = gateFleetTools(base(), orch.threadId).map((t) => t.name)
    expect(forOrch).toContain('delegate_to_agent')
    expect(forOrch).toContain('list_fleet')
    expect(forOrch).toContain('ask_user') // orchestrator can escalate to the human
    const forWorker = gateFleetTools(base(), ebay.threadId).map((t) => t.name)
    expect(forWorker).not.toContain('delegate_to_agent')
    expect(forWorker).not.toContain('list_fleet')
    expect(forWorker).not.toContain('ask_user') // a worker escalates to the orchestrator instead
    expect(forWorker).toContain('send_message') // ...via send_message, which stays
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

  it('leaves a plain (non-agent) thread its tools (ask_user, list_fleet) and strips only delegate_to_agent', () => {
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    const names = gateFleetTools(base(), plain).map((t) => t.name)
    expect(names).not.toContain('delegate_to_agent')
    expect(names).toContain('list_fleet')
    expect(names).toContain('ask_user')
    expect(names).toContain('fs_read')
  })
})

describe('fleetPromptSection', () => {
  it('gives the orchestrator its roster and the escalation rule', () => {
    const { orch } = fleetWithAgents()
    const s = fleetPromptSection(orch.threadId)!
    expect(s).toContain('# Fleet')
    expect(s).toContain('orchestrator of the "Sourcing" fleet')
    expect(s).toContain('eBay') // the worker appears in the roster
    expect(s).toContain('ask_user') // told when to escalate to the human
  })

  it('tells a worker to report to and escalate to the orchestrator', () => {
    const { orch, ebay } = fleetWithAgents()
    const s = fleetPromptSection(ebay.threadId)!
    expect(s).toContain('worker agent')
    expect(s).toContain(orch.threadId) // knows the orchestrator's session id to message
    expect(s).toContain('direct line to the human') // no direct line — escalate to the orchestrator
  })

  it('returns null for a non-agent thread', () => {
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    expect(fleetPromptSection(plain)).toBeNull()
  })
})

describe('fleetLeanKeep', () => {
  it('keeps messaging for a worker and messaging + peeking + fleet verbs for an orchestrator; nothing for a plain thread', () => {
    const { orch, ebay } = fleetWithAgents()
    expect([...(fleetLeanKeep(ebay.threadId) ?? [])].sort()).toEqual(['check_inbox', 'recall_threads', 'send_message', 'working_memory'])
    expect(fleetLeanKeep(orch.threadId)?.has('peek_session')).toBe(true)
    expect(fleetLeanKeep(orch.threadId)?.has('delegate_to_agent')).toBe(true)
    // self-improvement survives the lean cut on a local-model orchestrator
    for (const name of ['add_agent', 'update_agent', 'remove_agent', 'fleet_history', 'working_memory']) {
      expect(fleetLeanKeep(orch.threadId)?.has(name)).toBe(true)
    }
    expect(fleetLeanKeep(orch.threadId)?.has('create_fleet')).toBe(false)
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    expect(fleetLeanKeep(plain)).toBeUndefined()
  })
})

describe('gateFleetTools for a plain thread', () => {
  const mk = (name: string): ToolDefinition => ({ name } as ToolDefinition)
  it('keeps the fleet-building verbs but strips delegate_to_agent', () => {
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    const names = gateFleetTools(
      ['fs_read', 'ask_user', 'list_fleet', 'create_fleet', 'add_agent', 'update_agent', 'remove_agent', 'fleet_history', 'delegate_to_agent', 'working_memory'].map(mk),
      plain
    ).map((t) => t.name)
    expect(names).toEqual(['fs_read', 'ask_user', 'list_fleet', 'create_fleet', 'add_agent', 'update_agent', 'remove_agent', 'fleet_history'])
  })
  it('strips every fleet verb and ask_user from a worker', () => {
    const { ebay } = fleetWithAgents()
    const names = gateFleetTools(
      ['fs_read', 'ask_user', 'send_message', 'list_fleet', 'create_fleet', 'add_agent', 'delegate_to_agent', 'fleet_history', 'working_memory'].map(mk),
      ebay.threadId
    ).map((t) => t.name)
    expect(names).toEqual(['fs_read', 'send_message', 'working_memory'])
  })
})

describe('building a fleet from a spec', () => {
  it('creates the fleet, a default orchestrator and the workers with sensible defaults', async () => {
    const res = await createFleetFromSpec(wsId, {
      name: '3D Print Desk',
      agents: [
        { name: 'Product Sourcer', role: 'finds products' },
        { name: 'STL Finder', role: 'finds files', permissions: 'workspace', tools: ['web_search'], rolling: false }
      ]
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.fleet.agents.map((a) => a.kind)).toEqual(['orchestrator', 'worker', 'worker'])
    const [lead, sourcer, stl] = res.fleet.agents
    expect(lead!.name).toBe('3D Print Desk Lead')
    expect(lead!.permissions).toBe('full')
    expect(sourcer!.permissions).toBe('full')
    expect(sourcer!.rolling).toBe(true)
    expect(sourcer!.cwd).toMatch(/fleet\/product-sourcer$/)
    expect(stl!.permissions).toBe('workspace')
    expect(stl!.tools).toEqual(['web_search'])
    expect(stl!.rolling).toBe(false)
    // The orchestrator's prompt now names each worker with its session id.
    const prompt = fleetPromptSection(lead!.session)!
    expect(prompt).toContain(`Product Sourcer (session ${sourcer!.session})`)
    expect(prompt).toContain('memory_search')
    // A worker's prompt tells it its reply is forwarded automatically.
    expect(fleetPromptSection(sourcer!.session)).toContain('forwarded to the orchestrator automatically')
  })

  it('refuses a duplicate fleet name, a duplicate agent name and a second orchestrator', async () => {
    const first = await createFleetFromSpec(wsId, { name: 'Desk', agents: [{ name: 'A' }] })
    expect(first.ok).toBe(true)
    const dup = await createFleetFromSpec(wsId, { name: 'desk', agents: [] })
    expect(dup.ok).toBe(false)
    const fleet = agentStore.listFleets(wsId)[0]!
    expect((await createAgentFromSpec(fleet, { name: 'a' })).ok).toBe(false)
    expect((await createAgentFromSpec(fleet, { name: 'Boss', kind: 'orchestrator' })).ok).toBe(false)
  })

  it('reports the failing agent and keeps what was created before it', async () => {
    const res = await createFleetFromSpec(wsId, {
      name: 'Partial',
      agents: [{ name: 'Good' }, { name: '' }]
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('name')
    expect(res.fleet?.agents.map((a) => a.name)).toEqual(['Partial Lead', 'Good'])
  })

  it('updates role, model, permissions and tools in place, and keeps the thread', async () => {
    const res = await createFleetFromSpec(wsId, { name: 'Upd', agents: [{ name: 'W', role: 'old' }] })
    if (!res.ok) throw new Error(res.error)
    const worker = agentStore.listAgents(res.fleet.id).find((a) => a.kind === 'worker')!
    const upd = await updateAgentFromSpec(worker, { role: 'new', model: 'm/y', permissions: 'manual', tools: ['fs_read'] })
    expect(upd.ok).toBe(true)
    if (!upd.ok) return
    expect(upd.agent.session).toBe(worker.threadId)
    expect(upd.agent.model).toBe('m/y')
    expect(upd.agent.permissions).toBe('manual')
    expect(upd.agent.tools).toEqual(['fs_read'])
    expect(store.getThreadMeta(worker.threadId)?.goal).toBe('new')
    expect((await updateAgentFromSpec(worker, { kind: 'orchestrator' })).ok).toBe(false)
  })

  it('resolves the fleet for a call: explicit name, own fleet, or the only fleet', async () => {
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    expect(fleetForCall(plain, wsId)).toHaveProperty('error')
    const a = await createFleetFromSpec(wsId, { name: 'Alpha', agents: [] })
    if (!a.ok) throw new Error(a.error)
    expect((fleetForCall(plain, wsId) as { id: string }).id).toBe(a.fleet.id)
    const b = await createFleetFromSpec(wsId, { name: 'Beta', agents: [] })
    if (!b.ok) throw new Error(b.error)
    expect(fleetForCall(plain, wsId)).toHaveProperty('error')
    expect((fleetForCall(plain, wsId, 'beta') as { id: string }).id).toBe(b.fleet.id)
    const lead = a.fleet.agents[0]!
    expect((fleetForCall(lead.session, wsId) as { id: string }).id).toBe(a.fleet.id)
  })
})

describe('reportWorkerRun', () => {
  it('forwards a delegated worker run\'s final reply to the orchestrator when it did not message it', () => {
    const { orch, ebay } = fleetWithAgents()
    const startedAt = Date.now() - 1000
    const sent = reportWorkerRun({ threadId: ebay.threadId, delegatedBy: orch.threadId, startedAt, text: 'Found a $12 knife stand.', reason: 'done' })
    expect(sent).toBe(true)
    const last = steers.at(-1)!
    expect(last.threadId).toBe(orch.threadId)
    expect(last.text).toContain('Found a $12 knife stand.')
    expect(last.origin?.fromThreadId).toBe(ebay.threadId)
    // the report nudges a retro
    expect(last.text).toContain('working_memory')
  })

  it('asks for a root-cause fix when the worker run failed', () => {
    const { orch, ebay } = fleetWithAgents()
    reportWorkerRun({ threadId: ebay.threadId, delegatedBy: orch.threadId, startedAt: Date.now() - 1000, text: '', reason: 'error' })
    const last = steers.at(-1)!
    expect(last.text).toContain('ERROR')
    expect(last.text).toContain('fix the cause')
    expect(last.text).toContain('update_agent')
  })

  it('does not forward when the worker already reported during the run', () => {
    const { orch, ebay } = fleetWithAgents()
    const startedAt = Date.now() - 1000
    sm.sendSessionMessage({ fromThreadId: ebay.threadId, to: orch.threadId, body: 'my own report' })
    const before = steers.length
    expect(reportWorkerRun({ threadId: ebay.threadId, delegatedBy: orch.threadId, startedAt, text: 'x', reason: 'done' })).toBe(false)
    expect(steers.length).toBe(before)
  })

  it('does not forward runs the human started in the worker thread, orchestrator runs, or plain threads', () => {
    const { orch, ebay } = fleetWithAgents()
    const startedAt = Date.now()
    expect(reportWorkerRun({ threadId: ebay.threadId, startedAt, text: 'x', reason: 'done' })).toBe(false)
    expect(reportWorkerRun({ threadId: orch.threadId, delegatedBy: ebay.threadId, startedAt, text: 'x', reason: 'done' })).toBe(false)
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    expect(reportWorkerRun({ threadId: plain, delegatedBy: orch.threadId, startedAt, text: 'x', reason: 'done' })).toBe(false)
  })

  it('labels an errored or cut-off run so the orchestrator knows the report is partial', () => {
    const { orch, ebay } = fleetWithAgents()
    reportWorkerRun({ threadId: ebay.threadId, delegatedBy: orch.threadId, startedAt: Date.now() - 10, text: 'half', reason: 'error' })
    expect(steers.at(-1)!.text).toContain('ERROR')
    reportWorkerRun({ threadId: ebay.threadId, delegatedBy: orch.threadId, startedAt: Date.now() + 10, text: '', reason: 'length' })
    expect(steers.at(-1)!.text).toContain('cut off')
  })
})

describe('gateFleetTools for an orchestrator', () => {
  const mk = (name: string): ToolDefinition => ({ name } as ToolDefinition)
  it('keeps coordination tools and strips the work tools, so delegation is the only path', () => {
    const { orch } = fleetWithAgents()
    const names = gateFleetTools(
      ['web_search', 'fs_read', 'shell', 'ask_user', 'list_fleet', 'delegate_to_agent', 'peek_session', 'send_message', 'memory_search', 'recall_threads', 'add_agent', 'create_fleet'].map(mk),
      orch.threadId
    ).map((t) => t.name)
    expect(names).toEqual(['ask_user', 'list_fleet', 'delegate_to_agent', 'peek_session', 'send_message', 'memory_search', 'recall_threads', 'add_agent'])
  })
  it('an orchestrator allowlist adds work tools back', () => {
    const { orch } = fleetWithAgents()
    const profile = agentStore.agentForThread(orch.threadId)!
    agentStore.updateAgent(profile.id, { allowedTools: ['fs_read'] })
    const names = gateFleetTools(['web_search', 'fs_read', 'delegate_to_agent'].map(mk), orch.threadId).map((t) => t.name)
    expect(names).toEqual(['fs_read', 'delegate_to_agent'])
  })
})

describe('learning: change log and self-improvement', () => {
  it('the orchestrator prompt teaches the retro loop and the self-improvement verbs', () => {
    const { orch, ebay } = fleetWithAgents()
    const prompt = fleetPromptSection(orch.threadId)!
    expect(prompt).toContain('Getting better over time')
    expect(prompt).toContain('working_memory')
    expect(prompt).toContain('Lessons learned')
    expect(prompt).toContain('update_agent')
    expect(prompt).toContain('add_agent')
    expect(prompt).toContain('remove_agent')
    expect(prompt).toContain('fleet_history')
    expect(fleetPromptSection(ebay.threadId)).toContain('working_memory')
  })

  it('records who changed what and why, with before/after, and notes it in the lead\'s notebook', async () => {
    const res = await createFleetFromSpec(wsId, { name: 'Desk', agents: [{ name: 'Sourcer', role: 'find items' }] }, { actor: 'chat "setup"', reason: 'created with the fleet' })
    if (!res.ok) throw new Error(res.error)
    const adds = agentStore.listFleetChanges(res.fleet.id)
    expect(adds.map((c) => `${c.action}:${c.agentName}`).sort()).toEqual(['add:Desk Lead', 'add:Sourcer'])

    const sourcer = agentStore.listAgents(res.fleet.id).find((a) => a.name === 'Sourcer')!
    const upd = await updateAgentFromSpec(sourcer, { role: 'find SOLD items only', model: 'm/y' }, { actor: 'Desk Lead', reason: 'kept returning active listings' })
    if (!upd.ok) throw new Error(upd.error)
    expect(upd.changed.sort()).toEqual(['model', 'role'])
    expect(upd.previous.role).toBe('find items')

    const [latest] = agentStore.listFleetChanges(res.fleet.id, { agent: 'sourcer', limit: 1 })
    expect(latest!.action).toBe('update')
    expect(latest!.actor).toBe('Desk Lead')
    expect(latest!.reason).toBe('kept returning active listings')
    expect(latest!.before).toEqual({ role: 'find items', model: expect.any(String) })
    expect(latest!.after).toEqual({ role: 'find SOLD items only', model: 'm/y' })

    const lead = agentStore.listAgents(res.fleet.id).find((a) => a.kind === 'orchestrator')!
    const notebook = readWorkingMemory(lead).content
    expect(notebook).toContain('added Sourcer by chat "setup"')
    expect(notebook).toContain('updated (role, model) Sourcer by Desk Lead — kept returning active listings')
  })

  it('an update that changes nothing is not logged', async () => {
    const res = await createFleetFromSpec(wsId, { name: 'Same', agents: [{ name: 'W', role: 'r' }] })
    if (!res.ok) throw new Error(res.error)
    const w = agentStore.listAgents(res.fleet.id).find((a) => a.name === 'W')!
    const upd = await updateAgentFromSpec(w, { role: 'r' }, { actor: 'Same Lead' })
    expect(upd.ok && upd.changed).toEqual([])
    expect(agentStore.listFleetChanges(res.fleet.id)).toHaveLength(0)
  })

  it('removing an agent logs its full configuration and archives its notebook', async () => {
    const res = await createFleetFromSpec(wsId, { name: 'Rm', agents: [{ name: 'Old', role: 'legacy duty', tools: ['web_search'] }] })
    if (!res.ok) throw new Error(res.error)
    const old = agentStore.listAgents(res.fleet.id).find((a) => a.name === 'Old')!
    writeWorkingMemory(old, '# Old\n- lesson worth keeping')
    const out = removeAgent(old, { actor: 'Rm Lead', reason: 'duty merged into Sourcer' })
    expect(out.notebook).toContain('lesson worth keeping')
    expect(out.archivedTo).toContain('removed')
    const [entry] = agentStore.listFleetChanges(res.fleet.id, { agent: 'Old' })
    expect(entry!.action).toBe('remove')
    expect(entry!.before).toMatchObject({ role: 'legacy duty', tools: ['web_search'] })
    expect(agentStore.getAgent(old.id)).toBeUndefined()
    expect(workingMemoryPath(old)).not.toBe(out.archivedTo)
  })

  it('logs a Fleet-screen edit as the user, diffing only the fields that changed', () => {
    const { fleetId, ebay } = fleetWithAgents()
    const before = agentStore.getAgent(ebay.id)!
    const snap = snapshotAgent(before)
    const after = agentStore.updateAgent(ebay.id, { role: 'sources parts on eBay', name: 'eBay', effort: 'max', permissionPreset: 'full' })
    logScreenUpdate(after, snap)
    const [entry] = agentStore.listFleetChanges(fleetId)
    expect(entry!.actor).toBe('user')
    expect(Object.keys(entry!.after!).sort()).toEqual(['effort', 'permissions', 'role'])
    expect(entry!.after!.effort).toBe('max')
  })
})
