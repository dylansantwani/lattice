#!/usr/bin/env node
/**
 * Provider-free CLI smoke test.
 *
 * It verifies the two most failure-prone lifecycle paths: a CLI-owned embedded runtime and a
 * second CLI attaching to a long-lived `serve` process through the local control socket.
 * Run `pnpm build:cli` first (or let CI build the bundle as part of its package step).
 */
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cli = join(root, 'out/cli/lattice.cjs')
const dataDir = await mkdtemp(join(tmpdir(), 'lattice-cli-e2e-'))

async function runCli(...args) {
  const result = await execFileAsync(process.execPath, [cli, '--data-dir', dataDir, ...args], {
    cwd: root,
    env: { ...process.env, LATTICE_NO_REMOTE_BRIDGE: '1' },
    maxBuffer: 4 * 1024 * 1024
  })
  return result.stdout.trim()
}

async function waitForRuntime(child) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`serve exited before startup (${child.exitCode})`)
    try {
      const info = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8'))
      if (info.pid === child.pid && info.socket) return info
    } catch {
      // The runtime marker is written after the socket starts; poll through the short boot window.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error('timed out waiting for runtime.json')
}

let serve
try {
  const embedded = JSON.parse(await runCli('threads', 'list', '--json'))
  if (!Array.isArray(embedded)) throw new Error('embedded threads list was not an array')

  serve = spawn(process.execPath, [cli, '--data-dir', dataDir, 'serve'], {
    cwd: root,
    env: { ...process.env, LATTICE_NO_REMOTE_BRIDGE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await waitForRuntime(serve)
  const attached = JSON.parse(await runCli('threads', 'list', '--json'))
  if (!Array.isArray(attached)) throw new Error('attached threads list was not an array')

  const doctor = JSON.parse(await runCli('doctor', '--json'))
  if (!doctor.attached || doctor.runtime?.pid !== serve.pid) throw new Error('doctor did not report the attached serve runtime')
  process.stdout.write('CLI e2e smoke passed (embedded + attached)\n')
} finally {
  if (serve && serve.exitCode === null) {
    serve.kill('SIGINT')
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        serve.kill('SIGTERM')
        resolvePromise()
      }, 3_000)
      serve.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
    })
  }
  await rm(dataDir, { recursive: true, force: true })
}
