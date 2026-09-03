import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
  shell: { beep: () => undefined },
  app: { getPath: () => '/tmp' }
}))

import { allowsNotice, planNotice } from './notify'

// The notification policy: what each Settings → Notifications level lets through, and how a notice
// is delivered depending on whether a Lattice window is focused.

describe('allowsNotice', () => {
  it('off silences everything', () => {
    expect(allowsNotice('off', 'failure')).toBe(false)
    expect(allowsNotice('off', 'attention')).toBe(false)
    expect(allowsNotice('off', 'done')).toBe(false)
  })
  it('failures lets only failures through', () => {
    expect(allowsNotice('failures', 'failure')).toBe(true)
    expect(allowsNotice('failures', 'attention')).toBe(false)
    expect(allowsNotice('failures', 'done')).toBe(false)
  })
  it('attention (the default) adds needs-you moments but not finished runs', () => {
    expect(allowsNotice('attention', 'failure')).toBe(true)
    expect(allowsNotice('attention', 'attention')).toBe(true)
    expect(allowsNotice('attention', 'done')).toBe(false)
  })
  it('all includes finished runs', () => {
    expect(allowsNotice('all', 'done')).toBe(true)
  })
})

describe('planNotice', () => {
  const on = { notifications: 'attention' as const, notificationSound: true }
  it('a failure with the window focused: toast + beep, no system notification', () => {
    expect(planNotice(on, 'failure', true)).toEqual({ toast: true, system: false, beep: true })
  })
  it('a failure with the window in the background: toast + system notification (which carries the sound)', () => {
    expect(planNotice(on, 'failure', false)).toEqual({ toast: true, system: true, beep: false })
  })
  it('sound off never beeps', () => {
    expect(planNotice({ ...on, notificationSound: false }, 'attention', true)).toEqual({ toast: true, system: false, beep: false })
  })
  it('a finished run is only news when the window is elsewhere, and never beeps', () => {
    const all = { notifications: 'all' as const, notificationSound: true }
    expect(planNotice(all, 'done', true)).toEqual({ toast: false, system: false, beep: false })
    expect(planNotice(all, 'done', false)).toEqual({ toast: false, system: true, beep: false })
  })
  it('a silenced kind does nothing at all', () => {
    expect(planNotice({ notifications: 'failures', notificationSound: true }, 'attention', false)).toEqual({
      toast: false,
      system: false,
      beep: false
    })
  })
})
