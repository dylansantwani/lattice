// Add one worker agent — "eBay Deal Sourcer" — to the existing "Reselling Desk" fleet, encoding the
// user's established sourcing criteria (from ~/.claude/agents/deal-scout.md: sold comps, realistic
// median, margin after fees/shipping, GO/MAYBE/PASS, research-only). Additive and idempotent by name;
// does NOT touch the rest of the fleet. Run: node scripts/add-ebay-sourcer.mjs
//
// The running app picks the new agent up in the Fleet roster immediately (it reads the DB); its own
// full fleet-awareness (the # Fleet prompt + ask_user removal) engages after the agent cache next
// refreshes — a restart, or any in-app agent edit.

import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const dbPath = process.argv[2] || join(homedir(), 'Library', 'Application Support', 'Lattice', 'data', 'lattice.db')

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function ulid() {
  let ts = Date.now()
  const time = Array(10)
  for (let i = 9; i >= 0; i--) { time[i] = B32[ts % 32]; ts = Math.floor(ts / 32) }
  const rand = randomBytes(16)
  let out = time.join('')
  for (let i = 0; i < 16; i++) out += B32[rand[i] % 32]
  return out.slice(0, 26)
}

const FLEET_NAME = 'Reselling Desk'
const AGENT_NAME = 'eBay Deal Sourcer'
const ROLE =
  "You source underpriced computer parts on eBay and apply the user's established deal criteria before " +
  "surfacing anything. Focus on the categories the user flips: RAM kits (DDR3/DDR4/DDR5), GPUs, CPUs, and " +
  "laptop/parts lots. For each candidate: establish the SELL side from recent SOLD/completed comps (not " +
  "active asks) and take a realistic median, ignoring outliers; establish the BUY side from the listing's " +
  "price or Best-Offer range; then subtract realistic costs — eBay + payment fees (~13%), shipping, and any " +
  "refurb — and be conservative, flagging thin comps or ambiguous part numbers. Surface only GO or MAYBE " +
  "items with the math shown; drop PASSes. Prefer BIN + Best Offer, ending-soon auctions, weak titles/photos, " +
  "and mixed bundles where one part is underpriced. You research and report ONLY — never bid, buy, check out, " +
  "or message a seller. Report each pick as: verdict (GO/MAYBE) + one line why; math (sell median − buy − " +
  "fees − shipping = est. margin, $ and %); 2–5 sold comps with links; risks. Hand every go/no-go to the " +
  "orchestrator, which confirms with the user before any purchase."

const ROLLING = JSON.stringify({ mode: 'rolling', triggerTokens: 120000, keepTokens: 40000 })

const db = new Database(dbPath)
db.pragma('busy_timeout = 5000')

const fleet = db.prepare('SELECT id, workspace_id FROM fleets WHERE name = ? ORDER BY created_at LIMIT 1').get(FLEET_NAME)
if (!fleet) throw new Error(`Fleet "${FLEET_NAME}" not found — run scripts/seed-fleet.mjs first.`)

const existing = db.prepare('SELECT id FROM agent_profiles WHERE fleet_id = ? AND name = ?').get(fleet.id, AGENT_NAME)
if (existing) {
  console.log(`"${AGENT_NAME}" already exists in "${FLEET_NAME}" — nothing to do.`)
  db.close()
  process.exit(0)
}

// Match the other workers' model, so it fits the fleet; the user can change it with the model picker.
const sibling = db.prepare(
  "SELECT t.model FROM agent_profiles ap JOIN threads t ON t.id = ap.thread_id WHERE ap.fleet_id = ? AND ap.kind = 'worker' LIMIT 1"
).get(fleet.id)
const settingsRow = db.prepare("SELECT value_json FROM settings WHERE key='app'").get()
const model = sibling?.model || (settingsRow ? JSON.parse(settingsRow.value_json).defaultModel : null) || 'mac/qwen3:30b-a3b'

const root = (() => {
  const ws = db.prepare('SELECT roots_json FROM workspaces WHERE id = ?').get(fleet.workspace_id)
  try { return JSON.parse(ws.roots_json)[0] || homedir() } catch { return homedir() }
})()
const cwd = join(root, 'fleet', 'ebay-deal-sourcer')
mkdirSync(cwd, { recursive: true })

const nextSort = (db.prepare('SELECT MAX(sort_order) AS m FROM agent_profiles WHERE fleet_id = ?').get(fleet.id)?.m ?? -1) + 1
const now = Date.now()
const threadId = ulid()
const profileId = ulid()

const tx = db.transaction(() => {
  db.prepare(
    `INSERT INTO threads (id, workspace_id, title, title_source, title_msgs, created_at, updated_at, pinned, archived, model, effort, mode, permission_preset, parent_thread_id, parent_event_id, goal, cwd, group_id, reply_style, context_policy_json, is_agent)
     VALUES (?, ?, ?, 'user', 0, ?, ?, 0, 0, ?, NULL, 'act', 'workspace', NULL, NULL, ?, ?, NULL, NULL, ?, 1)`
  ).run(threadId, fleet.workspace_id, AGENT_NAME, now, now, model, ROLE, cwd, ROLLING)
  db.prepare(
    `INSERT INTO agent_profiles (id, fleet_id, thread_id, name, kind, role, allowed_tools_json, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'worker', ?, NULL, ?, ?, ?)`
  ).run(profileId, fleet.id, threadId, AGENT_NAME, ROLE, nextSort, now, now)
})
tx()

console.log(`Added "${AGENT_NAME}" to "${FLEET_NAME}"`)
console.log(`  model: ${model} · cwd: ${cwd} · rolling: on`)
db.close()
