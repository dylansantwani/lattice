/**
 * Headless Lattice backend — the full runtime as a plain Node service for a VM ("the cloud").
 *
 * This boots the SAME main-process runtime the desktop app uses (event store, run manager, tools,
 * MCP, memory, providers) with Electron replaced by ./electron-shim.ts at bundle time, and exposes
 * it over the authenticated HTTP + WebSocket bridge (src/main/net). The iOS app — and, if you point
 * it here, the desktop app — are clients of this one backend.
 *
 * Config via env:
 *   LATTICE_DATA_DIR   where the sqlite db + state live (default ~/.lattice)
 *   LATTICE_PORT       bridge port (default 8973)
 *   LATTICE_BIND       bind interface (default 0.0.0.0 so the VM is reachable)
 *   LATTICE_PASSWORD   sets/replaces the remote password on boot when provided
 *   OMNI_KEY / provider settings are read exactly as on the desktop (see src/main/ipc.ts).
 *
 * Run: `node out/headless/index.cjs` (build with scripts/build-headless.mjs). systemd unit in
 * docs/deploy/lattice-backend.service.
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc, stopRuntime } from '../main/ipc'
import { getSettings, setSettings } from '../main/store/eventStore'
import { closeDb } from '../main/store/db'
import { hasPassword, setPassword } from '../main/net/auth'
import { bridgeStatus, startBridge, stopBridge } from '../main/net/server'
import { shutdownMcp } from '../main/mcp/manager'
import { killAllBgJobs } from '../main/tools/bgJobs'
import { killAllTerminals } from '../main/ptyTerminal'

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[lattice-backend] ${new Date().toISOString()} ${msg}`)
}

async function main(): Promise<void> {
  const port = parseInt(process.env.LATTICE_PORT || '', 10) || getSettings().remoteAccess.port || 8973
  if (!process.env.LATTICE_BIND) process.env.LATTICE_BIND = '0.0.0.0'

  // Set the password from the environment if provided (first-run provisioning), else require one.
  if (process.env.LATTICE_PASSWORD) {
    setPassword(process.env.LATTICE_PASSWORD)
    log('remote password set from LATTICE_PASSWORD')
  }
  // Self-provision on first boot: if still no password, generate a strong random one, store only its
  // hash, and write the plaintext to a root-only file for the operator to read from the box itself
  // (over their own SSH) — it is never printed to the log or transmitted anywhere. Disable with
  // LATTICE_NO_AUTOGEN=1 (then set a password via LATTICE_PASSWORD or the desktop Settings).
  if (!hasPassword() && !process.env.LATTICE_NO_AUTOGEN) {
    const generated = randomBytes(18).toString('base64url')
    setPassword(generated)
    const out = join(process.env.LATTICE_DATA_DIR || '.', 'initial-password.txt')
    try {
      writeFileSync(out, generated + '\n', { mode: 0o600 })
      log(`generated an initial remote password → ${out} (read it from the box, then delete the file). Change it anytime via the desktop Settings pointed at this backend.`)
    } catch (e) {
      log(`generated an initial remote password but could not write ${out}: ${(e as Error).message}. Set LATTICE_PASSWORD instead.`)
    }
  }
  if (!hasPassword()) {
    log('WARNING: no remote password set. Set LATTICE_PASSWORD — the bridge refuses all access until one exists.')
  }

  // Force the bridge on for this port; registerIpc() then boots it (bound to LATTICE_BIND).
  const ra = getSettings().remoteAccess
  setSettings({ remoteAccess: { ...ra, enabled: true, port } })

  // Boot the full runtime (store, providers, MCP, memory sync, run manager wiring) + the bridge.
  process.env.LATTICE_RUNTIME_MODE = 'serve'
  await registerIpc()

  // Give the async bridge boot a tick, then report.
  setTimeout(() => {
    const s = bridgeStatus()
    log(s.running ? `bridge listening on ${process.env.LATTICE_BIND}:${s.port}` : 'bridge NOT running (no password?)')
  }, 200)

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log('shutting down…')
    await shutdownMcp()
    await stopBridge()
    await stopRuntime()
    killAllBgJobs()
    killAllTerminals()
    closeDb()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
  process.on('uncaughtException', (e) => log(`uncaughtException: ${(e as Error).stack || e}`))
  process.on('unhandledRejection', (e) => log(`unhandledRejection: ${String(e)}`))

  // Keep the process alive even before a password is set (the bridge otherwise holds the loop). This
  // way `systemctl status` stays active and the box is ready the moment a password is provisioned —
  // it re-checks each minute and boots the bridge when one appears, without needing a restart.
  setInterval(() => {
    if (hasPassword() && !bridgeStatus().running) {
      const ra = getSettings().remoteAccess
      void startBridge(ra.port, process.env.LATTICE_BIND || '0.0.0.0').then(() =>
        log(`bridge started on ${process.env.LATTICE_BIND}:${ra.port}`)
      )
    }
  }, 60_000)

  log(`Lattice headless backend up. data=${process.env.LATTICE_DATA_DIR || '~/.lattice'}`)
}

void main()
