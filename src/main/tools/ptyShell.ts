import * as pty from 'node-pty'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'

/**
 * A persistent, PTY-backed login shell per thread.
 *
 * Why a PTY and not `exec`:
 *  - A packaged Electron app is launched by launchd with a minimal PATH
 *    (`/usr/bin:/bin:/usr/sbin:/sbin`). A plain `exec` inherits that, so `git`,
 *    `node`, `rg`, Homebrew tools, and version managers are all "command not
 *    found". Spawning an interactive **login** shell (`-il`) sources the user's
 *    profile, so the model gets the same PATH the user has in Terminal.
 *  - The session is long-lived, so `cd`, exported vars, and shell state persist
 *    across tool calls the way a real terminal behaves.
 *
 * Commands are framed with a per-call random sentinel so we can capture exactly
 * one command's output and its exit code, with the terminal echo, prompt, and
 * bracketed-paste chatter suppressed at init.
 */

const CTRL_C = String.fromCharCode(3)

export interface ShellRunResult {
  exitCode: number
  output: string
  cwd: string
  timedOut: boolean
  canceled: boolean
}

interface Session {
  proc: IPty
  cwd: string
  /** serializes commands: the PTY has a single stdin/stdout stream */
  queue: Promise<unknown>
  buffer: string
  marker: string | null
  onMarker: (() => void) | null
  ready: Promise<void>
  lastUsed: number
}

const sessions = new Map<string, Session>()
const IDLE_MS = 15 * 60 * 1000
const MAX_OUTPUT = 200 * 1024

let sweepTimer: NodeJS.Timeout | null = null
let exitHooked = false

// eslint-disable-next-line no-control-regex
const ANSI = /[][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><]|[PX^_].*?(?:\\|)|\][^]*(?:|\\))/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '').replace(/\r/g, '')
}

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function killAll(): void {
  for (const s of sessions.values()) {
    try {
      s.proc.kill()
    } catch {
      /* already gone */
    }
  }
  sessions.clear()
}

function ensureHousekeeping(): void {
  if (!exitHooked) {
    exitHooked = true
    process.once('exit', killAll)
    process.once('SIGTERM', killAll)
  }
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, s] of sessions) {
        if (now - s.lastUsed > IDLE_MS) {
          try {
            s.proc.kill()
          } catch {
            /* ignore */
          }
          sessions.delete(key)
        }
      }
    }, 60_000)
    sweepTimer.unref?.()
  }
}

// Order matters. `unsetopt zle` resets the tty to cooked+echo, so `stty -echo`
// must come AFTER it or echo comes back on. `promptsp`/`promptcr` off removes the
// bold reverse-"%" partial-line marker zsh prints before an (empty) prompt.
const INIT_LINES = [
  `PS1='' PS2='' PROMPT='' RPROMPT='' 2>/dev/null`,
  'precmd_functions=() 2>/dev/null; preexec_functions=() 2>/dev/null',
  'unsetopt zle promptcr promptsp 2>/dev/null',
  `printf '\\033[?2004l'`,
  'stty -echo 2>/dev/null'
]

function spawnSession(key: string, cwd: string): Session {
  ensureHousekeeping()
  const shell = process.env.SHELL || '/bin/zsh'
  const proc = pty.spawn(shell, ['-il'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    // Force non-blocking pagers: a `git log` or `less` would otherwise wait for
    // keypresses forever and hang the sentinel.
    env: { ...process.env, TERM: 'xterm-256color', PAGER: 'cat', GIT_PAGER: 'cat', LESS: '-FRX' }
  })
  const session: Session = {
    proc,
    cwd,
    queue: Promise.resolve(),
    buffer: '',
    marker: null,
    onMarker: null,
    ready: Promise.resolve(),
    lastUsed: Date.now()
  }
  proc.onData((data) => {
    session.buffer += data
    if (session.marker && session.onMarker && session.buffer.includes(session.marker)) {
      session.onMarker()
    }
  })
  proc.onExit(() => {
    if (sessions.get(key) === session) sessions.delete(key)
  })
  // Initialize (suppress echo/prompt), then drain the login banner via a no-op.
  for (const line of INIT_LINES) proc.write(line + '\n')
  session.ready = execOne(session, ':', 5000, undefined).then(() => undefined)
  sessions.set(key, session)
  return session
}

