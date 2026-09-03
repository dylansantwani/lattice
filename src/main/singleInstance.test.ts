import { describe, expect, it, vi } from 'vitest'
import {
  claimSingleInstance,
  TAKEOVER_POLL_MS,
  TAKEOVER_TIMEOUT_MS,
  YIELD_FORCE_EXIT_MS,
  type SingleInstanceApp
} from './singleInstance'

/** A fake `app` whose lock answers are scripted; records quit/exit and the second-instance handler. */
function fakeApp(lockAnswers: boolean[]): SingleInstanceApp & {
  requests: number
  quit: ReturnType<typeof vi.fn>
  exit: ReturnType<typeof vi.fn>
  fireSecondInstance: () => void
} {
  let listener: (() => void) | undefined
  const app = {
    requests: 0,
    requestSingleInstanceLock: () => {
      const answer = lockAnswers[Math.min(app.requests, lockAnswers.length - 1)]!
      app.requests += 1
      return answer
    },
    on: (_: 'second-instance', l: () => void) => {
      listener = l
    },
    quit: vi.fn(),
    exit: vi.fn(),
    fireSecondInstance: () => listener?.()
  }
  return app
}

const noSleep = async (): Promise<void> => {}

describe('claimSingleInstance — production', () => {
  it('boots when it gets the lock and focuses the window on a later launch', async () => {
    const app = fakeApp([true])
    const focus = vi.fn()
    await expect(claimSingleInstance(app, { isDev: false, onSecondInstance: focus })).resolves.toBe('primary')
    app.fireSecondInstance()
    expect(focus).toHaveBeenCalledOnce()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('quits immediately when another instance owns the app', async () => {
    const app = fakeApp([false])
    await expect(claimSingleInstance(app, { isDev: false })).resolves.toBe('quit')
    expect(app.requests).toBe(1) // no retry loop in production
  })
})

describe('claimSingleInstance — dev takeover', () => {
  it('keeps asking until the old instance releases the lock, then boots', async () => {
    const app = fakeApp([false, false, false, true])
    const sleep = vi.fn(noSleep)
    await expect(claimSingleInstance(app, { isDev: true, sleep })).resolves.toBe('primary')
    expect(app.requests).toBe(4)
    expect(sleep).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledWith(TAKEOVER_POLL_MS)
  })

  it('the old instance yields on second-instance: quit now, force-exit as a backstop', async () => {
    const app = fakeApp([true])
    const timers: { fn: () => void; ms: number }[] = []
    await claimSingleInstance(app, { isDev: true, setTimer: (fn, ms) => timers.push({ fn, ms }) })
    app.fireSecondInstance()
    expect(app.quit).toHaveBeenCalledOnce()
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(YIELD_FORCE_EXIT_MS)
    expect(app.exit).not.toHaveBeenCalled()
    timers[0]!.fn()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('gives up waiting after the timeout and boots anyway rather than dying', async () => {
    const app = fakeApp([false])
    let clock = 0
    const sleep = async (ms: number): Promise<void> => {
      clock += ms
    }
    await expect(claimSingleInstance(app, { isDev: true, sleep, now: () => clock })).resolves.toBe('primary')
    expect(clock).toBeGreaterThanOrEqual(TAKEOVER_TIMEOUT_MS)
    expect(app.quit).not.toHaveBeenCalled()
  })
})
