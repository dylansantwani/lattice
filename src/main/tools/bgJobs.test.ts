import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  startShellJob,
  adoptShellJob,
  listJobs,
  getJob,
  waitJobs,
  stopJob,
  killThreadJobs,
  type BgJobView
} from './bgJobs'

// Each test uses a fresh thread id and tears its jobs down, so the module-global registry never
// leaks state between tests.
const threads: string[] = []
const tid = (): string => {
  const id = `t_${randomBytes(4).toString('hex')}`
  threads.push(id)
  return id
}

afterEach(() => {
  for (const t of threads.splice(0)) killThreadJobs(t)
})

/** Wait for a single job to reach a terminal state and return its final view. */
const finished = async (id: string): Promise<BgJobView> => (await waitJobs([id]))[0]!

describe('bgJobs — background shell jobs', () => {
  it('runs a command to completion and captures its output + exit code', async () => {
    const t = tid()
    const started = startShellJob(t, 'echo hello-bg')
    expect(started.status).toBe('running')
    expect(started.id).toMatch(/^job_/)

    const done = await finished(started.id)
    expect(done.status).toBe('done')
    expect(done.exitCode).toBe(0)
    expect(done.running).toBe(false)
    expect(done.output).toContain('hello-bg')
    expect(done.endedAt).toBeGreaterThanOrEqual(done.startedAt)
  })

  it('reports a non-zero exit as failed with the exit code', async () => {
    const t = tid()
    const job = startShellJob(t, 'exit 3')
    const done = await finished(job.id)
    expect(done.status).toBe('failed')
    expect(done.exitCode).toBe(3)
  })

  it('keeps a long job running and lets stop_job cancel it', async () => {
    const t = tid()
    const job = startShellJob(t, 'sleep 30')
    // still running right after spawn
    expect(getJob(job.id)?.status).toBe('running')
    expect(stopJob(job.id)).toBe(true)
    const view = getJob(job.id)!
    expect(view.status).toBe('canceled')
    expect(view.running).toBe(false)
    // stopping an already-stopped job is a no-op
    expect(stopJob(job.id)).toBe(false)
  })

  it('waits on multiple jobs and returns once all have settled', async () => {
    const t = tid()
    const a = startShellJob(t, 'echo a')
    const b = startShellJob(t, 'echo b')
    const views = await waitJobs([a.id, b.id])
    expect(views).toHaveLength(2)
    expect(views.every((v) => v.status === 'done')).toBe(true)
  })

  it('a wait bounded by timeoutMs returns the current state when it passes, leaving the job running', async () => {
    const t = tid()
    const job = startShellJob(t, 'sleep 30')
    const t0 = Date.now()
    const views = await waitJobs([job.id], undefined, 300)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(views[0]!.status).toBe('running')
    expect(getJob(job.id)!.running).toBe(true)
    // and a job that finishes inside the bound resolves promptly, before the timer
    const quick = startShellJob(t, 'echo quick')
    const t1 = Date.now()
    const done = await waitJobs([quick.id], undefined, 10_000)
    expect(Date.now() - t1).toBeLessThan(5000)
    expect(done[0]!.status).toBe('done')
  })

  it('a wait aborted by a signal returns current state without killing the jobs', async () => {
    const t = tid()
    const job = startShellJob(t, 'sleep 30')
    const ac = new AbortController()
    const p = waitJobs([job.id], ac.signal)
    ac.abort()
    const [view] = await p
    // the wait returned early, but the job is untouched — still running
    expect(view!.status).toBe('running')
    expect(getJob(job.id)?.status).toBe('running')
  })

  it('lists only its own thread\'s jobs, oldest first', async () => {
    const t1 = tid()
    const t2 = tid()
    const j1 = startShellJob(t1, 'sleep 30')
    const j2 = startShellJob(t1, 'sleep 30')
    startShellJob(t2, 'sleep 30')
    const ids = listJobs(t1).map((j) => j.id)
    expect(ids).toEqual([j1.id, j2.id])
    expect(listJobs(t2)).toHaveLength(1)
  })

  it('killThreadJobs terminates and forgets every job on a thread', async () => {
    const t = tid()
    startShellJob(t, 'sleep 30')
    startShellJob(t, 'sleep 30')
    expect(listJobs(t)).toHaveLength(2)
    const killed = killThreadJobs(t)
    expect(killed).toBe(2)
    expect(listJobs(t)).toHaveLength(0)
  })

  describe('adoptShellJob (a promoted foreground command)', () => {
    it('shows a running job with the promotion-time snapshot, then the full output on completion', async () => {
      const t = tid()
      let resolveDone!: (r: { exitCode: number; output: string }) => void
      const done = new Promise<{ exitCode: number; output: string }>((r) => (resolveDone = r))
      const view = adoptShellJob(t, 'long-build', {
        startedAt: Date.now() - 130_000,
        outputSoFar: 'compiling…',
        done,
        stop: () => undefined
      })
      expect(view.status).toBe('running')
      expect(view.running).toBe(true)
      // Visible in the registry like any other background job, showing the snapshot.
      expect(getJob(view.id)?.output).toBe('compiling…')
      expect(listJobs(t)).toHaveLength(1)

      resolveDone({ exitCode: 0, output: 'compiling…\nbuild complete' })
      const final = await finished(view.id)
      expect(final.status).toBe('done')
      expect(final.exitCode).toBe(0)
      // The snapshot is replaced by the full captured output.
      expect(final.output).toBe('compiling…\nbuild complete')
    })

    it('marks a non-zero exit as failed', async () => {
      const t = tid()
      const view = adoptShellJob(t, 'flaky', {
        startedAt: Date.now(),
        outputSoFar: '',
        done: Promise.resolve({ exitCode: 2, output: 'boom' }),
        stop: () => undefined
      })
      const final = await finished(view.id)
      expect(final.status).toBe('failed')
      expect(final.exitCode).toBe(2)
      expect(final.output).toBe('boom')
    })

    it('stopJob invokes the adopted job\'s stop and cancels it', async () => {
      const t = tid()
      let stopped = false
      const view = adoptShellJob(t, 'sleep-forever', {
        startedAt: Date.now(),
        outputSoFar: '',
        done: new Promise(() => undefined), // never resolves on its own
        stop: () => {
          stopped = true
        }
      })
      expect(stopJob(view.id)).toBe(true)
      expect(stopped).toBe(true)
      expect(getJob(view.id)?.status).toBe('canceled')
    })
  })
})

