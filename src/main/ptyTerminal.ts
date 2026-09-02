import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { homedir } from 'node:os'
import { ulid } from '@shared/id'

/**
 * Interactive terminal sessions for the Terminal inspector. Unlike {@link module:tools/ptyShell},
 * which frames one command at a time for the `shell` tool, these are full, normal login shells: raw
 * bytes stream straight to the renderer's xterm.js and keystrokes stream straight back. The two are
 * deliberately separate so the user's hands-on terminal never collides with the agent's tool shell.
 */

interface Term {
  proc: IPty
}

const terms = new Map<string, Term>()
const MAX_TERMS = 8

// Wired by the IPC layer so PTY output/exit can reach the renderer over the push channel, mirroring
// the ask/approval/session brokers (leaf module, no ipc import, no cycle).
let onData: ((id: string, data: string) => void) | null = null
let onExit: ((id: string, exitCode: number) => void) | null = null

export function configureTerminal(cb: {
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number) => void
}): void {
  onData = cb.onData
  onExit = cb.onExit
}

let exitHooked = false
function ensureExitHook(): void {
  if (exitHooked) return
  exitHooked = true
  process.once('exit', killAllTerminals)
  process.once('SIGTERM', killAllTerminals)
}

/** Spawn a new interactive login shell, streaming its output to the renderer. Returns its id. */
export function createTerminal(opts: { cwd?: string; cols?: number; rows?: number } = {}): { id: string } {
  ensureExitHook()
  // Bound the number of live PTYs so a renderer bug can't spawn shells without limit; drop the oldest.
  if (terms.size >= MAX_TERMS) {
    const oldest = terms.keys().next().value
    if (oldest) killTerminal(oldest)
  }
  const id = ulid()
  const shell = process.env.SHELL || '/bin/zsh'
  const proc = pty.spawn(shell, ['-il'], {
    name: 'xterm-256color',
    cols: opts.cols && opts.cols > 0 ? opts.cols : 80,
    rows: opts.rows && opts.rows > 0 ? opts.rows : 24,
    cwd: opts.cwd || homedir(),
    env: { ...process.env, TERM: 'xterm-256color' }
  })
  proc.onData((data) => onData?.(id, data))
  proc.onExit(({ exitCode }) => {
    terms.delete(id)
    onExit?.(id, exitCode)
  })
  terms.set(id, { proc })
  return { id }
}

export function writeTerminal(id: string, data: string): void {
  terms.get(id)?.proc.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const t = terms.get(id)
  if (!t || cols <= 0 || rows <= 0) return
  try {
    t.proc.resize(cols, rows)
  } catch {
    // resize can throw if the pty is mid-teardown — harmless
  }
}

export function killTerminal(id: string): void {
  const t = terms.get(id)
  if (!t) return
  try {
    t.proc.kill()
  } catch {
    // already gone
  }
  terms.delete(id)
}

export function killAllTerminals(): void {
  for (const t of terms.values()) {
    try {
      t.proc.kill()
    } catch {
      // already gone
    }
  }
  terms.clear()
}
