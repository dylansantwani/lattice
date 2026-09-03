import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInShell, runInShellPromotable, disposeShell, stripAnsi } from './ptyShell'

describe('stripAnsi', () => {
  it('removes color codes and bracketed-paste markers', () => {
    expect(stripAnsi('[1m[31mred[0m')).toBe('red')
    expect(stripAnsi('hi[?2004hthere')).toBe('hithere')
  })
})

describe('runInShell (persistent PTY session)', () => {
  const key = 'test-thread'
  afterAll(() => disposeShell(key))

  it('captures clean output and a zero exit code', async () => {
    const r = await runInShell(key, 'echo hello-lattice')
    expect(r.output).toBe('hello-lattice')
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
  })

  it('reports a non-zero exit code', async () => {
    // A subshell so the persistent session itself is not exited.
    const r = await runInShell(key, '(exit 3)')
    expect(r.exitCode).toBe(3)
  })

  it('persists working directory across calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lattice-pty-'))
    try {
      await writeFile(join(dir, 'marker.txt'), 'x')
      const cd = await runInShell(key, `cd ${JSON.stringify(dir)}`)
      expect(cd.exitCode).toBe(0)
      // A *separate* call must still be in that directory.
      const ls = await runInShell(key, 'ls')
      expect(ls.output).toContain('marker.txt')
      const pwd = await runInShell(key, 'pwd')
      expect(pwd.output).toContain(dir.split('/').pop() as string)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists exported environment variables across calls', async () => {
    await runInShell(key, 'export LATTICE_TEST_VAR=persisted')
    const r = await runInShell(key, 'echo "$LATTICE_TEST_VAR"')
    expect(r.output).toBe('persisted')
  })

  it('sources a login shell so a full PATH is available', async () => {
    const r = await runInShell(key, 'echo "$PATH"')
    // A login shell yields more than the bare launchd PATH (/usr/bin:/bin:...).
    expect(r.output.split(':').length).toBeGreaterThan(2)
  })

  it('times out a hung command and stays usable afterward', async () => {
    const r = await runInShell(key, 'sleep 30', { timeoutMs: 1000 })
    expect(r.timedOut).toBe(true)
    // Session recovers for the next command.
    const after = await runInShell(key, 'echo recovered')
    expect(after.output).toBe('recovered')
  }, 15000)
})

describe('runInShellPromotable (auto-background on timeout)', () => {
  const key = 'test-thread-bg'
  afterAll(() => disposeShell(key))

  it('promotes a command that outruns the threshold and finishes it in the background', async () => {
    const outcome = await runInShellPromotable(key, 'echo starting; sleep 2; echo done-bg', {
      backgroundAfterMs: 700
    })
    expect(outcome.backgrounded).toBe(true)
    if (!outcome.backgrounded) throw new Error('expected backgrounded outcome')
    // The snapshot taken at promotion has the pre-sleep output, not the post-sleep line.
    expect(outcome.outputSoFar).toContain('starting')
    expect(outcome.outputSoFar).not.toContain('done-bg')
    // The command keeps running; `done` settles with the full output and a real exit code.
    const final = await outcome.done
    expect(final.exitCode).toBe(0)
    expect(final.output).toContain('starting')
    expect(final.output).toContain('done-bg')
    expect(final.timedOut).toBe(false)
  }, 15000)

  it('retires the session so the next command runs on a fresh shell immediately', async () => {
    const outcome = await runInShellPromotable(key, 'sleep 3', { backgroundAfterMs: 500 })
    expect(outcome.backgrounded).toBe(true)
    if (!outcome.backgrounded) throw new Error('expected backgrounded outcome')
    // A new command does NOT wait for the promoted 3s sleep — it gets a fresh PTY right away.
    const started = Date.now()
    const after = await runInShell(key, 'echo fresh')
    expect(after.output).toBe('fresh')
    expect(Date.now() - started).toBeLessThan(2500)
    if (outcome.backgrounded) outcome.stop()
  }, 15000)

  it('does not promote a command that finishes before the threshold', async () => {
    const outcome = await runInShellPromotable(key, 'echo quick', { backgroundAfterMs: 5000 })
    expect(outcome.backgrounded).toBe(false)
    if (outcome.backgrounded) throw new Error('did not expect background')
    expect(outcome.result.output).toBe('quick')
    expect(outcome.result.exitCode).toBe(0)
  })
})
