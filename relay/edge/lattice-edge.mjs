#!/usr/bin/env node
/**
 * lattice-edge — the always-on front door for the iOS app.
 *
 * `lattice.pulse-core.com` is a Cloudflare tunnel whose ingress is http://127.0.0.1:8973. That
 * connector now runs in an always-on Proxmox container instead of on the Mac, and this process is
 * what listens there. It holds two upstreams:
 *
 *   mac    127.0.0.1:18973 — a reverse SSH forward the Mac's relay agent opens to its own bridge
 *          (Lattice.app, 127.0.0.1:8973). It only exists while the Mac is awake, its app is healthy,
 *          and the agent has finished syncing, so "the port answers /health" means "use the Mac".
 *   cloud  127.0.0.1:8975 — the headless Lattice runtime in this container, holding a replica of the
 *          Mac's threads (relay/sync).
 *
 * Every request goes to the Mac when it is healthy and to the cloud otherwise. The phone never
 * changes its URL and never re-pairs: device tokens are replicated, so either upstream accepts them.
 *
 * Switching is deliberately asymmetric: the Mac is preferred the moment it is healthy (the agent only
 * opens the forward after a sync, so it is ready by construction) and abandoned only after FAIL_AFTER
 * consecutive failed probes, or at once when a request finds the forward refusing connections. On a
 * switch every open WebSocket is closed so clients reconnect to the new upstream and reload, instead
 * of holding an event stream from a runtime that is no longer the one answering their RPCs.
 *
 * Zero dependencies (node:http, node:net). Config via env:
 *   EDGE_LISTEN=127.0.0.1:8973  MAC_UPSTREAM=127.0.0.1:18973  CLOUD_UPSTREAM=127.0.0.1:8975
 *   EDGE_HEALTH_MS=2000  EDGE_FAIL_AFTER=2  EDGE_ON_CLOUD="<shell command run when switching to cloud>"
 *   EDGE_STATUS_FILE=/run/lattice-edge/status.json
 */
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function hostPort(value, fallback) {
  const [host, port] = String(value || fallback).split(':')
  return { host: host || '127.0.0.1', port: Number(port) }
}

/** Read-only RPCs that are safe to replay on the other upstream if the first one never answered. */
const SAFE_RPC = /^\/rpc\/(list|get|search|read|find|status|health|models|budget)/i

