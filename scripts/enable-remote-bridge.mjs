/**
 * Provision / repair the desktop app's remote bridge from the command line.
 *
 * The bridge (src/main/net/server.ts) only starts when BOTH are true:
 *   - settings.remoteAccess.enabled
 *   - a password hash exists in the `meta` table (`remote.passwordHash`)
 * If either is missing the app boots with nothing listening on the bridge port, and the cloudflared
 * tunnel in front of it (lattice.pulse-core.com → http://127.0.0.1:8973) answers every request with
 * **HTTP 502** — which is what the iOS app surfaces as "Could not load threads".
 *
 * Normally you set this in Settings → Remote access. This script does the same thing without the UI
 * (and is the way to recover when `meta` has been wiped), writing the identical scrypt hash format
 * used by src/main/net/auth.ts.
 *
 * Usage — the desktop app must be QUIT first (it caches settings in memory and would overwrite them
 * on its next write; it also only reads this state at boot):
 *
 *   osascript -e 'tell application "Lattice" to quit'
 *   node scripts/enable-remote-bridge.mjs            # generates a strong password
 *   LAT_PW='your-password' node scripts/enable-remote-bridge.mjs
 *   open -a Lattice && sleep 6 && curl -s http://127.0.0.1:8973/health
 *
 * The password is printed once and also written to ~/.lattice-remote-password.txt (mode 0600).
 * Existing device tokens are left alone; changing the password does not revoke them (see auth.ts),
 * but a phone whose token was lost will need to sign in again with this password.
 */
import { randomBytes, scryptSync } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const DEFAULT_DB = join(
  homedir(),
  'Library/Application Support/Lattice/data/lattice.db'
)
const dbPath = process.env.LATTICE_DB || DEFAULT_DB
const port = parseInt(process.env.LAT_PORT || '8973', 10)
const publicUrl = process.env.LAT_PUBLIC_URL || 'https://lattice.pulse-core.com'
const secret = process.env.LAT_PW || randomBytes(9).toString('base64url')
const pwFile = join(homedir(), '.lattice-remote-password.txt')

if (!existsSync(dbPath)) {
  console.error(`no Lattice database at ${dbPath} (set LATTICE_DB)`)
  process.exit(1)
}

// better-sqlite3 from the installed app, so this runs without a repo install; falls back to the
// repo's own node_modules when the app is not installed.
function loadDatabase() {
  const candidates = [
    '/Applications/Lattice.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3',
    'better-sqlite3'
  ]
  for (const c of candidates) {
    try {
      return require(c)
    } catch {
      /* try the next one */
    }
  }
  throw new Error('better-sqlite3 not found (install the app, or run `pnpm install` in the repo)')
}

const Database = loadDatabase()
const db = new Database(dbPath)

// Same parameters and encoding as hashPassword() in src/main/net/auth.ts.
const salt = randomBytes(16)
const derived = scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 })
db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run('remote.passwordHash', `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`)

const row = db.prepare("SELECT value_json FROM settings WHERE key = 'app'").get()
if (!row) {
  console.error('no `app` settings row — launch the desktop app once first')
  process.exit(1)
}
const settings = JSON.parse(row.value_json)
settings.remoteAccess = {
  ...settings.remoteAccess,
  enabled: true,
  hasPassword: true,
  port,
  publicUrl
}
db.prepare("UPDATE settings SET value_json = ? WHERE key = 'app'").run(JSON.stringify(settings))
db.close()

writeFileSync(pwFile, secret + '\n', { mode: 0o600 })
console.log('remoteAccess =', JSON.stringify(settings.remoteAccess))
console.log(`password: ${secret}   (also saved to ${pwFile}, mode 0600)`)
console.log('now: open -a Lattice && sleep 6 && curl -s http://127.0.0.1:' + port + '/health')
