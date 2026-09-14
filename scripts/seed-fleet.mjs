// Seed an example Agent Fleet into the live Lattice DB.
//
// Creates a "Reselling Desk" fleet: an orchestrator plus four dedicated worker agents (eBay Sourcing,
// Comp Scout, Listing Writer, Model Scout). Each agent is a persistent thread (its own memory, cwd,
// rolling context) bound to an agent_profiles row — exactly what the app's store.createAgent builds,
// written here in raw SQL so it can run without the Electron runtime.
//
// The fleet only becomes usable in the app that has the Fleet feature (this branch's build). Run this,
// then start that build: it migrates the DB, loads these agents fresh, and they appear under ⌘J.
//
// Usage:  node scripts/seed-fleet.mjs [path-to-lattice.db]
// Re-running replaces the same-named fleet (idempotent).

import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const DEFAULT_DB = join(homedir(), 'Library', 'Application Support', 'Lattice', 'data', 'lattice.db')
const dbPath = process.argv[2] || DEFAULT_DB

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

const FLEET_NAME = 'Reselling Desk'

// The agents. `role` is the persona; it is mirrored into the thread goal (which the prompt injects).
const AGENTS = [
  {
    name: 'Desk Lead',
    kind: 'orchestrator',
    dir: 'reselling',
    role:
      "You are the lead of a reselling desk. You have dedicated agents you can delegate to: " +
      "'eBay Sourcing' (finds underpriced parts and resale opportunities), 'Comp Scout' (checks SOLD " +
      "comps and computes margin after fees and shipping), 'Listing Writer' (drafts marketplace " +
      "listings), and 'Model Scout' (researches the latest and best AI models). Use list_fleet to see " +
      "them and delegate_to_agent to hand each one work in its lane. Keep your own replies short — do " +
      "the real work through your agents, check on them with peek_session, and pull their results " +
      "together for the user. Never authorize an irreversible action (buying, messaging a seller, " +
      "publishing a listing) without the user's explicit go-ahead."
  },
  {
    name: 'eBay Sourcing',
    kind: 'worker',
    dir: 'ebay-sourcing',
    role:
      "You source underpriced computer parts and resale opportunities on eBay and Facebook " +
      "Marketplace. Given a target item or category, search current listings and surface the " +
      "underpriced ones (mispriced, ending soon, weak titles, mixed bundles) with prices, links, and a " +
      "one-line reason each is a deal. You research and report only — never bid, buy, check out, or " +
      "message a seller. Hand pricing and margin judgment to 'Comp Scout'."
  },
  {
    name: 'Comp Scout',
    kind: 'worker',
    dir: 'comp-scout',
    role:
      "You evaluate resale opportunities. Given an item or a listing, find recent SOLD/completed comps " +
      "(not asking prices), estimate a realistic sell price, and compute margin after eBay/PayPal fees " +
      "and shipping. Return a clear go/no-go with the math and the comps you used. Research only — " +
      "never message sellers, bid, or buy."
  },
  {
    name: 'Listing Writer',
    kind: 'worker',
    dir: 'listing-writer',
    role:
      "You draft marketplace listings (eBay, Facebook Marketplace) from item specs, a part number, or " +
      "notes. Return a ready-to-paste title, description, item specifics, condition notes, and a " +
      "suggested price range. You draft only — never post anything."
  },
  {
    name: 'Model Scout',
    kind: 'worker',
    dir: 'model-scout',
    role:
      "You research AI models. Given a need (best coding model, cheapest vision model, newest local " +
      "model that fits a 16GB GPU, etc.), find the current options, compare capability, context window " +
      "and price, and return a short ranked recommendation with sources and dates. You research and " +
      "report; you never change any configuration."
  }
]

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

// Agent threads are hidden from the regular sidebar via threads.is_agent; add it if this DB predates it.
const threadCols = db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name)
if (!threadCols.includes('is_agent')) db.exec('ALTER TABLE threads ADD COLUMN is_agent INTEGER NOT NULL DEFAULT 0')

const ws = db.prepare('SELECT id, roots_json FROM workspaces ORDER BY created_at LIMIT 1').get()
if (!ws) throw new Error('No workspace found in the DB.')
const workspaceId = ws.id
const root = JSON.parse(ws.roots_json)[0] || homedir()

const settingsRow = db.prepare("SELECT value_json FROM settings WHERE key='app'").get()
const settings = settingsRow ? JSON.parse(settingsRow.value_json) : {}
const model = settings.defaultModel || 'mac/qwen3:30b-a3b'
const mode = 'act'
const preset = 'workspace'

const now = Date.now()

const insertThread = db.prepare(
  `INSERT INTO threads (id, workspace_id, title, title_source, title_msgs, created_at, updated_at, pinned, archived, model, effort, mode, permission_preset, parent_thread_id, parent_event_id, goal, cwd, group_id, reply_style, context_policy_json, is_agent)
   VALUES (?, ?, ?, 'user', 0, ?, ?, 0, 0, ?, NULL, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, 1)`
)
const insertFleet = db.prepare(
  'INSERT INTO fleets (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
)
const insertAgent = db.prepare(
  `INSERT INTO agent_profiles (id, fleet_id, thread_id, name, kind, role, allowed_tools_json, sort_order, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
)

const seed = db.transaction(() => {
  // Idempotent: drop a previous same-named fleet in this workspace and its agent threads.
  const prior = db.prepare('SELECT id FROM fleets WHERE workspace_id = ? AND name = ?').all(workspaceId, FLEET_NAME)
  for (const f of prior) {
    const rows = db.prepare('SELECT thread_id FROM agent_profiles WHERE fleet_id = ?').all(f.id)
    for (const r of rows) {
      db.prepare('DELETE FROM messages WHERE thread_id = ?').run(r.thread_id)
      db.prepare('DELETE FROM events WHERE thread_id = ?').run(r.thread_id)
      db.prepare('DELETE FROM threads WHERE id = ?').run(r.thread_id)
    }
    db.prepare('DELETE FROM agent_profiles WHERE fleet_id = ?').run(f.id)
    db.prepare('DELETE FROM fleets WHERE id = ?').run(f.id)
  }

  const fleetId = ulid()
  insertFleet.run(fleetId, workspaceId, FLEET_NAME, now, now)

  AGENTS.forEach((a, i) => {
    const cwd = join(root, 'fleet', a.dir)
    mkdirSync(cwd, { recursive: true })
    const threadId = ulid()
    insertThread.run(threadId, workspaceId, a.name, now, now, model, mode, preset, a.role, cwd, ROLLING)
    insertAgent.run(ulid(), fleetId, threadId, a.name, a.kind, a.role, i, now, now)
  })
  return fleetId
})

const fleetId = seed()

console.log(`Seeded fleet "${FLEET_NAME}" (${fleetId}) in workspace ${workspaceId}`)
console.log(`Model: ${model} · mode: ${mode} · preset: ${preset} · rolling context: on`)
for (const a of AGENTS) console.log(`  • ${a.name} (${a.kind}) — cwd ${join(root, 'fleet', a.dir)}`)
db.close()