describe('bgJobs — adopted (promoted) jobs peek at live output', () => {
  it('shows the live PTY buffer while running and the final output once done', async () => {
    const t = tid()
    let buffer = 'line 1\n'
    let settle!: (r: { exitCode: number; output: string }) => void
    const done = new Promise<{ exitCode: number; output: string }>((resolve) => {
      settle = resolve
    })
    const job = adoptShellJob(t, 'long-running-thing', {
      startedAt: Date.now() - 5000,
      outputSoFar: 'line 1',
      done,
      stop: () => undefined,
      peek: () => buffer.trimEnd()
    })
    expect(job.promoted).toBe(true)
    expect(job.running).toBe(true)
    expect(getJob(job.id)?.output).toBe('line 1')
    // The command keeps writing after promotion: the view follows the buffer, not the snapshot.
    buffer += 'line 2\nline 3\n'
    expect(getJob(job.id)?.output).toBe('line 1\nline 2\nline 3')
    settle({ exitCode: 0, output: 'line 1\nline 2\nline 3\nfinal' })
    const view = await finished(job.id)
    expect(view.status).toBe('done')
    expect(view.output).toBe('line 1\nline 2\nline 3\nfinal')
  })

  it('a job without a peek keeps showing its promotion-time snapshot until it ends', async () => {
    const t = tid()
    const job = adoptShellJob(t, 'x', {
      startedAt: Date.now(),
      outputSoFar: 'snapshot',
      done: Promise.resolve({ exitCode: 0, output: 'snapshot\nmore' }),
      stop: () => undefined
    })
    expect(getJob(job.id)?.promoted).toBe(true)
    const view = await finished(job.id)
    expect(view.output).toBe('snapshot\nmore')
  })
})
