// node --test relay/edge
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import { createEdge } from './lattice-edge.mjs'

const require = createRequire(import.meta.url)
const { WebSocketServer, WebSocket } = require('../../node_modules/ws')

/** A stand-in Lattice bridge: /health, /rpc/<name> echo, and a /events WebSocket. */
async function fakeBackend(name) {
  const hits = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body })
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, protocol: 1, subscribers: 0 }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: { backend: name, url: req.url, body } }))
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ kind: 'hello', backend: name })))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const sockets = new Set()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  return {
    port,
    hits,
    async close() {
      for (const s of sockets) s.destroy()
      for (const c of wss.clients) c.terminate()
      await new Promise((r) => server.close(r))
    }
  }
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json' }, agent: false }, (res) => {
      let data = ''
      res.on('data', (d) => (data += d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: data ? JSON.parse(data) : null }))
    })
    req.on('error', reject)
    req.end(body || '')
  })
}

async function freePort() {
  const s = net.createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}

async function setup({ withMac = true } = {}) {
  const cloud = await fakeBackend('cloud')
  const macPort = await freePort()
  let mac = null
  if (withMac) mac = await fakeBackend('mac')
  const edge = createEdge({
    listen: '127.0.0.1:0',
    mac: `127.0.0.1:${mac ? mac.port : macPort}`,
    cloud: `127.0.0.1:${cloud.port}`,
    healthMs: 60_000, // ticks are driven by the test
    failAfter: 2,
    log: () => {}
  })
  const addr = await edge.start()
  return { edge, port: addr.port, mac, cloud }
}

test('prefers the Mac when it is healthy, and says which backend answered', async () => {
  const { edge, port, mac, cloud } = await setup()
  try {
    const r = await request(port, 'POST', '/rpc/listThreads', '{"args":[]}')
    assert.equal(r.json.result.backend, 'mac')
    assert.equal(r.headers['x-lattice-backend'], 'mac')
    assert.equal(mac.hits.at(-1).body, '{"args":[]}')
    const s = await request(port, 'GET', '/edge/status')
    assert.equal(s.json.backend, 'mac')
  } finally {
    await edge.stop()
    await mac.close()
    await cloud.close()
  }
})

test('uses the cloud when there is no Mac forward', async () => {
  const { edge, port, cloud } = await setup({ withMac: false })
  try {
    const r = await request(port, 'POST', '/rpc/sendMessage', '{"args":["t","hi"]}')
    assert.equal(r.json.result.backend, 'cloud')
    assert.equal(edge.state.mode, 'cloud')
  } finally {
    await edge.stop()
    await cloud.close()
  }
})

test('a read that finds the Mac gone is replayed on the cloud and flips the backend at once', async () => {
  const { edge, port, mac, cloud } = await setup()
  try {
    assert.equal(edge.state.mode, 'mac')
    await mac.close()
    const r = await request(port, 'POST', '/rpc/getThreadView', '{"args":["t"]}')
    assert.equal(r.status, 200)
    assert.equal(r.json.result.backend, 'cloud')
    assert.equal(edge.state.mode, 'cloud')
  } finally {
    await edge.stop()
    await cloud.close()
  }
})

test('a mutation that finds the Mac gone is NOT replayed (it may have run) and returns a retryable 502', async () => {
  const { edge, port, mac, cloud } = await setup()
  try {
    await mac.close()
    const r = await request(port, 'POST', '/rpc/sendMessage', '{"args":["t","hi"]}')
    assert.equal(r.status, 502)
    assert.equal(r.json.error.code, 'edge_unavailable')
    assert.equal(cloud.hits.filter((h) => h.url === '/rpc/sendMessage').length, 0)
    const again = await request(port, 'POST', '/rpc/sendMessage', '{"args":["t","hi"]}')
    assert.equal(again.json.result.backend, 'cloud')
  } finally {
    await edge.stop()
    await cloud.close()
  }
})

test('probes need consecutive failures before leaving the Mac, and return to it as soon as it is back', async () => {
  const cloud = await fakeBackend('cloud')
  let mac = await fakeBackend('mac')
  const macPort = mac.port
  const edge = createEdge({ listen: '127.0.0.1:0', mac: `127.0.0.1:${macPort}`, cloud: `127.0.0.1:${cloud.port}`, healthMs: 60_000, failAfter: 2, log: () => {} })
  await edge.start()
  try {
    assert.equal(edge.state.mode, 'mac')
    await mac.close()
    await edge.tick()
    assert.equal(edge.state.mode, 'mac', 'one failed probe is not enough')
    await edge.tick()
    assert.equal(edge.state.mode, 'cloud')
    // bring a Mac back on the same port
    const back = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((r) => back.listen(macPort, '127.0.0.1', r))
    await edge.tick()
    assert.equal(edge.state.mode, 'mac')
    await new Promise((r) => back.close(r))
  } finally {
    await edge.stop()
    await cloud.close()
  }
})

test('event streams are proxied, and closed when the backend switches', async () => {
  const { edge, port, mac, cloud } = await setup()
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events?token=x`)
    const first = await new Promise((resolve, reject) => {
      ws.once('message', (d) => resolve(JSON.parse(String(d))))
      ws.once('error', reject)
    })
    assert.equal(first.backend, 'mac')
    const closed = new Promise((resolve) => ws.once('close', resolve))
    await mac.close()
    await edge.tick()
    await edge.tick()
    assert.equal(edge.state.mode, 'cloud')
    await closed
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/events?token=x`)
    const hello = await new Promise((resolve, reject) => {
      ws2.once('message', (d) => resolve(JSON.parse(String(d))))
      ws2.once('error', reject)
    })
    assert.equal(hello.backend, 'cloud')
    ws2.close()
  } finally {
    await edge.stop()
    await cloud.close()
  }
})
