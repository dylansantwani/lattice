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
