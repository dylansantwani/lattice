#!/usr/bin/env node
// Seed (or update) an Agent Fleet in the live Lattice DB from a JSON spec — the same shape the
// in-app `create_fleet` tool takes:
//
//   { "name": "3D Print Desk",
//     "orchestrator": { "name": "Print Desk Lead", "role": "...", "model": "..." },   // optional
//     "agents": [ { "name": "Product Sourcer", "role": "...", "model": "...", "cwd": "~/fleet/x",
//                   "tools": ["web_search"], "permissions": "full", "mode": "act", "rolling": true } ] }
//
// Every field but `name` has the same defaults as the tool: the app's default model, `full`
// permissions (an unattended agent must not park on approval cards), `act`, rolling context on, and
// `<workspace root>/fleet/<agent-slug>` as the working directory. Ready-made specs live in fleets/.
//
// UPSERT by name: an existing fleet keeps its agents' threads and memory — matching agents (by name)
// get their role/model/cwd/permissions/mode/rolling/tools updated, missing ones are added, extra ones
// are left alone. `--replace` instead deletes the same-named fleet (agents, threads, history) first.
// The running app notices the change at once (its agent cache tracks SQLite's data_version), so the
// fleet appears under ⌘J with no restart.
//
// Usage:  node scripts/fleet-seed.mjs fleets/3d-print-desk.json [--db <path>] [--workspace <id|name>] [--replace] [--dry-run]

import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const has = (name) => {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}
const dbPath = flag('--db') || join(homedir(), 'Library', 'Application Support', 'Lattice', 'data', 'lattice.db')
const workspaceArg = flag('--workspace')
const replace = has('--replace')
const dryRun = has('--dry-run')
const specPath = args[0]
if (!specPath) {
  console.error('Usage: node scripts/fleet-seed.mjs <spec.json> [--db <path>] [--workspace <id|name>] [--replace] [--dry-run]')
  process.exit(2)
}

// --- Crockford base32 ULID (26 chars, time-ordered) so seeded ids look like the app's own. ---
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function ulid() {
  let ts = Date.now()
  const time = Array(10)
  for (let i = 9; i >= 0; i--) {
    time[i] = B32[ts % 32]
    ts = Math.floor(ts / 32)
  }
  const rand = randomBytes(16)
  let out = time.join('')
  for (let i = 0; i < 16; i++) out += B32[rand[i] % 32]
  return out.slice(0, 26)
}

const ROLLING = JSON.stringify({ mode: 'rolling', triggerTokens: 120000, keepTokens: 40000 })
const PRESETS = ['workspace', 'manual', 'full']
const MODES = ['act', 'plan', 'review']
const DEFAULT_ORCHESTRATOR_ROLE =
  'You are the orchestrator of a fleet of dedicated agents. Use list_fleet to see your agents and ' +
  'delegate_to_agent to hand each one work in its domain. Keep your own replies short; do the real ' +
  'work through your agents, check on them with peek_session, and report back to the user. Never ' +
  'take an irreversible action (purchase, send, publish) without the user’s go-ahead.'

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
const expandHome = (p) => p.replace(/^~(?=$|\/)/, homedir())

// --- spec ---
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
if (!spec.name || typeof spec.name !== 'string') throw new Error('spec.name is required')
const orchestrator = { ...(spec.orchestrator ?? {}), kind: 'orchestrator' }
orchestrator.name = (orchestrator.name || `${spec.name} Lead`).trim()
orchestrator.role = orchestrator.role || DEFAULT_ORCHESTRATOR_ROLE
const agentSpecs = [orchestrator, ...(spec.agents ?? []).map((a) => ({ ...a, kind: a.kind ?? 'worker' }))]
for (const a of agentSpecs) {
  if (!a.name || !a.name.trim()) throw new Error('every agent needs a name')
  if (a.permissions && !PRESETS.includes(a.permissions)) throw new Error(`bad permissions for ${a.name}: ${a.permissions}`)
  if (a.mode && !MODES.includes(a.mode)) throw new Error(`bad mode for ${a.name}: ${a.mode}`)
}
const names = agentSpecs.map((a) => a.name.trim().toLowerCase())
if (new Set(names).size !== names.length) throw new Error('agent names must be unique within a fleet')
if (agentSpecs.filter((a) => a.kind === 'orchestrator').length !== 1) throw new Error('a fleet has exactly one orchestrator')

