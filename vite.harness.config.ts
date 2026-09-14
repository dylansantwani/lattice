/**
 * Transcript lab — a standalone Vite dev page that mounts the real transcript components on real
 * threads read straight from the local Lattice database, outside Electron. Used to iterate on the
 * conversation UI against genuine agentic runs (thousands of tool calls, subagents, errors, steers)
 * with hot reload, instead of guessing from synthetic fixtures.
 *
 *   pnpm harness            → http://localhost:5199/harness/
 *   LATTICE_DB=/path/to/lattice.db pnpm harness   (defaults to the app's userData DB)
 *
 * The DB is opened read-only; nothing here writes.
 */
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { summarizeTurn } from './src/shared/view/turnSummary'
import { summarizeTaskUsage } from './src/shared/taskUsage'

const defaultDb = join(homedir(), 'Library', 'Application Support', 'Lattice', 'data', 'lattice.db')
const dbPath = process.env.LATTICE_DB ?? defaultDb

function harnessApi(): Plugin {
  let db: Database.Database | null = null
  const open = (): Database.Database => {
    if (db) return db
    if (!existsSync(dbPath)) throw new Error(`No Lattice DB at ${dbPath} (set LATTICE_DB)`)
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    return db
  }
  const parse = (s: unknown): unknown => (typeof s === 'string' && s ? JSON.parse(s) : undefined)
  return {
    name: 'lattice:harness-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        if (!url.pathname.startsWith('/api/')) return next()
        try {
          const d = open()
          if (url.pathname === '/api/threads') {
            const rows = d
              .prepare(
                `SELECT t.id, t.title, t.model, t.updated_at AS updatedAt,
                        (SELECT count(*) FROM messages m WHERE m.thread_id = t.id) AS messages,
                        (SELECT count(*) FROM events e WHERE e.thread_id = t.id AND e.body_json LIKE '%"type":"tool.result"%') AS toolCalls,
                        (SELECT count(*) FROM events e WHERE e.thread_id = t.id AND e.agent IS NOT NULL) AS agentEvents,
                        (SELECT count(*) FROM events e WHERE e.thread_id = t.id AND e.body_json LIKE '%"type":"error"%') AS errors
                 FROM threads t WHERE t.archived = 0 ORDER BY t.updated_at DESC LIMIT 200`
              )
              .all()
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(rows))
            return
          }
          // The remote client's view of a thread (what the phone fetches), for size checks and for
          // exporting a real fixture into the iOS test target.
          const v = url.pathname.match(/^\/api\/threadView\/([A-Za-z0-9]+)$/)
          if (v) {
            const id = v[1]!
            const limit = Number(url.searchParams.get('messages') ?? 40)
            const meta = d.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Record<string, unknown> | undefined
            if (!meta) {
              res.statusCode = 404
              res.end('no such thread')
              return
            }
            const rows = (d.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(id, limit + 1) as Record<string, unknown>[])
            const hasMore = rows.length > limit
            const messages = rows.slice(0, limit).reverse().map((r) => ({
              id: r.id, threadId: r.thread_id, runId: r.run_id ?? undefined, role: r.role, createdAt: r.created_at, text: r.text,
              model: r.model ?? undefined, effort: r.effort ?? undefined, status: r.status ?? undefined,
              queued: r.queued ? true : undefined, compacted: r.compacted ? true : undefined,
              telemetry: parse(r.telemetry_json), attachments: parse(r.attachments_json), origin: parse(r.origin_json)
            }))
            const turns: Record<string, unknown> = {}
            const seen = new Set<string>()
            for (const m of messages) {
              if (m.role !== 'assistant' || !m.runId || seen.has(m.runId as string)) continue
              seen.add(m.runId as string)
              const evs = (d.prepare('SELECT * FROM events WHERE run_id = ? AND thread_id = ? ORDER BY ts, rowid').all(m.runId, id) as Record<string, unknown>[]).map((r) => ({
                id: r.id, runId: r.run_id, threadId: r.thread_id, seq: r.seq, ts: r.ts, agent: r.agent ?? undefined, body: parse(r.body_json)
              }))
              turns[m.runId as string] = summarizeTurn(m.runId as never, evs as never, { model: m.model as string | undefined })
            }
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ meta: { id: meta.id, title: meta.title, model: meta.model, running: false }, messages, turns, events: [], hasMore }))
            return
          }
          // Fleet lab: the Agent Fleet screen's IPC surface, read straight from the DB (see harness/fleet.tsx).
          if (url.pathname === '/api/models') {
            const rows = d.prepare('SELECT models_json FROM model_cache').all() as { models_json: string }[]
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(rows.flatMap((r) => JSON.parse(r.models_json))))
            return
          }
          if (url.pathname === '/api/fleets') {
            const rows = d.prepare('SELECT id, workspace_id AS workspaceId, name, created_at AS createdAt, updated_at AS updatedAt FROM fleets ORDER BY updated_at DESC').all()
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(rows))
            return
          }
          const fa = url.pathname.match(/^\/api\/fleet\/([A-Za-z0-9]+)\/(agents|activity|changes)$/)
          if (fa) {
            const fleetId = fa[1]!
            const profiles = d.prepare('SELECT * FROM agent_profiles WHERE fleet_id = ? ORDER BY sort_order, created_at').all(fleetId) as Record<string, unknown>[]
            const names = new Map(profiles.map((p) => [p.thread_id as string, p.name as string]))
            let out: unknown
            if (fa[2] === 'agents') {
              const now = Date.now()
              const ago = (ts: number): string => {
                const m = Math.round((now - ts) / 60000)
                return m < 1 ? 'idle now' : m < 60 ? `idle ${m}m` : m < 1440 ? `idle ${Math.round(m / 60)}h` : `idle ${Math.round(m / 1440)}d`
              }
              out = profiles.map((p) => {
                const t = d.prepare('SELECT * FROM threads WHERE id = ?').get(p.thread_id) as Record<string, unknown>
                const last = d.prepare("SELECT text FROM messages WHERE thread_id = ? AND role = 'assistant' AND text != '' ORDER BY created_at DESC LIMIT 1").get(p.thread_id) as { text?: string } | undefined
                const lastErr = d.prepare("SELECT json_extract(body_json,'$.type') AS type FROM events WHERE thread_id = ? AND json_extract(body_json,'$.type') IN ('run.completed','error') ORDER BY ts DESC LIMIT 1").get(p.thread_id) as { type?: string } | undefined
                const allow = p.allowed_tools_json ? JSON.parse(p.allowed_tools_json as string) : undefined
                // Same task window as ipc.ts currentTaskUsage: a worker's task starts at the delegation
                // that woke it, an orchestrator's at the person's latest message.
                const since = ((p.kind === 'orchestrator'
                  ? (d.prepare("SELECT MAX(created_at) AS at FROM messages WHERE thread_id = ? AND role = 'user' AND origin_json IS NULL").get(p.thread_id) as { at: number | null }).at
                  : null) ??
                  (d.prepare("SELECT MAX(created_at) AS at FROM session_messages WHERE to_thread_id = ? AND delivery = 'woken'").get(p.thread_id) as { at: number | null }).at) as number | null
                const usageRows = since
                  ? (d.prepare("SELECT body_json FROM events WHERE thread_id = ? AND ts >= ? AND json_extract(body_json, '$.type') = 'usage'").all(p.thread_id, since) as { body_json: string }[]).map((r) => ({ usage: JSON.parse(r.body_json).usage ?? {} }))
                  : []
                const models = (d.prepare('SELECT models_json FROM model_cache').all() as { models_json: string }[]).flatMap((r) => JSON.parse(r.models_json))
                return {
                  id: p.id, fleetId: p.fleet_id, threadId: p.thread_id, name: p.name, kind: p.kind, role: p.role ?? undefined,
                  allowedTools: allow?.length ? allow : undefined, sortOrder: p.sort_order, createdAt: p.created_at, updatedAt: p.updated_at,
                  title: t.title, model: t.model, effort: t.effort ?? undefined, mode: t.mode, permissionPreset: t.permission_preset,
                  cwd: t.cwd ?? undefined, goal: t.goal ?? undefined, rolling: !!t.context_policy_json,
                  running: false, unread: 0, status: lastErr?.type === 'error' ? 'error' : 'idle',
                  statusText: lastErr?.type === 'error' ? 'error' : ago(t.updated_at as number),
                  preview: last?.text ? last.text.replace(/\s+/g, ' ').slice(0, 200) : undefined,
                  lastActivityAt: t.updated_at,
                  ...(since ? { taskUsage: summarizeTaskUsage(since, usageRows, t.model as string, models) } : {})
                }
              })
            } else if (fa[2] === 'activity') {
              const ids = profiles.map((p) => p.thread_id as string)
              const ph = ids.map(() => '?').join(',')
              out = ids.length
                ? (d.prepare(`SELECT * FROM session_messages WHERE to_thread_id IN (${ph}) OR from_thread_id IN (${ph}) ORDER BY created_at DESC LIMIT 40`).all(...ids, ...ids) as Record<string, unknown>[]).map((m) => ({
                    id: m.id, fromThreadId: m.from_thread_id, toThreadId: m.to_thread_id,
                    fromName: names.get(m.from_thread_id as string) ?? m.from_title, toName: names.get(m.to_thread_id as string) ?? 'session',
                    body: String(m.body).slice(0, 600), createdAt: m.created_at, delivery: m.delivery
                  }))
                : []
            } else {
              out = (d.prepare('SELECT * FROM fleet_changes WHERE fleet_id = ? ORDER BY created_at DESC LIMIT 30').all(fleetId) as Record<string, unknown>[]).map((r) => ({
                id: r.id, fleetId: r.fleet_id, agentId: r.agent_id ?? undefined, agentName: r.agent_name, action: r.action, actor: r.actor,
                reason: r.reason ?? undefined, before: parse(r.before_json), after: parse(r.after_json), createdAt: r.created_at
              }))
            }
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(out))
            return
          }
          const m = url.pathname.match(/^\/api\/thread\/([A-Za-z0-9]+)$/)
          if (m) {
            const id = m[1]!
            const meta = d.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Record<string, unknown> | undefined
            if (!meta) {
              res.statusCode = 404
              res.end('no such thread')
              return
            }
            const messages = (d.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, rowid').all(id) as Record<string, unknown>[]).map(
              (r) => ({
                id: r.id,
                threadId: r.thread_id,
                runId: r.run_id ?? undefined,
                role: r.role,
                createdAt: r.created_at,
                text: r.text,
                model: r.model ?? undefined,
                effort: r.effort ?? undefined,
                status: r.status ?? undefined,
                queued: r.queued ? true : undefined,
                compacted: r.compacted ? true : undefined,
                telemetry: parse(r.telemetry_json),
                attachments: parse(r.attachments_json),
                origin: parse(r.origin_json)
              })
            )
            const events = (d.prepare('SELECT id, run_id, thread_id, seq, ts, agent, body_json FROM events WHERE thread_id = ? ORDER BY ts, seq').all(id) as Record<string, unknown>[]).map(
              (r) => ({
                id: r.id,
                runId: r.run_id,
                threadId: r.thread_id,
                seq: r.seq,
                ts: r.ts,
                agent: r.agent ?? undefined,
                body: parse(r.body_json)
              })
            )
            const thread = {
              id: meta.id,
              title: meta.title,
              model: meta.model,
              effort: meta.effort ?? undefined,
              mode: meta.mode,
              createdAt: meta.created_at,
              updatedAt: meta.updated_at,
              running: false
            }
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ thread, messages, events }))
            return
          }
          next()
        } catch (err) {
          res.statusCode = 500
          res.end(String((err as Error).message ?? err))
        }
      })
    }
  }
}

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react(), harnessApi()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@': resolve('src/renderer/src')
    }
  },
  server: { port: 5199, strictPort: true, open: false },
  appType: 'mpa'
})
