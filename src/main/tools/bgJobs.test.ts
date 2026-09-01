import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  startShellJob,
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
})
