/**
 * Single-instance policy.
 *
 * Production: the standard Electron contract — a second launch hands off to the running instance
 * (which focuses its window) and exits.
 *
 * Development: the NEWER instance wins. `electron-vite dev --watch` spawns a fresh Electron for
 * every main-process rebuild and `kill()`s the previous one, but on macOS that kill does not take
 * the old app down, so windows stacked up — each running the main code it started with. Observed
 * on 2026-09-02: three live Lattice instances, the person typing into the oldest, so a fix that
 * had been in the tree for an hour "kept not working". Here the old instance yields as soon as a
 * newer one announces itself (`second-instance`), and the newcomer waits for the lock to free
 * before it boots — so at any moment exactly one instance, on the newest code, is running.
 *
 * The Electron `app` is abstracted behind {@link SingleInstanceApp} so the policy is unit-testable.
 */

export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean
  on(event: 'second-instance', listener: () => void): unknown
  quit(): void
  exit(code?: number): void
}

export interface ClaimOptions {
  isDev: boolean
  /** Production only: what to do when another launch hands off to us (focus the window). */
  onSecondInstance?: () => void
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => void
}

/** How often the dev newcomer re-tries the lock while the old instance shuts down. */
export const TAKEOVER_POLL_MS = 150
/** Give up waiting and boot anyway after this long (an old instance wedged in its quit path). */
export const TAKEOVER_TIMEOUT_MS = 8000
/** A yielding dev instance that has not exited by now is force-exited. */
export const YIELD_FORCE_EXIT_MS = 3000

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const defaultTimer = (fn: () => void, ms: number): void => {
  const t = setTimeout(fn, ms)
  ;(t as { unref?: () => void }).unref?.()
}

/**
 * Claim the single-instance lock. Resolves `'primary'` when this process should boot and `'quit'`
 * when it should exit because another instance already owns the app (production only — a dev
 * newcomer never quits; it takes over).
 */
export async function claimSingleInstance(
  application: SingleInstanceApp,
  opts: ClaimOptions
): Promise<'primary' | 'quit'> {
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const setTimer = opts.setTimer ?? defaultTimer

  let held = application.requestSingleInstanceLock()
  if (!held) {
    if (!opts.isDev) return 'quit'
    // Each failed request also notifies the holder (`second-instance`), which is what tells the
    // old dev instance to yield. Keep asking until its exit releases the lock.
    const deadline = now() + TAKEOVER_TIMEOUT_MS
    while (!held && now() < deadline) {
      await sleep(TAKEOVER_POLL_MS)
      held = application.requestSingleInstanceLock()
    }
    if (!held) {
      console.error('[app] previous dev instance did not release the single-instance lock; booting alongside it')
      return 'primary'
    }
    console.error('[app] took over from the previous dev instance')
  }

  application.on('second-instance', () => {
    if (opts.isDev) {
      console.error('[app] a newer dev instance launched — yielding to it')
      application.quit()
      setTimer(() => application.exit(0), YIELD_FORCE_EXIT_MS)
      return
    }
    opts.onSecondInstance?.()
  })
  return 'primary'
}
