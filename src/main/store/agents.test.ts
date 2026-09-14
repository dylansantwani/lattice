import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// electron's `app` is unavailable under vitest; point the db at a throwaway dir.
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-agents-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from './eventStore'
import { getDb, closeDb, migrateAgentContextPolicies } from './db'
import * as agents from './agents'

let wsId: string

beforeEach(() => {
  getDb().exec(
    'DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM fleets; DELETE FROM agent_profiles'
  )
  agents.resetAgentCache()
  wsId = store.ensureDefaultWorkspace().id
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

const mkFleet = (name = 'Fleet'): string => agents.createFleet({ workspaceId: wsId, name }).id

describe('fleets', () => {
  it('creates and lists fleets scoped to a workspace', () => {
    mkFleet('Sourcing')
    mkFleet('Ops')
    const list = agents.listFleets(wsId)
    expect(list.map((f) => f.name).sort()).toEqual(['Ops', 'Sourcing'])
  })

  it('renames a fleet', () => {
    const id = mkFleet('Old')
    const next = agents.renameFleet(id, 'New')
    expect(next.name).toBe('New')
    expect(agents.getFleet(id)?.name).toBe('New')
  })

  it('finds a fleet by id, exact name (any case) or unique prefix, and explains misses', () => {
    const id = mkFleet('Reselling Desk')
    mkFleet('Research')
    expect((agents.findFleet(wsId, id) as { id: string }).id).toBe(id)
    expect((agents.findFleet(wsId, 'reselling desk') as { id: string }).id).toBe(id)
    expect((agents.findFleet(wsId, 'Resell') as { id: string }).id).toBe(id)
    expect(agents.findFleet(wsId, 'Res')).toHaveProperty('error')
    expect((agents.findFleet(wsId, 'nope') as { error: string }).error).toContain('Reselling Desk')
  })
})

describe('agent cache', () => {
  it('sees agents written by another database connection without a restart', () => {
    const fleetId = mkFleet('External')
    // Prime the cache on this connection.
    expect(agents.agentForThread('missing')).toBeUndefined()
    const thread = store.createThread({ workspaceId: wsId, title: 'Ext', model: 'm/x', isAgent: true })
    // Write the profile through a SECOND connection, the way scripts/fleet-seed.mjs does.
    const dbPath = (getDb() as unknown as { name: string }).name
    const other = new (require('better-sqlite3') as typeof import('better-sqlite3'))(dbPath)
    const now = Date.now()
    other
      .prepare(
        `INSERT INTO agent_profiles (id, fleet_id, thread_id, name, kind, role, allowed_tools_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'worker', NULL, NULL, 0, ?, ?)`
      )
      .run('EXT1', fleetId, thread.id, 'Ext', now, now)
    other.close()
    expect(agents.agentForThread(thread.id)?.name).toBe('Ext')
  })
})

describe('agents', () => {
  it('creates an orchestrator: a thread carrying the role as its goal, and a profile bound to it', () => {
    const fleetId = mkFleet()
    const { profile, thread } = agents.createAgent({
      fleetId,
      name: 'Conductor',
      kind: 'orchestrator',
      role: 'You run the fleet.',
      model: 'm/x'
    })
    expect(profile.kind).toBe('orchestrator')
    expect(profile.threadId).toBe(thread.id)
    // role is mirrored into the thread goal (which the prompt injects) and the title is the name.
    expect(thread.goal).toBe('You run the fleet.')
    expect(thread.title).toBe('Conductor')
    // the thread is flagged as an agent so it stays out of the regular sidebar
    expect(store.getThreadMeta(thread.id)?.isAgent).toBe(true)
    // cache reflects it immediately
    expect(agents.isOrchestratorThread(thread.id)).toBe(true)
    expect(agents.agentForThread(thread.id)?.id).toBe(profile.id)
  })

  it('creates a worker with a rolling context policy and a tool allowlist', () => {
    const fleetId = mkFleet()
    const { profile, thread } = agents.createAgent({
      fleetId,
      name: 'eBay',
      kind: 'worker',
      model: 'm/x',
      rolling: true,
      allowedTools: ['fs_read', 'shell']
    })
    const meta = store.getThreadMeta(thread.id)
    expect(meta?.contextPolicy?.mode).toBe('rolling')
    expect(agents.isOrchestratorThread(thread.id)).toBe(false)
    expect(agents.agentAllowlist(thread.id)).toEqual(['fs_read', 'shell'])
    expect(profile.allowedTools).toEqual(['fs_read', 'shell'])
  })

  it('gives each kind its own context policy: a tight rolling window for the orchestrator, fresh-per-task workers', () => {
    const fleetId = mkFleet()
    const lead = agents.createAgent({ fleetId, name: 'Lead', kind: 'orchestrator', model: 'm/x', rolling: true })
    const worker = agents.createAgent({ fleetId, name: 'W', kind: 'worker', model: 'm/x', rolling: true })
    expect(store.getThreadMeta(lead.thread.id)?.contextPolicy).toEqual({ mode: 'rolling', triggerTokens: 60_000, keepTokens: 20_000 })
    expect(store.getThreadMeta(worker.thread.id)?.contextPolicy).toEqual({ mode: 'rolling', triggerTokens: 80_000, keepTokens: 24_000, freshPerTask: true })
    // Changing a rolling agent's kind moves it to that kind's policy; a non-rolling one stays non-rolling.
    agents.updateAgent(worker.profile.id, { kind: 'orchestrator' })
    expect(store.getThreadMeta(worker.thread.id)?.contextPolicy).toEqual(agents.ORCHESTRATOR_CONTEXT_POLICY)
    const plain = agents.createAgent({ fleetId, name: 'P', kind: 'worker', model: 'm/x' })
    agents.updateAgent(plain.profile.id, { kind: 'orchestrator' })
    expect(store.getThreadMeta(plain.thread.id)?.contextPolicy).toBeUndefined()
  })

  it('migrates agents on the original 120k/40k policy to their kind\'s policy once, leaving custom ones alone', () => {
    const fleetId = mkFleet()
    const lead = agents.createAgent({ fleetId, name: 'Lead', kind: 'orchestrator', model: 'm/x', rolling: true })
    const worker = agents.createAgent({ fleetId, name: 'W', kind: 'worker', model: 'm/x', rolling: true })
    const custom = agents.createAgent({ fleetId, name: 'C', kind: 'worker', model: 'm/x', rolling: true })
    const db = getDb()
    const legacy = JSON.stringify({ mode: 'rolling', triggerTokens: 120_000, keepTokens: 40_000 })
    db.prepare('UPDATE threads SET context_policy_json = ? WHERE id IN (?, ?)').run(legacy, lead.thread.id, worker.thread.id)
    db.prepare('UPDATE threads SET context_policy_json = ? WHERE id = ?').run(JSON.stringify({ mode: 'rolling', triggerTokens: 200_000, keepTokens: 50_000 }), custom.thread.id)
    db.prepare("DELETE FROM meta WHERE key = 'agent_context_policy_version'").run()
    migrateAgentContextPolicies(db)
    const policy = (id: string) => JSON.parse((db.prepare('SELECT context_policy_json AS p FROM threads WHERE id = ?').get(id) as { p: string }).p)
    expect(policy(lead.thread.id)).toEqual({ mode: 'rolling', triggerTokens: 60_000, keepTokens: 20_000 })
    expect(policy(worker.thread.id)).toEqual({ mode: 'rolling', triggerTokens: 80_000, keepTokens: 24_000, freshPerTask: true })
    expect(policy(custom.thread.id)).toEqual({ mode: 'rolling', triggerTokens: 200_000, keepTokens: 50_000 })
    // Once only: a later hand-set legacy-looking policy is not rewritten.
    db.prepare('UPDATE threads SET context_policy_json = ? WHERE id = ?').run(legacy, lead.thread.id)
    migrateAgentContextPolicies(db)
    expect(policy(lead.thread.id)).toEqual({ mode: 'rolling', triggerTokens: 120_000, keepTokens: 40_000 })
  })

  it('lists agents in a fleet in sort order', () => {
    const fleetId = mkFleet()
    agents.createAgent({ fleetId, name: 'A', kind: 'orchestrator', model: 'm/x' })
    agents.createAgent({ fleetId, name: 'B', kind: 'worker', model: 'm/x' })
    agents.createAgent({ fleetId, name: 'C', kind: 'worker', model: 'm/x' })
    expect(agents.listAgents(fleetId).map((a) => a.name)).toEqual(['A', 'B', 'C'])
  })

  it('updates role, model, reasoning effort, and rolling context on the agent thread', () => {
    const fleetId = mkFleet()
    const { profile, thread } = agents.createAgent({
      fleetId,
      name: 'W',
      kind: 'worker',
      model: 'm/x',
      role: 'first',
      rolling: true
    })
    agents.updateAgent(profile.id, { role: 'second', model: 'm/y', effort: 'xhigh', rolling: false })
    const meta = store.getThreadMeta(thread.id)
    expect(meta?.goal).toBe('second')
    expect(meta?.model).toBe('m/y')
    expect(meta?.effort).toBe('xhigh')
    expect(meta?.contextPolicy).toBeUndefined()
  })

  it('clears an allowlist with null and reflects kind changes in the cache', () => {
    const fleetId = mkFleet()
    const { profile, thread } = agents.createAgent({
      fleetId,
      name: 'W',
      kind: 'worker',
      model: 'm/x',
      allowedTools: ['fs_read']
    })
    agents.updateAgent(profile.id, { allowedTools: null, kind: 'orchestrator' })
    expect(agents.agentAllowlist(thread.id)).toBeUndefined()
    expect(agents.isOrchestratorThread(thread.id)).toBe(true)
  })

  it('deleting an agent deletes its thread', () => {
    const fleetId = mkFleet()
    const { profile, thread } = agents.createAgent({ fleetId, name: 'W', kind: 'worker', model: 'm/x' })
    agents.deleteAgent(profile.id)
    expect(store.getThreadMeta(thread.id)).toBeNull()
    expect(agents.agentForThread(thread.id)).toBeUndefined()
    expect(agents.getAgent(profile.id)).toBeUndefined()
  })

  it('deleting a fleet deletes its agents and their threads', () => {
    const fleetId = mkFleet()
    const a = agents.createAgent({ fleetId, name: 'A', kind: 'orchestrator', model: 'm/x' })
    const b = agents.createAgent({ fleetId, name: 'B', kind: 'worker', model: 'm/x' })
    agents.deleteFleet(fleetId)
    expect(agents.listFleets(wsId)).toHaveLength(0)
    expect(store.getThreadMeta(a.thread.id)).toBeNull()
    expect(store.getThreadMeta(b.thread.id)).toBeNull()
  })
})