// --- db ---
const db = new Database(dbPath)
db.pragma('busy_timeout = 5000')

// Make sure the fleet tables exist even against an older DB (the app creates them on migrate).
db.exec(`
CREATE TABLE IF NOT EXISTS fleets (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fleets_ws ON fleets(workspace_id, created_at);
CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY, fleet_id TEXT NOT NULL, thread_id TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'worker', role TEXT, allowed_tools_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_fleet ON agent_profiles(fleet_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_thread ON agent_profiles(thread_id);
`)
const threadCols = db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name)
if (!threadCols.includes('is_agent')) db.exec('ALTER TABLE threads ADD COLUMN is_agent INTEGER NOT NULL DEFAULT 0')

const workspaces = db.prepare('SELECT id, name, roots_json FROM workspaces ORDER BY created_at').all()
if (!workspaces.length) throw new Error('No workspace found in the DB.')
const ws = workspaceArg
  ? workspaces.find((w) => w.id === workspaceArg || w.name.toLowerCase() === workspaceArg.toLowerCase())
  : workspaces[0]
if (!ws) throw new Error(`Workspace not found: ${workspaceArg}`)
const roots = JSON.parse(ws.roots_json)
const root = roots[0] || homedir()

const settingsRow = db.prepare("SELECT value_json FROM settings WHERE key='app'").get()
const settings = settingsRow ? JSON.parse(settingsRow.value_json) : {}
// Fleet agents never fall back to a local model; DeepSeek V4 Flash is the default.
const defaultModel = settings.defaultModel || 'deepseek/deepseek-v4-flash'

const insideRoots = (p) => roots.some((r) => p === resolve(r) || p.startsWith(resolve(r) + '/'))
function resolveCwd(a) {
  if (a.cwd && a.cwd.trim()) {
    const cwd = resolve(expandHome(a.cwd.trim()))
    if (!insideRoots(cwd)) throw new Error(`cwd for ${a.name} (${cwd}) is outside the workspace roots ${roots.join(', ')}`)
    return cwd
  }
  return join(root, 'fleet', slug(a.name))
}
const settingsOf = (a) => ({
  model: a.model || defaultModel,
  mode: a.mode || 'act',
  preset: a.permissions || 'full',
  rolling: a.rolling === undefined ? true : !!a.rolling,
  cwd: resolveCwd(a),
  role: (a.role || '').trim() || null,
  tools: Array.isArray(a.tools) && a.tools.length ? JSON.stringify(a.tools) : null
})

