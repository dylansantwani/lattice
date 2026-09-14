import * as pty from 'node-pty'
import { cdPrefix, interactiveShell, sentinelCommand, shellInitLines } from '../platform/shell'
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

/**
 * The result of a command that MAY be promoted to the background. When `backgroundAfterMs` is not
 * requested (the ordinary path), a command always resolves `{ backgrounded: false }`. When it is,
 * and the command is still running once that threshold passes, the session is retired (see
 * {@link Session.retired}) and the command keeps running detached: the caller gets `backgrounded:
 * true` with a `done` promise that settles when the command finally finishes, and a `stop` to kill
 * it — the seam the `shell` tool uses to auto-background a long command and be pinged on completion.
 */
export type ShellOutcome =
  | { backgrounded: false; result: ShellRunResult }
  | {
      backgrounded: true
      /** wall-clock (ms) the command started, so elapsed time stays honest after promotion */
      startedAt: number
      /** output captured up to the moment it was backgrounded (stripped, trimmed) */
      outputSoFar: string
      /** resolves with the full result when the promoted command finally finishes */
      done: Promise<ShellRunResult>
      /** SIGINT then kill the promoted command (job cancellation / thread teardown) */
      stop: () => void
      /** the output captured so far, live — what `job_status` and the inspector show while it runs */
      peek: () => string
    }

interface Session {
  proc: IPty
  cwd: string
  /** serializes commands: the PTY has a single stdin/stdout stream */
  queue: Promise<unknown>
  buffer: string
  marker: string | null
  onMarker: (() => void) | null
  /** Fires on every output chunk of the command in flight (live progress); null between commands. */
  onProgress: (() => void) | null
  ready: Promise<void>
  lastUsed: number
  /**
   * Set once a command on this session was promoted to the background: the session is removed from
   * {@link sessions} so new commands spawn a FRESH PTY, and its old PTY finishes the promoted command
   * in isolation. A command still chained on this session's queue when it retires is re-dispatched
   * onto the live session instead of interleaving on the busy retired PTY.
   */
  retired: boolean
}

const sessions = new Map<string, Session>()
/** Retired PTYs still finishing a backgrounded command — tracked so app-quit still kills them. */
const retiredProcs = new Set<IPty>()
const IDLE_MS = 15 * 60 * 1000
/** Hard ceiling on what a pty command capture retains — and therefore on what any per-call
 *  truncation override (shell `max_output_chars`) can ask for. */
export const PTY_CAPTURE_MAX = 200 * 1024
const MAX_OUTPUT = PTY_CAPTURE_MAX

let sweepTimer: NodeJS.Timeout | null = null
let exitHooked = false

// eslint-disable-next-line no-control-regex
const ANSI = /[][[\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><]|[PX^_].*?(?:\\|)|\][^]*(?:|\\))/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '').replace(/\r/g, '')
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
  for (const proc of retiredProcs) {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }
  retiredProcs.clear()
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

function spawnSession(key: string, cwd: string): Session {
  ensureHousekeeping()
  const shell = interactiveShell()
  const proc = pty.spawn(shell.file, shell.args, {
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
    onProgress: null,
    ready: Promise.resolve(),
    lastUsed: Date.now(),
    retired: false
  }
  proc.onData((data) => {
    session.buffer += data
    if (session.marker && session.onMarker && session.buffer.includes(session.marker)) {
      session.onMarker()
    }
    session.onProgress?.()
  })
  proc.onExit(() => {
    if (sessions.get(key) === session) sessions.delete(key)
  })
  // Initialize (suppress echo/prompt), then drain the login banner via a no-op.
  for (const line of shellInitLines()) proc.write(line + '\n')
  session.ready = execOne(session, ':', 5000, undefined).then(() => undefined)
  sessions.set(key, session)
  return session
}

/** Run one framed command on an already-initialized session. Assumes serialized access. */
function execOne(
  session: Session,
  command: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  /**
   * When set, the soft timeout does NOT kill the command: instead `onBackground` fires with the
   * output so far and the command keeps running until its sentinel finally lands (this promise then
   * settles with the real exit code, `timedOut: false`). The abort signal is also detached at that
   * point, so ending the turn no longer interrupts the now-detached command.
   */
  bg?: { afterMs: number; onBackground: (outputSoFar: string) => void },
  /** Live output so far (stripped), on every chunk while the command runs in the foreground. */
  onOutput?: (soFar: string) => void
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
      session.onProgress = null
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
        if (!settled) session.proc.write('\n' + sentinelCommand(marker) + '\n')
      }, 1500)
      hardTimer = setTimeout(() => settle(session.buffer, -1), 3000)
    }

    const onAbort = (): void => interrupt(true)

    // Promote the command to the background instead of killing it: hand back what has been captured
    // so far, stop listening to the run's abort (the command now outlives the turn), and keep the
    // sentinel armed so this promise still settles — as the `done` result — when it truly finishes.
    const background = (): void => {
      if (settled || interruptedAs) return
      signal?.removeEventListener('abort', onAbort)
      // Promoted: the job registry's live peek takes over from the foreground progress channel.
      session.onProgress = null
      bg?.onBackground(stripAnsi(session.buffer).replace(/\n+$/, ''))
    }

    session.marker = marker
    session.onMarker = onMarker
    session.onProgress = onOutput
      ? () => {
          if (settled) return
          const text = stripAnsi(session.buffer)
          onOutput(text.length > MAX_OUTPUT ? text.slice(-MAX_OUTPUT) : text)
        }
      : null
    if (signal) {
      if (signal.aborted) {
        interrupt(true)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(
      () => (bg ? background() : interrupt(false)),
      Math.max(1000, bg ? bg.afterMs : timeoutMs)
    )

    session.proc.write(command + '\n')
    session.proc.write(sentinelCommand(marker) + '\n')
  })
}