/** Run one framed command on an already-initialized session. Assumes serialized access. */
function execOne(
  session: Session,
  command: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<ShellRunResult> {
  const marker = `_LAT_${randomBytes(8).toString('hex')}_`
  session.buffer = ''

  return new Promise<ShellRunResult>((resolve) => {
    let settled = false
    let interruptedAs: { timedOut: boolean; canceled: boolean } | null = null
    let timer: NodeJS.Timeout | null = null
    let hardTimer: NodeJS.Timeout | null = null
    let resyncTimer: NodeJS.Timeout | null = null

    const cleanup = (): void => {
      session.onMarker = null
      session.marker = null
      if (timer) clearTimeout(timer)
      if (hardTimer) clearTimeout(hardTimer)
      if (resyncTimer) clearTimeout(resyncTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    const settle = (rawOutput: string, exitCode: number): void => {
      if (settled) return
      settled = true
      cleanup()
      let text = stripAnsi(rawOutput).replace(/\n+$/, '')
      if (text.length > MAX_OUTPUT) {
        text = text.slice(0, MAX_OUTPUT) + `\n… [truncated ${text.length - MAX_OUTPUT} chars]`
      }
      session.lastUsed = Date.now()
      resolve({
        exitCode,
        output: text,
        cwd: session.cwd,
        timedOut: interruptedAs?.timedOut ?? false,
        canceled: interruptedAs?.canceled ?? false
      })
    }

    // Match the printf OUTPUT (`marker<exit>\t<pwd>\n`), never its echo. At PTY
    // startup, terminal echo is on until `stty -echo` is processed, so the marker
    // string also appears inside the echoed command line — there it is followed by
    // a quote, not by digits+tab, so this strict pattern skips it and we wait for
    // the real sentinel line, by which point echo is off.
    const sentinel = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(-?\\d+)\t([^\r\n]*)\r?\n')
    const onMarker = (): void => {
      const m = sentinel.exec(session.buffer)
      if (!m) return
      const exitCode = m[1] !== undefined ? Number(m[1]) : interruptedAs ? -1 : 0
      session.cwd = m[2] || session.cwd
      settle(session.buffer.slice(0, m.index), exitCode)
    }

    const interrupt = (canceled: boolean): void => {
      if (settled || interruptedAs) return
      interruptedAs = { timedOut: !canceled, canceled }
      session.proc.write(CTRL_C) // the command's pending sentinel printf then runs on its own
      // If the shell is wedged and the sentinel never lands, force one, then give up.
      resyncTimer = setTimeout(() => {
        if (!settled) session.proc.write(`\nprintf '%s%d\\t%s\\n' ${sq(marker)} "$?" "$PWD"\n`)
      }, 1500)
      hardTimer = setTimeout(() => settle(session.buffer, -1), 3000)
    }

    const onAbort = (): void => interrupt(true)

    session.marker = marker
    session.onMarker = onMarker
    if (signal) {
      if (signal.aborted) {
        interrupt(true)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(() => interrupt(false), Math.max(1000, timeoutMs))

    session.proc.write(command + '\n')
    session.proc.write(`printf '%s%d\\t%s\\n' ${sq(marker)} "$?" "$PWD"\n`)
  })
}

/**
 * Run a command in the persistent shell for `key` (typically a thread id).
 * Commands on the same key are serialized and share working directory and state.
 */
export async function runInShell(
  key: string,
  command: string,
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ShellRunResult> {
  let session = sessions.get(key)
  if (!session) session = spawnSession(key, opts.cwd || homedir())
  const bound = session
  const run = async (): Promise<ShellRunResult> => {
    await bound.ready
    const full = opts.cwd ? `cd -- ${sq(opts.cwd)} && { ${command}\n}` : command
    return execOne(bound, full, opts.timeoutMs ?? 120_000, opts.signal)
  }
  // chain onto the queue so concurrent calls don't interleave on one PTY
  const result = session.queue.then(run, run)
  session.queue = result.catch(() => undefined)
  return result
}

/** Tear down the shell session for a key (e.g. when its thread closes). */
export function disposeShell(key: string): void {
  const s = sessions.get(key)
  if (!s) return
  try {
    s.proc.kill()
  } catch {
    /* ignore */
  }
  sessions.delete(key)
}
