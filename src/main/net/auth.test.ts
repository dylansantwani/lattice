import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// electron's `app` is unavailable under vitest; point the db at a throwaway dir.
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-auth-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import { closeDb } from '../store/db'
import {
  _resetAuthState,
  allowAuthAttempt,
  authenticate,
  hasPassword,
  listDevices,
  revokeAllTokens,
  revokeDevice,
  setPassword,
  verifyToken
} from './auth'

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  revokeAllTokens()
  setPassword('') // clear
  _resetAuthState()
})

describe('password', () => {
  it('starts with no password', () => {
    expect(hasPassword()).toBe(false)
  })
  it('refuses authentication until a password is set', () => {
    expect(authenticate('anything', 'iPhone')).toBeNull()
  })
  it('sets and verifies a password by minting a token', () => {
    setPassword('hunter2')
    expect(hasPassword()).toBe(true)
    expect(authenticate('wrong', 'iPhone')).toBeNull()
    const res = authenticate('hunter2', 'Dylan iPhone')
    expect(res).not.toBeNull()
    expect(typeof res!.token).toBe('string')
    expect(res!.token.length).toBeGreaterThan(32)
    expect(res!.expiresAt).toBeGreaterThan(Date.now())
  })
  it('clearing the password revokes all tokens', () => {
    setPassword('hunter2')
    const res = authenticate('hunter2', 'iPhone')!
    expect(verifyToken(res.token)).not.toBeNull()
    setPassword('')
    expect(verifyToken(res.token)).toBeNull()
    expect(hasPassword()).toBe(false)
  })
})

describe('tokens', () => {
  it('validates a minted token and rejects garbage', () => {
    setPassword('pw')
    const { token } = authenticate('pw', 'iPhone')!
    const dev = verifyToken(token)
    expect(dev?.device).toBe('iPhone')
    expect(verifyToken('deadbeef')).toBeNull()
    expect(verifyToken(undefined)).toBeNull()
  })

  it('lists devices without exposing the raw token, and revokes by short id', () => {
    setPassword('pw')
    const { token } = authenticate('pw', 'My Phone')!
    const devices = listDevices()
    expect(devices).toHaveLength(1)
    expect(devices[0]!.device).toBe('My Phone')
    expect(JSON.stringify(devices)).not.toContain(token)
    revokeDevice(devices[0]!.id)
    expect(verifyToken(token)).toBeNull()
    expect(listDevices()).toHaveLength(0)
  })

  it('an expired token no longer validates', () => {
    setPassword('pw')
    const now = 1_000_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const { token } = authenticate('pw', 'iPhone')! // 30-day ttl by default
    expect(verifyToken(token)).not.toBeNull()
    vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 24 * 60 * 60 * 1000)
    expect(verifyToken(token)).toBeNull()
    vi.restoreAllMocks()
  })
})

describe('rate limiting', () => {
  it('allows a burst then blocks within the window', () => {
    let allowed = 0
    for (let i = 0; i < 20; i++) if (allowAuthAttempt('1.2.3.4')) allowed++
    expect(allowed).toBeGreaterThan(0)
    expect(allowed).toBeLessThan(20)
    // a different ip is tracked independently
    expect(allowAuthAttempt('5.6.7.8')).toBe(true)
  })
})