const now = Date.now()
const insertThread = db.prepare(
  `INSERT INTO threads (id, workspace_id, title, title_source, title_msgs, created_at, updated_at, pinned, archived, model, effort, mode, permission_preset, parent_thread_id, parent_event_id, goal, cwd, group_id, reply_style, context_policy_json, is_agent)
   VALUES (?, ?, ?, 'user', 0, ?, ?, 0, 0, ?, NULL, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, 1)`
)
const updateThread = db.prepare(
  'UPDATE threads SET title = ?, updated_at = ?, model = ?, mode = ?, permission_preset = ?, goal = ?, cwd = ?, context_policy_json = ?, is_agent = 1 WHERE id = ?'
)
const insertFleet = db.prepare('INSERT INTO fleets (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
const insertAgent = db.prepare(
  `INSERT INTO agent_profiles (id, fleet_id, thread_id, name, kind, role, allowed_tools_json, sort_order, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
const updateAgent = db.prepare('UPDATE agent_profiles SET role = ?, allowed_tools_json = ?, sort_order = ?, updated_at = ? WHERE id = ?')

const report = []
const seed = db.transaction(() => {
  let fleet = db.prepare('SELECT id FROM fleets WHERE workspace_id = ? AND lower(name) = lower(?)').get(ws.id, spec.name)
  if (fleet && replace) {
    const rows = db.prepare('SELECT thread_id FROM agent_profiles WHERE fleet_id = ?').all(fleet.id)
    for (const r of rows) {
      for (const t of ['messages', 'events', 'file_changes', 'thread_tools', 'memory_distill_marks']) {
        try { db.prepare(`DELETE FROM ${t} WHERE thread_id = ?`).run(r.thread_id) } catch { /* table may not exist */ }
      }
      db.prepare('DELETE FROM threads WHERE id = ?').run(r.thread_id)
    }
    db.prepare('DELETE FROM agent_profiles WHERE fleet_id = ?').run(fleet.id)
    db.prepare('DELETE FROM fleets WHERE id = ?').run(fleet.id)
    report.push(`replaced existing fleet "${spec.name}" (${rows.length} agents removed)`)
    fleet = null
  }
  if (!fleet) {
    fleet = { id: ulid() }
    insertFleet.run(fleet.id, ws.id, spec.name, now, now)
    report.push(`created fleet "${spec.name}" (${fleet.id})`)
  } else {
    report.push(`updating fleet "${spec.name}" (${fleet.id})`)
  }
  const existing = db.prepare('SELECT * FROM agent_profiles WHERE fleet_id = ?').all(fleet.id)
  const existingOrch = existing.find((a) => a.kind === 'orchestrator')

  agentSpecs.forEach((a, i) => {
    const s = settingsOf(a)
    mkdirSync(s.cwd, { recursive: true })
    // Match by name; an orchestrator also matches the existing orchestrator (so renaming it works).
    let match = existing.find((e) => e.name.toLowerCase() === a.name.trim().toLowerCase())
    if (!match && a.kind === 'orchestrator' && existingOrch) match = existingOrch
    if (match) {
      // A model the user picked in the app wins over the default; the spec only overrides when it names one.
      const current = db.prepare('SELECT model FROM threads WHERE id = ?').get(match.thread_id)
      const model = a.model ? s.model : current?.model || s.model
      updateThread.run(a.name.trim(), now, model, s.mode, s.preset, s.role, s.cwd, s.rolling ? ROLLING : null, match.thread_id)
      db.prepare('UPDATE agent_profiles SET name = ? WHERE id = ?').run(a.name.trim(), match.id)
      updateAgent.run(s.role, s.tools, i, now, match.id)
      report.push(`  ~ ${a.name} (${a.kind}) updated · ${model} · ${s.preset} · ${s.cwd}`)
    } else {
      const threadId = ulid()
      insertThread.run(threadId, ws.id, a.name.trim(), now, now, s.model, s.mode, s.preset, s.role, s.cwd, s.rolling ? ROLLING : null)
      insertAgent.run(ulid(), fleet.id, threadId, a.name.trim(), a.kind, s.role, s.tools, i, now, now)
      report.push(`  + ${a.name} (${a.kind}) · ${s.model} · ${s.preset} · ${s.cwd}`)
    }
  })
  db.prepare('UPDATE fleets SET updated_at = ? WHERE id = ?').run(now, fleet.id)
  return fleet.id
})

if (dryRun) {
  console.log(`[dry run] would seed "${spec.name}" into workspace ${ws.name} (${ws.id}); default model ${defaultModel}`)
  for (const a of agentSpecs) {
    const s = settingsOf(a)
    console.log(`  ${a.name} (${a.kind}) · ${s.model} · ${s.preset} · ${s.cwd}${s.tools ? ` · tools ${s.tools}` : ''}`)
  }
  db.close()
  process.exit(0)
}

const fleetId = seed()
for (const line of report) console.log(line)
console.log(`Done. Open the Fleet screen (⌘J) — the app picks the change up without a restart. Fleet id: ${fleetId}`)
db.close()