export function createEdge(options = {}) {
  const cfg = {
    listen: hostPort(options.listen ?? process.env.EDGE_LISTEN, '127.0.0.1:8973'),
    mac: hostPort(options.mac ?? process.env.MAC_UPSTREAM, '127.0.0.1:18973'),
    cloud: hostPort(options.cloud ?? process.env.CLOUD_UPSTREAM, '127.0.0.1:8975'),
    healthMs: Number(options.healthMs ?? process.env.EDGE_HEALTH_MS ?? 2000),
    failAfter: Number(options.failAfter ?? process.env.EDGE_FAIL_AFTER ?? 2),
    probeTimeoutMs: Number(options.probeTimeoutMs ?? 1500),
    onCloud: options.onCloud ?? process.env.EDGE_ON_CLOUD ?? '',
    statusFile: options.statusFile ?? process.env.EDGE_STATUS_FILE ?? '',
    log: options.log ?? ((msg) => console.log(`[lattice-edge] ${new Date().toISOString()} ${msg}`))
  }

  const state = {
    mode: 'cloud',
    since: Date.now(),
    switches: 0,
    mac: { healthy: false, fails: 0, lastOkAt: 0, lastError: '' },
    cloud: { healthy: false, lastOkAt: 0, lastError: '' }
  }
  /** @type {Set<{client: net.Socket, upstream: net.Socket, mode: string}>} */
  const tunnels = new Set()
  let timer = null
  let server = null

  function writeStatus() {
    if (!cfg.statusFile) return
    try {
      mkdirSync(dirname(cfg.statusFile), { recursive: true })
      writeFileSync(cfg.statusFile, JSON.stringify(publicStatus(), null, 2))
    } catch {
      /* status is a convenience */
    }
  }

  function publicStatus() {
    return {
      ok: true,
      backend: state.mode,
      since: state.since,
      switches: state.switches,
      mac: { healthy: state.mac.healthy, lastOkAt: state.mac.lastOkAt },
      cloud: { healthy: state.cloud.healthy, lastOkAt: state.cloud.lastOkAt },
      streams: tunnels.size
    }
  }

  function setMode(mode, reason) {
    if (state.mode === mode) return
    const from = state.mode
    state.mode = mode
    state.since = Date.now()
    state.switches++
    cfg.log(`backend ${from} -> ${mode} (${reason})`)
    // Close every event stream that belongs to the old backend; clients reconnect and resync.
    for (const t of [...tunnels]) {
      if (t.mode !== mode) {
        t.client.destroy()
        t.upstream.destroy()
        tunnels.delete(t)
      }
    }
    if (mode === 'cloud' && cfg.onCloud) {
      const child = spawn('/bin/sh', ['-c', cfg.onCloud], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('close', (code) => cfg.log(`on-cloud hook exited ${code}: ${out.trim().slice(0, 300)}`))
    }
    writeStatus()
  }

  function probe(target) {
    return new Promise((resolve) => {
      const req = http.get(
        { host: target.host, port: target.port, path: '/health', timeout: cfg.probeTimeoutMs, agent: false },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (d) => (body += d))
          res.on('end', () => {
            try {
              resolve({ ok: res.statusCode === 200 && JSON.parse(body).ok === true })
            } catch {
              resolve({ ok: false, error: 'bad health body' })
            }
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }))
    })
  }

  async function tick() {
    const [m, c] = await Promise.all([probe(cfg.mac), probe(cfg.cloud)])
    const now = Date.now()
    if (m.ok) {
      state.mac.healthy = true
      state.mac.fails = 0
      state.mac.lastOkAt = now
      setMode('mac', 'mac healthy')
    } else {
      state.mac.fails++
      state.mac.lastError = m.error || 'unhealthy'
      if (state.mac.fails >= cfg.failAfter) {
        state.mac.healthy = false
        setMode('cloud', `mac ${state.mac.lastError} x${state.mac.fails}`)
      }
    }
    state.cloud.healthy = c.ok
    if (c.ok) state.cloud.lastOkAt = now
    else state.cloud.lastError = c.error || 'unhealthy'
    writeStatus()
  }

  function markMacDown(reason) {
    state.mac.fails = cfg.failAfter
    state.mac.healthy = false
    state.mac.lastError = reason
    setMode('cloud', `request found mac ${reason}`)
  }

  function upstreamFor(mode) {
    return mode === 'mac' ? cfg.mac : cfg.cloud
  }

  function forward(req, res, body, mode, allowRetry) {
    const target = upstreamFor(mode)
    const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress || '' }
    headers['content-length'] = String(body.length)
    delete headers['transfer-encoding']
    const up = http.request(
      { host: target.host, port: target.port, method: req.method, path: req.url, headers, agent: false },
      (upRes) => {
        const outHeaders = { ...upRes.headers, 'x-lattice-backend': mode }
        res.writeHead(upRes.statusCode || 502, outHeaders)
        upRes.pipe(res)
      }
    )
    up.on('error', (e) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const code = e.code || e.message
      if (mode === 'mac') {
        // The reverse forward exists but the Mac is gone (sshd accepts, then the channel fails) or the
        // listener is gone entirely. Either way, stop sending anything else there.
        markMacDown(code)
        if (allowRetry) return forward(req, res, body, 'cloud', false)
      }
      const payload = JSON.stringify({
        ok: false,
        error: { message: `Lattice backend unavailable (${mode}: ${code}). It is switching; retry in a moment.`, code: 'edge_unavailable' }
      })
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'x-lattice-backend': mode })
      res.end(payload)
    })
    up.end(body)
  }

  function onRequest(req, res) {
    if (req.method === 'GET' && req.url === '/edge/status') {
      const payload = JSON.stringify(publicStatus())
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(payload)
      return
    }
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 40 * 1024 * 1024) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const path = (req.url || '/').split('?')[0]
      const safe = req.method === 'GET' || req.method === 'HEAD' || SAFE_RPC.test(path)
      forward(req, res, body, state.mode, safe)
    })
  }

  function onUpgrade(req, client, head) {
    const mode = state.mode
    const target = upstreamFor(mode)
    const upstream = net.connect({ host: target.host, port: target.port })
    const entry = { client, upstream, mode }
    tunnels.add(entry)
    const cleanup = () => {
      tunnels.delete(entry)
      client.destroy()
      upstream.destroy()
    }
    upstream.on('connect', () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      raw += `X-Lattice-Backend: ${mode}\r\n\r\n`
      upstream.write(raw)
      if (head && head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', (e) => {
      if (mode === 'mac') markMacDown(e.code || e.message)
      cleanup()
    })
    client.on('error', cleanup)
    upstream.on('close', cleanup)
    client.on('close', cleanup)
  }

  return {
    state,
    status: publicStatus,
    async start() {
      server = http.createServer(onRequest)
      server.on('upgrade', onUpgrade)
      server.keepAliveTimeout = 65_000
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.listen.port, cfg.listen.host, resolve)
      })
      await tick()
      timer = setInterval(() => void tick(), cfg.healthMs)
      cfg.log(`listening on ${cfg.listen.host}:${cfg.listen.port}; mac=${cfg.mac.host}:${cfg.mac.port} cloud=${cfg.cloud.host}:${cfg.cloud.port}; backend=${state.mode}`)
      return server.address()
    },
    async stop() {
      if (timer) clearInterval(timer)
      for (const t of tunnels) {
        t.client.destroy()
        t.upstream.destroy()
      }
      tunnels.clear()
      if (server) await new Promise((resolve) => server.close(resolve))
    },
    tick
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const edge = createEdge()
  edge.start().catch((e) => {
    console.error(e)
    process.exit(1)
  })
  const stop = () => edge.stop().then(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
