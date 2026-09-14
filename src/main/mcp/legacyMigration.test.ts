import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '@shared/types'
import { planLegacyBrowserMigration } from './legacyMigration'

const abrowser: McpServerConfig = {
  id: 'abrowser',
  label: 'abrowser',
  transport: 'stdio',
  command: '/usr/bin/python3',
  args: ['-m', 'abrowser', 'serve'],
  env: { PYTHONPATH: '/Users/dylan/Downloads/agent-browser' },
  enabled: true,
  toolPolicy: { abrowser_eval: 'ask' }
}
const host = { latchkey: { command: '/usr/bin/python3', args: ['-m', 'latchkey', 'serve'] } }

describe('planLegacyBrowserMigration', () => {
  it('replaces the enabled legacy row with latchkey from the host config, keeping the enabled choice', () => {
    const plan = planLegacyBrowserMigration([abrowser], host)
    expect(plan?.removeId).toBe('abrowser')
    expect(plan?.add).toMatchObject({ id: 'latchkey', command: '/usr/bin/python3', args: ['-m', 'latchkey', 'serve'], enabled: true })
    expect(plan?.add.env).toBeUndefined() // never carry the Downloads PYTHONPATH forward
    expect(plan?.add.toolPolicy).toBeUndefined()
  })

  it('keeps a disabled legacy row disabled', () => {
    expect(planLegacyBrowserMigration([{ ...abrowser, enabled: false }], host)?.add.enabled).toBe(false)
  })

  it('only removes the duplicate when latchkey is already registered', () => {
    const latchkey: McpServerConfig = { id: 'latchkey', label: 'latchkey', transport: 'stdio', command: 'python3', args: ['-m', 'latchkey', 'serve'], enabled: false }
    const plan = planLegacyBrowserMigration([abrowser, latchkey], host)
    expect(plan).toEqual({ removeId: 'abrowser', add: latchkey })
  })

  it('does nothing without a legacy row, or without latchkey on the host', () => {
    expect(planLegacyBrowserMigration([], host)).toBeNull()
    expect(planLegacyBrowserMigration([abrowser], {})).toBeNull()
    expect(planLegacyBrowserMigration([{ ...abrowser, id: 'abrowser', args: ['server.js'], env: undefined, command: 'node' }], host)).toBeNull()
  })
})