export interface ShellRunOptions {
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * When set, a command still running after this many ms is promoted to the background rather than
   * killed: {@link ShellOutcome} resolves `backgrounded: true` and the command keeps running. Omit
   * for the ordinary "kill on timeout" behaviour.
   */
  backgroundAfterMs?: number
  /** Live output so far, on every chunk while the command runs in the foreground (see the `shell` tool). */
  onOutput?: (soFar: string) => void
}

/**
 * Core dispatcher: run `command` on the persistent shell for `key`, serialized on that session's
 * queue. Returns a {@link ShellOutcome} — `backgrounded: false` for the ordinary completion/timeout
 * path, or `backgrounded: true` when `opts.backgroundAfterMs` was set and the command outran it.
 */
function dispatch(key: string, command: string, opts: ShellRunOptions): Promise<ShellOutcome> {
  let session = sessions.get(key)
  if (!session || session.retired) session = spawnSession(key, opts.cwd || homedir())
  const bound = session
  const runOnce = (): Promise<ShellOutcome> =>
    new Promise<ShellOutcome>((resolveOutcome) => {
      void bound.ready.then(() => {
        // A command chained here before this session retired must not run on the busy retired PTY —
        // re-dispatch it onto the live (freshly spawned) session instead.
        if (bound.retired) {
          resolveOutcome(dispatch(key, command, opts))
          return
        }
        const full = opts.cwd ? cdPrefix(opts.cwd, command) : command
        const startedAt = Date.now()
        let backgrounded = false
        const finalPromise = execOne(
          bound,
          full,
          opts.timeoutMs ?? 120_000,
          opts.signal,
          opts.backgroundAfterMs !== undefined
            ? {
                afterMs: opts.backgroundAfterMs,
                onBackground: (outputSoFar) => {
                  backgrounded = true
                  bound.retired = true
                  retiredProcs.add(bound.proc)
                  if (sessions.get(key) === bound) sessions.delete(key)
                  const stop = (): void => {
                    try {
                      bound.proc.write(CTRL_C)
                    } catch {
                      /* already gone */
                    }
                    setTimeout(() => {
                      try {
                        bound.proc.kill()
                      } catch {
                        /* already gone */
                      }
                    }, 1500)
                  }
                  const peek = (): string => {
                    const text = stripAnsi(bound.buffer).replace(/\n+$/, '')
                    return text.length > MAX_OUTPUT ? `… [earlier output truncated]\n${text.slice(-MAX_OUTPUT)}` : text
                  }
                  resolveOutcome({
                    backgrounded: true,
                    startedAt,
                    outputSoFar,
                    peek,
                    done: finalPromise.then((result) => {
                      retiredProcs.delete(bound.proc)
                      try {
                        bound.proc.kill()
                      } catch {
                        /* already gone */
                      }
                      return result
                    }),
                    stop
                  })
                }
              }
            : undefined,
          opts.onOutput
        )
        void finalPromise.then(
          (result) => {
            if (!backgrounded) resolveOutcome({ backgrounded: false, result })
          },
          () => undefined
        )
      })
    })
  // Serialize on the session queue. The next command waits until this one no longer occupies the
  // PTY: a foreground command runs to completion; a backgrounded one resolves early (at promotion),
  // having retired onto its own PTY, so it frees this session for the next command right away.
  const started = bound.queue.then(runOnce, runOnce)
  bound.queue = started.then(
    () => undefined,
    () => undefined
  )
  return started
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
  // No backgroundAfterMs → dispatch never promotes, so the outcome is always foreground.
  const outcome = await dispatch(key, command, opts)
  return outcome.backgrounded ? await outcome.done : outcome.result
}

/**
 * Like {@link runInShell}, but a command still running after `opts.backgroundAfterMs` is promoted to
 * the background instead of killed — the caller gets a handle to keep tracking it. Used by the
 * `shell` tool to auto-background a long-running command and be pinged when it finishes.
 */
export function runInShellPromotable(
  key: string,
  command: string,
  opts: ShellRunOptions = {}
): Promise<ShellOutcome> {
  return dispatch(key, command, opts)
}

/**
 * Pre-spawn the persistent login shell for `key` so the first real command doesn't pay shell
 * startup: `$SHELL -il` sources the user's whole profile, which routinely takes hundreds of
 * milliseconds. Called the moment the model starts DRAFTING a `shell` tool call, so the init and
 * banner-drain overlap the argument streaming (and any approval wait) instead of serializing after
 * them. Idempotent and best-effort: a live session is left untouched, and a node-pty failure is
 * swallowed — the `shell` tool has its own one-shot fallback for that case.
 */
export function warmShell(key: string, cwd = homedir()): void {
  try {
    const existing = sessions.get(key)
    if (existing && !existing.retired) return
    // Same starting directory dispatch() would use for a command without an explicit cwd, so the
    // warmed session is exactly the one a subsequent command reuses.
    spawnSession(key, cwd)
  } catch {
    /* node-pty unavailable — the shell tool falls back to a one-shot login shell */
  }
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
