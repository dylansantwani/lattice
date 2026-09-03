/**
 * Password + device-token auth for the remote bridge (see ./server.ts).
 *
 * Single-user model: one shared password gates access. The password is stored only as a scrypt
 * hash in the local `meta` table (never in AppSettings, so it is never sent to a remote client).
 * A successful password check mints an opaque 256-bit device token, also persisted in `meta`, that
 * the client then presents on every RPC and on the WebSocket upgrade. Tokens carry a device label
 * and an expiry, and can be listed/revoked from Settings.
 *
 * Nothing here is a substitute for the transport being private — the bridge binds loopback and is
 * fronted by a Cloudflare tunnel (optionally behind Cloudflare Access). This is the application
 * layer of defense-in-depth: it must be safe even if the endpoint were reachable directly.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { prep } from '../store/db'
import { getSettings, setSettings } from '../store/eventStore'

const META_PWD = 'remote.passwordHash'
const META_TOKENS = 'remote.tokens'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 32

export interface DeviceToken {
  /** the opaque bearer token (hex) the client sends */
  token: string
  /** human label the client supplied at /auth (e.g. "Dylan's iPhone") */
  device: string
  createdAt: number
  expiresAt: number
  lastSeenAt: number
}

// ---------- password ----------

function metaGet(key: string): string | undefined {
  const row = prep('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}
function metaSet(key: string, value: string): void {
  prep('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value
  )
}
function metaDelete(key: string): void {
  prep('DELETE FROM meta WHERE key = ?').run(key)
}

/** `scrypt$<saltHex>$<hashHex>` — self-describing so the params can evolve without a migration. */
function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, salt, expected.length, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function hasPassword(): boolean {
  return !!metaGet(META_PWD)
}

/** Set (or replace) the remote-access password. Passing an empty string clears it and disables auth. */
export function setPassword(password: string): void {
  if (!password) {
    metaDelete(META_PWD)
    revokeAllTokens()
  } else {
    metaSet(META_PWD, hashPassword(password))
  }
  // keep the settings mirror (hasPassword) in sync for the renderer
  const ra = getSettings().remoteAccess
  setSettings({ remoteAccess: { ...ra, hasPassword: !!password } })
}

// ---------- tokens ----------

function loadTokens(): DeviceToken[] {
  const raw = metaGet(META_TOKENS)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as DeviceToken[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
function saveTokens(tokens: DeviceToken[]): void {
  metaSet(META_TOKENS, JSON.stringify(tokens))
}

function pruneExpired(tokens: DeviceToken[], now: number): DeviceToken[] {
  return tokens.filter((t) => t.expiresAt > now)
}

/**
 * Check a password and, on success, mint a device token. Returns null on a bad password or when no
 * password has been set (the bridge should refuse all access until one is configured).
 */
export function authenticate(password: string, device: string): { token: string; expiresAt: number } | null {
  const stored = metaGet(META_PWD)
  if (!stored) return null
  if (!verifyPassword(password, stored)) return null
  const now = Date.now()
  const ttlDays = Math.max(1, getSettings().remoteAccess.tokenTtlDays || 30)
  const token = randomBytes(32).toString('hex')
  const record: DeviceToken = {
    token,
    device: (device || 'unknown device').slice(0, 120),
    createdAt: now,
    expiresAt: now + ttlDays * 24 * 60 * 60 * 1000,
    lastSeenAt: now
  }
  const tokens = pruneExpired(loadTokens(), now)
  tokens.push(record)
  saveTokens(tokens)
  return { token, expiresAt: record.expiresAt }
}

/** Validate a bearer token; refreshes lastSeen. Returns the device label, or null if invalid/expired. */
export function verifyToken(token: string | undefined): DeviceToken | null {
  if (!token) return null
  const now = Date.now()
  const tokens = pruneExpired(loadTokens(), now)
  const match = tokens.find((t) => t.token.length === token.length && timingSafeEqual(Buffer.from(t.token), Buffer.from(token)))
  if (!match) {
    // persist the prune even on a miss so expired rows don't accumulate
    if (tokens.length !== loadTokens().length) saveTokens(tokens)
    return null
  }
  match.lastSeenAt = now
  saveTokens(tokens)
  return match
}

/** Redacted device list for the Settings UI (never exposes the raw token). */
export function listDevices(): { id: string; device: string; createdAt: number; lastSeenAt: number; expiresAt: number }[] {
  return pruneExpired(loadTokens(), Date.now()).map((t) => ({
    id: t.token.slice(-8),
    device: t.device,
    createdAt: t.createdAt,
    lastSeenAt: t.lastSeenAt,
    expiresAt: t.expiresAt
  }))
}

/** Revoke one device by the short id shown in the UI (last 8 chars of its token). */
export function revokeDevice(id: string): void {
  saveTokens(loadTokens().filter((t) => t.token.slice(-8) !== id))
}

export function revokeAllTokens(): void {
  metaDelete(META_TOKENS)
}

// ---------- rate limiting (blunt brute-force guard on /auth) ----------

const attempts = new Map<string, { count: number; resetAt: number }>()
const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 8

/** Returns true when the caller (keyed by ip) is allowed another /auth attempt right now. */
export function allowAuthAttempt(key: string): boolean {
  const now = Date.now()
  const rec = attempts.get(key)
  if (!rec || rec.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }
  if (rec.count >= MAX_ATTEMPTS) return false
  rec.count++
  return true
}

/** test hook */
export function _resetAuthState(): void {
  attempts.clear()
}
