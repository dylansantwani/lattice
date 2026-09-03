import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-server-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import { closeDb } from '../store/db'
import type { LatticeApi } from '@shared/ipc'
import { _resetBridge, broadcast, registerApi } from './bridge'
import { setPassword, revokeAllTokens, _resetAuthState } from './auth'
import { bridgeStatus, startBridge, stopBridge, PROTOCOL_VERSION } from './server'

function mockApi(overrides: Partial<Record<keyof LatticeApi, (...a: unknown[]) => unknown>>): LatticeApi {
  return overrides as unknown as LatticeApi
}

let base = ''

beforeEach(async () => {
  _resetBridge()
  _resetAuthState()
  revokeAllTokens()
  setPassword('test-pass')
  registerApi(
    mockApi({
      listThreads: async () => [{ id: 't1', title: 'Hello' }],
      getSettings: async () => ({ providers: [{ id: 'p', apiKey: 'sk-SECRET', enabled: true }] })
    })
  )
  await startBridge(0)
  base = `http://127.0.0.1:${bridgeStatus().port}`
})

afterEach(async () => {
  await stopBridge()
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

async function login(): Promise<string> {
  const res = await fetch(`${base}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-pass', device: 'vitest' })
  })
  const body = (await res.json()) as { token: string }
  return body.token
}

describe('bridge server end-to-end', () => {
  it('serves /health without auth', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION })
  })

  it('rejects a bad password and accepts a good one', async () => {
    const bad = await fetch(`${base}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'nope', device: 'x' })
    })
    expect(bad.status).toBe(401)
    const token = await login()
    expect(token).toBeTruthy()
  })

  it('refuses RPC without a token', async () => {
    const res = await fetch(`${base}/rpc/listThreads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: [] })
    })
    expect(res.status).toBe(401)
  })

  it('dispatches an RPC with a valid token', async () => {
    const token = await login()
    const res = await fetch(`${base}/rpc/listThreads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ args: [] })
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; result: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.result).toEqual([{ id: 't1', title: 'Hello' }])
  })

  it('redacts secrets over the wire', async () => {
    const token = await login()
    const res = await fetch(`${base}/rpc/getSettings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ args: [] })
    })
    const text = await res.text()
    expect(text).not.toContain('sk-SECRET')
    expect(text).toContain('"hasKey":true')
  })

  it('404s an unknown method', async () => {
    const token = await login()
    const res = await fetch(`${base}/rpc/dropAllTables`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ args: [] })
    })
    expect(res.status).toBe(404)
  })

  it('streams broadcast push events over an authenticated WebSocket', async () => {
    const token = await login()
    const ws = new WebSocket(`ws://127.0.0.1:${bridgeStatus().port}/events`, {
      headers: { authorization: `Bearer ${token}` }
    })
    const events: unknown[] = []
    ws.on('message', (data) => events.push(JSON.parse(data.toString())))
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    // give the hello a tick, then broadcast a run event
    await new Promise((r) => setTimeout(r, 30))
    broadcast({ kind: 'models.updated' })
    await new Promise((r) => setTimeout(r, 50))
    ws.close()
    expect(events).toContainEqual({ kind: 'hello', protocol: PROTOCOL_VERSION })
    expect(events).toContainEqual({ kind: 'models.updated' })
  })

  it('rejects a WebSocket upgrade without a token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridgeStatus().port}/events`)
    const closed = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(false))
      ws.on('error', () => resolve(true))
      ws.on('unexpected-response', () => resolve(true))
    })
    expect(closed).toBe(true)
  })
})
