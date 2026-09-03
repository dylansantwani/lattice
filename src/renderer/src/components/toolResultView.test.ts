import { describe, expect, it } from 'vitest'
import { toolDetailView } from './toolResultView'

describe('toolDetailView', () => {
  it('shows a shell result as its output with an exit chip, not escaped JSON', () => {
    const v = toolDetailView('shell', { command: 'ls', purpose: 'List' }, { exitCode: 0, stdout: 'a\nb', stderr: '', hint: 'Next time…' })
    expect(v.argsCode).toBe('ls')
    expect(v.status).toBe('exit 0')
    expect(v.sections).toEqual([{ label: 'Output', kind: 'code', text: 'a\nb' }])
    expect(v.modelNotes).toEqual(['Next time…'])
  })

  it('folds a background job handle into one line and keeps the note for the model aside', () => {
    const v = toolDetailView('start_job', { command: 'python sweep.py', purpose: 'Sweep' }, {
      jobId: 'job_1',
      status: 'running',
      background: true,
      purpose: 'Sweep',
      note: 'CONTINUE WORKING…',
      liveOutputNote: 'pipes through tail'
    })
    expect(v.status).toBe('running in background')
    expect(v.sections[0]).toEqual({ label: 'Job', kind: 'text', text: 'job_1 — Sweep' })
    expect(v.modelNotes).toEqual(['CONTINUE WORKING…', 'pipes through tail'])
  })

  it('renders job_status as one block per job with status and elapsed time', () => {
    const v = toolDetailView('job_status', { jobs: ['job_1'], wait: true }, {
      jobs: [{ id: 'job_1', purpose: 'Sweep', status: 'failed', exitCode: 2, elapsedMs: 65_000, output: 'boom' }],
      running: 0
    })
    expect(v.argsSummary).toBe('1 job · wait')
    expect(v.sections[0]).toEqual({ label: 'Sweep — failed (exit 2) · 1m 05s', kind: 'code', text: 'boom' })
  })

  it('renders agents as name — status lines', () => {
    const v = toolDetailView('peek_agents', {}, { agents: [{ name: 'Coder', status: 'running', activity: 'Editing a.ts', elapsedMs: 3000 }], running: 1 })
    expect(v.argsSummary).toBe('all background agents')
    expect(v.sections[0]).toEqual({ label: 'Coder — running · Editing a.ts', kind: 'text', text: '(still working)' })
  })

  it('keeps a denial reason and falls back to JSON for unknown tools', () => {
    expect(toolDetailView('fs_delete', { path: 'x' }, undefined, 'blocked by policy').sections[0]).toEqual({ label: 'Reason', kind: 'text', text: 'blocked by policy' })
    const v = toolDetailView('mcp__x__y', { q: 1 }, { data: [1, 2] })
    expect(v.argsSummary).toBeNull()
    expect(v.sections[0]).toEqual({ label: 'Result', kind: 'json', text: '{\n  "data": [\n    1,\n    2\n  ]\n}' })
  })
})
