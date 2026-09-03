import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import type { BgJobStatus, BgJobView } from '@shared/types'
import { oneShotShell } from '../platform/shell'

export type { BgJobStatus, BgJobView }

/**
 * Background jobs: long-running shell commands (a download, a build, a big test run) that the model
 * starts and is then FREED from — the job keeps running after the turn ends, so the model doesn't
 * burn a turn blocking on it. It checks back later with `job_status`, or stops it with `stop_job`.
 *
 * Unlike the interactive `shell` (a single persistent PTY per thread, serialized, tied to the run's
 * abort), each background job is its OWN detached child process:
 *  - it does not block the thread's interactive shell,
 *  - it is NOT tied to the run's AbortController, so cancelling the turn (or the turn simply ending)
 *    leaves the job running — that is the whole point,
 *  - it is killed only by `stop_job`, deleting its thread, or the app quitting.
 *
 * A login shell (`$SHELL -lc`) is used so the job inherits the user's real PATH (Homebrew, node,
 * git, version managers) the same way the interactive shell does — a packaged app's launchd PATH is
 * otherwise too minimal to find those tools.
 */

const OUTPUT_CAP = 200 * 1024
/** Per-thread cap; when exceeded, the oldest FINISHED jobs are pruned (running ones are kept). */
const MAX_JOBS_PER_THREAD = 25

interface BgJob {
  id: string
  threadId: string
  command: string
  status: BgJobStatus
  startedAt: number
  endedAt?: number
  exitCode?: number
  output: string
  truncated: number
  /** The detached child, for a job started by {@link startShellJob}. Absent for an adopted job. */
  child?: ChildProcess
  /**
   * How this job is terminated. For a spawned job it kills the child; for an ADOPTED job (a
   * foreground command promoted out of the persistent PTY, see {@link adoptShellJob}) it kills the
   * retired PTY. Used by {@link stopJob}, {@link killThreadJobs}, and {@link killAllBgJobs} so both
   * kinds are cancelable uniformly.
   */
  kill: (hard: boolean) => void
  /** resolvers waiting for this job to finish (from `waitJobs`) */
  waiters: Array<() => void>
  /**
   * Live view of an ADOPTED job's output while it runs (the retired PTY keeps buffering; this reads
   * that buffer), so `job_status` and the inspector can peek at a promoted command mid-flight rather
   * than seeing the promotion-time snapshot until it ends. Cleared once the final output lands.
   */
  peek?: () => string
  /** A foreground command moved to the background after its grace window (vs. started as a job). */
  promoted?: boolean
  /** The model's short label for what the command is for. */
  purpose?: string
  /** Throttle for output-change notifications (see {@link notifyChange}). */
  lastNotifyAt?: number
}

/** Subscriber for job lifecycle/output changes — the IPC layer pushes `jobs.updated` to the renderer. */
let onChange: ((threadId: string) => void) | null = null
export function configureBgJobs(deps: { onChange: (threadId: string) => void }): void {
  onChange = deps.onChange
}
const NOTIFY_THROTTLE_MS = 400
function notifyChange(job: BgJob, force = false): void {
  if (!onChange) return
  const now = Date.now()
  if (!force && job.lastNotifyAt !== undefined && now - job.lastNotifyAt < NOTIFY_THROTTLE_MS) return
  job.lastNotifyAt = now
  try {
    onChange(job.threadId)
  } catch {
    /* a renderer push must never break a job */
  }
}

const jobs = new Map<string, BgJob>()
let exitHooked = false

function ensureExitHook(): void {
  if (exitHooked) return
  exitHooked = true
  process.once('exit', killAllBgJobs)
  process.once('SIGTERM', killAllBgJobs)
}

function toView(j: BgJob): BgJobView {
  return {
    id: j.id,
    threadId: j.threadId,
    command: j.command,
    status: j.status,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    exitCode: j.exitCode,
    output:
      j.status === 'running' && j.peek
        ? j.peek()
        : j.output + (j.truncated ? `\n… [${j.truncated} more chars truncated]` : ''),
    running: j.status === 'running',
    ...(j.promoted ? { promoted: true } : {}),
    ...(j.purpose ? { purpose: j.purpose } : {})
  }
}

function appendOutput(j: BgJob, chunk: string): void {
  if (j.output.length >= OUTPUT_CAP) {
    j.truncated += chunk.length
    return
  }
  const room = OUTPUT_CAP - j.output.length
  if (chunk.length <= room) j.output += chunk
  else {
    j.output += chunk.slice(0, room)
    j.truncated += chunk.length - room
  }
  notifyChange(j)
}

function finish(job: BgJob, status: BgJobStatus, exitCode: number): void {
  if (job.status !== 'running') return
  job.status = status
  job.endedAt = Date.now()
  job.exitCode = exitCode
  const waiters = job.waiters
  job.waiters = []
  for (const w of waiters) w()
  notifyChange(job, true)
}

/** Keep at most MAX_JOBS_PER_THREAD per thread, dropping the oldest finished jobs first. */
function pruneThread(threadId: string): void {
  const mine = [...jobs.values()].filter((j) => j.threadId === threadId)
  let over = mine.length - MAX_JOBS_PER_THREAD
  if (over <= 0) return
  const finished = mine
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  for (const j of finished) {
    if (over <= 0) break
    jobs.delete(j.id)
    over -= 1
  }
}

