import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  configureTerminal,
  createTerminal,
  writeTerminal,
  killTerminal,
  killAllTerminals
} from './ptyTerminal'

const data = new Map<string, string>()
const exited = new Map<string, number>()

beforeEach(() => {
  data.clear()
  exited.clear()
  configureTerminal({
    onData: (id, d) => data.set(id, (data.get(id) ?? '') + d),
    onExit: (id, code) => exited.set(id, code)
  })
})

afterEach(() => killAllTerminals())
afterAll(() => killAllTerminals())

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('ptyTerminal', () => {
  it('spawns a shell, streams output, and takes input', async () => {
    const { id } = createTerminal({ cwd: process.cwd(), cols: 80, rows: 24 })
    writeTerminal(id, 'echo terminal_probe_ok\n')
    await waitFor(() => (data.get(id) ?? '').includes('terminal_probe_ok'))
    expect(data.get(id)).toContain('terminal_probe_ok')
  })

  it('reports exit and drops the session when the shell ends', async () => {
    const { id } = createTerminal({ cwd: process.cwd() })
    writeTerminal(id, 'exit\n')
    await waitFor(() => exited.has(id))
    expect(exited.has(id)).toBe(true)
    // A killed/exited terminal ignores further input rather than throwing.
    expect(() => writeTerminal(id, 'noop\n')).not.toThrow()
  })

  it('kills a terminal on request', async () => {
    const { id } = createTerminal({ cwd: process.cwd() })
    await waitFor(() => (data.get(id) ?? '').length > 0)
    killTerminal(id)
    await waitFor(() => exited.has(id))
    expect(exited.has(id)).toBe(true)
  })
})
