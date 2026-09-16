import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LatticeApi } from '@shared/ipc'
import {
  _resetBridge,
  broadcast,
  dispatch,
  redactForRemote,
  restoreMaskedEnv,
  registerApi,
  restoreRedactedSecrets,
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

  it('strips the speech endpoint key, leaving a presence flag and the rest of the voice settings', () => {
    const redacted = redactForRemote('getSettings', {
      providers: [],
      speech: { engine: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-voice', voice: 'alloy' }
    }) as { speech: Record<string, unknown> }
    expect(redacted.speech).toEqual({ engine: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '', hasApiKey: true, voice: 'alloy' })
  })

  it('restores secrets a remote client echoes back redacted, but lets a real new key through', () => {
    const current = {
      providers: [{ id: 'p1', apiKey: 'sk-provider', headers: { Authorization: 'Bearer z' }, baseUrl: 'http://a' }],
      speech: { engine: 'openai', apiKey: 'sk-voice', voice: 'alloy' }
    }
    const echoed = redactForRemote('getSettings', current) as Record<string, unknown>
    const restored = restoreRedactedSecrets({ ...echoed, speech: { ...(echoed.speech as object), voice: 'nova' } }, current)
    expect(restored.speech).toEqual({ engine: 'openai', apiKey: 'sk-voice', voice: 'nova' })
    expect((restored.providers as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'p1', apiKey: 'sk-provider', headers: { Authorization: 'Bearer z' } })
    expect((restored.providers as Array<Record<string, unknown>>)[0]).not.toHaveProperty('hasKey')
    const changed = restoreRedactedSecrets({ speech: { engine: 'openai', apiKey: 'sk-new' } }, current)
    expect(changed.speech).toEqual({ engine: 'openai', apiKey: 'sk-new' })
  })

  it('masks secret env words in MCP configs but not names that merely contain them', () => {
    const list = redactForRemote('listMcpServers', [
      {
        config: {
          id: 'latchkey',
          env: {
            LATCHKEY_VIEWER_PORT: '8788', LATCHKEY_COMPACT: '1', GITHUB_TOKEN: 't',
            API_KEY: 'k', OPENAI_API_KEY: 'o', AUTHORIZATION: 'Bearer x', ACCESSKEY: 'a', PRIVATE_KEY: 'p'
          }
        },
        status: {}
      }
    ]) as Array<{ config: { env: Record<string, string> } }>
    expect(list[0]!.config.env).toEqual({
      LATCHKEY_VIEWER_PORT: '8788', LATCHKEY_COMPACT: '1', GITHUB_TOKEN: '***', API_KEY: '***',
      OPENAI_API_KEY: '***', AUTHORIZATION: '***', ACCESSKEY: '***', PRIVATE_KEY: '***'
    })
  })

  it('restores masked env a client echoes back through upsertMcpServer, but lets a real value through', () => {
    const stored = [{ config: { id: 'srv', env: { GITHUB_TOKEN: 'real', PLAIN: 'p' } }, status: {} }]
    const restored = restoreMaskedEnv({ id: 'srv', env: { GITHUB_TOKEN: '***', PLAIN: 'changed' } }, stored)
    expect(restored.env).toEqual({ GITHUB_TOKEN: 'real', PLAIN: 'changed' })
    const fresh = restoreMaskedEnv({ id: 'srv', env: { GITHUB_TOKEN: 'new-token' } }, stored)
    expect(fresh.env).toEqual({ GITHUB_TOKEN: 'new-token' })
    // a server the store does not know keeps what it was given
    expect(restoreMaskedEnv({ id: 'other', env: { X: '***' } }, stored).env).toEqual({ X: '***' })
  })

  it('a bridge upsert that echoes masked env never writes the mask into the store', async () => {
    const saved: unknown[] = []
    const listMcpServers = vi.fn(async () => [{ config: { id: 'srv', env: { API_KEY: 'real', PORT: '1' } }, status: {} }])
    const upsertMcpServer = vi.fn(async (config: unknown) => { saved.push(config) })
    registerApi({ listMcpServers, upsertMcpServer } as unknown as LatticeApi)
    const seen = (await dispatch('listMcpServers', [])) as Array<{ config: { env: Record<string, string> } }>
    expect(seen[0]!.config.env.API_KEY).toBe('***')
    await dispatch('upsertMcpServer', [{ ...seen[0]!.config, env: { ...seen[0]!.config.env, PORT: '2' } }])
    expect(saved[0]).toMatchObject({ id: 'srv', env: { API_KEY: 'real', PORT: '2' } })
  })

  it('never lets a bridge caller aim speech synthesis at another endpoint', async () => {
    const synthesizeSpeech = vi.fn(async () => ({ mime: 'audio/mpeg', base64: '' }))
    const listSpeechVoices = vi.fn(async () => [])
    registerApi({ synthesizeSpeech, listSpeechVoices } as unknown as LatticeApi)
    await dispatch('synthesizeSpeech', ['hi', { baseUrl: 'https://attacker.example/v1', apiKey: 'x', voice: 'nova' }])
    await dispatch('listSpeechVoices', [{ baseUrl: 'http://169.254.169.254/v1' }])
    expect(synthesizeSpeech).toHaveBeenCalledWith('hi', { voice: 'nova' })
    expect(listSpeechVoices).toHaveBeenCalledWith({})
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