/** Start a shell command as a detached background job on `threadId`. Returns its initial view. */
export function startShellJob(
  threadId: string,
  command: string,
  opts: { cwd?: string; purpose?: string } = {}
): BgJobView {
  ensureExitHook()
  const shell = oneShotShell(command)
  const cwd = opts.cwd || homedir()
  const job: BgJob = {
    id: `job_${randomBytes(5).toString('hex')}`,
    threadId,
    command,
    status: 'running',
    startedAt: Date.now(),
    output: '',
    truncated: 0,
    purpose: opts.purpose,
    // child + kill are wired below once the child exists. Spawn can throw synchronously (bad shell
    // path) — guard it, in which case the job is born failed and kill is a no-op.
    child: undefined,
    kill: () => undefined,
    waiters: []
  }
  try {
    const child = spawn(shell.file, shell.args, {
      cwd,
      env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' }
    })
    job.child = child
    job.kill = (hard) => {
      try {
        child.kill(hard ? 'SIGKILL' : 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
    child.stdout?.on('data', (d: Buffer) => appendOutput(job, d.toString()))
    child.stderr?.on('data', (d: Buffer) => appendOutput(job, d.toString()))
    child.on('error', (err: Error) => {
      appendOutput(job, `\n[spawn error] ${err.message}`)
      finish(job, 'failed', 1)
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      finish(job, code === 0 ? 'done' : 'failed', code ?? (signal ? 1 : 0))
    })
  } catch (err) {
    appendOutput(job, `\n[spawn error] ${err instanceof Error ? err.message : String(err)}`)
    job.status = 'failed'
    job.endedAt = Date.now()
    job.exitCode = 1
  }
  jobs.set(job.id, job)
  pruneThread(threadId)
  notifyChange(job, true)
  return toView(job)
}

/**
 * Adopt a foreground command that was promoted out of the persistent PTY into the background-job
 * registry, so it shows up in `job_status` / `stop_job` exactly like a job started with
 * `shell(background:true)`. The command is already running elsewhere (a retired PTY); `done` resolves
 * with its final result when it finishes and `stop` kills it. The output snapshot taken at promotion
 * is shown until completion, when it is replaced by the full captured output.
 */
export function adoptShellJob(
  threadId: string,
  command: string,
  src: {
    startedAt: number
    outputSoFar: string
    done: Promise<{ exitCode: number; output: string }>
    stop: () => void
    /** live output so far (see {@link BgJob.peek}); the snapshot is shown when absent */
    peek?: () => string
    purpose?: string
  }
): BgJobView {
  ensureExitHook()
  const job: BgJob = {
    id: `job_${randomBytes(5).toString('hex')}`,
    threadId,
    command,
    status: 'running',
    startedAt: src.startedAt,
    output: '',
    truncated: 0,
    child: undefined,
    kill: () => src.stop(),
    waiters: [],
    peek: src.peek,
    promoted: true,
    purpose: src.purpose
  }
  appendOutput(job, src.outputSoFar)
  jobs.set(job.id, job)
  pruneThread(threadId)
  notifyChange(job, true)
  src.done.then(
    ({ exitCode, output }) => {
      // Replace the promotion-time snapshot with the full final output.
      job.peek = undefined
      job.output = ''
      job.truncated = 0
      appendOutput(job, output)
      finish(job, exitCode === 0 ? 'done' : 'failed', exitCode)
    },
    (err: unknown) => {
      job.peek = undefined
      appendOutput(job, `\n[error] ${err instanceof Error ? err.message : String(err)}`)
      finish(job, 'failed', 1)
    }
  )
  return toView(job)
}

/** Every job on a thread, oldest first. */
export function listJobs(threadId: string): BgJobView[] {
  return [...jobs.values()]
    .filter((j) => j.threadId === threadId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(toView)
}

export function getJob(id: string): BgJobView | undefined {
  const j = jobs.get(id)
  return j ? toView(j) : undefined
}

/**
 * Resolve once every targeted job has finished — or immediately if none is still running. An
 * optional `signal` (the run's abort) settles the wait early with the current state WITHOUT killing
 * the jobs, so cancelling the turn stops the model waiting but leaves the downloads running. An
 * optional `timeoutMs` bounds the wait the same way: when it passes, the current state is returned
 * and the jobs keep running (the `job_status` tool's bounded wait).
 */
export function waitJobs(ids: string[], signal?: AbortSignal, timeoutMs?: number): Promise<BgJobView[]> {
  const targets = ids.map((id) => jobs.get(id)).filter((j): j is BgJob => !!j)
  const running = targets.filter((j) => j.status === 'running')
  if (running.length === 0) return Promise.resolve(targets.map(toView))
  return new Promise((resolve) => {
    let remaining = running.length
    let done = false
    let timer: NodeJS.Timeout | undefined
    const settle = (): void => {
      if (done) return
      done = true
      signal?.removeEventListener('abort', onAbort)
      if (timer) clearTimeout(timer)
      resolve(targets.map(toView))
    }
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
      timer = setTimeout(settle, Math.max(0, timeoutMs))
    }
    const onOne = (): void => {
      remaining -= 1
      if (remaining <= 0) settle()
    }
    const onAbort = (): void => settle()
    for (const j of running) j.waiters.push(onOne)
    if (signal) {
      if (signal.aborted) return settle()
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** Terminate a running job (SIGTERM). Returns false if it is unknown or already finished. */
export function stopJob(id: string): boolean {
  const j = jobs.get(id)
  if (!j || j.status !== 'running') return false
  j.kill(false)
  finish(j, 'canceled', -1)
  return true
}

/** Kill and forget every job on a thread (e.g. when the thread is deleted). Returns the count. */
export function killThreadJobs(threadId: string): number {
  let n = 0
  for (const j of [...jobs.values()]) {
    if (j.threadId !== threadId) continue
    if (j.status === 'running') j.kill(false)
    jobs.delete(j.id)
    n += 1
  }
  return n
}

/** Kill every background job everywhere — the app is quitting. */
export function killAllBgJobs(): void {
  for (const j of jobs.values()) {
    if (j.status === 'running') j.kill(true)
  }
  jobs.clear()
}
