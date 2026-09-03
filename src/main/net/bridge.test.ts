import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LatticeApi } from '@shared/ipc'
import {
  _resetBridge,
  broadcast,
  dispatch,
  redactForRemote,
  registerApi,
  subscribe,
  subscriberCount,
  UnknownMethodError
} from './bridge'

afterEach(() => _resetBridge())

/** A partial LatticeApi where only the methods a test exercises are implemented. */
function mockApi(overrides: Partial<Record<keyof LatticeApi, (...a: unknown[]) => unknown>>): LatticeApi {
  return overrides as unknown as LatticeApi
}

describe('dispatch', () => {
  it('invokes an allow-listed method with positional args', async () => {
    const listThreads = vi.fn(async () => [{ id: 't1' }])
    registerApi(mockApi({ listThreads }))
    const result = await dispatch('listThreads', ['ws1', true])
    expect(listThreads).toHaveBeenCalledWith('ws1', true)
    expect(result).toEqual([{ id: 't1' }])
  })

  it('rejects a method not in API_METHODS (no reaching arbitrary properties)', async () => {
    registerApi(mockApi({}))
    await expect(dispatch('constructor', [])).rejects.toBeInstanceOf(UnknownMethodError)
    await expect(dispatch('__proto__', [])).rejects.toBeInstanceOf(UnknownMethodError)
    await expect(dispatch('totallyMadeUp', [])).rejects.toBeInstanceOf(UnknownMethodError)
  })

  it('propagates the api method error message', async () => {
    registerApi(mockApi({ getThread: async () => { throw new Error('thread not found: x') } }))
    await expect(dispatch('getThread', ['x'])).rejects.toThrow('thread not found: x')
  })
})

describe('push fan-out', () => {
  it('broadcasts to every subscriber and stops after unsubscribe', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribe(a)
    subscribe(b)
    expect(subscriberCount()).toBe(2)
    broadcast({ kind: 'models.updated' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    broadcast({ kind: 'mcp.updated' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('one throwing subscriber does not break the others', () => {
    const good = vi.fn()
    subscribe(() => { throw new Error('dead socket') })
    subscribe(good)
    expect(() => broadcast({ kind: 'models.updated' })).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })
})

describe('redactForRemote', () => {
  it('strips provider apiKey from getSettings, leaving a presence flag', () => {
    const redacted = redactForRemote('getSettings', {
      defaultModel: 'cc/x',
      providers: [
        { id: 'p1', label: 'OmniRoute', baseUrl: 'http://localhost:20128', apiKey: 'sk-secret', enabled: true, headers: { Authorization: 'Bearer z' } }
      ]
    }) as { providers: Record<string, unknown>[] }
    const p = redacted.providers[0]!
    expect(p.apiKey).toBeUndefined()
    expect(p.headers).toBeUndefined()
    expect(p.hasKey).toBe(true)
    expect(p.headerNames).toEqual(['Authorization'])
    expect(p.baseUrl).toBe('http://localhost:20128')
  })

  it('reports hasKey:false when a provider has no key', () => {
    const redacted = redactForRemote('getSettings', { providers: [{ id: 'p', apiKey: '', enabled: false }] }) as {
      providers: { hasKey: boolean }[]
    }
    expect(redacted.providers[0]!.hasKey).toBe(false)
  })

  it('masks secret-looking MCP env vars in listMcpServers', () => {
    const redacted = redactForRemote('listMcpServers', [
      { config: { id: 's', env: { API_KEY: 'abc', PATH: '/usr/bin' } }, status: { connected: true } }
    ]) as { config: { env: Record<string, string> } }[]
    expect(redacted[0]!.config.env.API_KEY).toBe('***')
    expect(redacted[0]!.config.env.PATH).toBe('/usr/bin')
  })

  it('passes non-secret methods through untouched', () => {
    const payload = [{ id: 't1' }, { id: 't2' }]
    expect(redactForRemote('listThreads', payload)).toBe(payload)
  })

  it('dispatch runs results through redaction', async () => {
    registerApi(mockApi({ getSettings: async () => ({ providers: [{ id: 'p', apiKey: 'sk-x', enabled: true }] }) }))
    const result = (await dispatch('getSettings', [])) as { providers: { apiKey?: string; hasKey: boolean }[] }
    expect(result.providers[0]!.apiKey).toBeUndefined()
    expect(result.providers[0]!.hasKey).toBe(true)
  })
})
