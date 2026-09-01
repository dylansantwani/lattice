import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInShell, disposeShell, stripAnsi } from './ptyShell'

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
