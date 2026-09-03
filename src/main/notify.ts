import { BrowserWindow, Notification, shell } from 'electron'
import type { PushEvent } from '@shared/ipc'
import type { AppSettings, ThreadId } from '@shared/types'
import { getSettings, getThreadMeta } from './store/eventStore'

/**
 * Making Lattice audible. A run that errors, a background job or subagent that fails, an approval
 * or a question waiting on the user, and (optionally) a run finishing while the window sits in the
 * background all used to be silent — a red card at the bottom of a thread the user had already
 * left. Every such moment now goes out three ways, each gated by Settings → General → Notifications:
 *  - an in-app toast (a `notice` push), colour-coded and clickable to jump to the thread;
 *  - a system notification when no Lattice window is focused (macOS plays its alert sound);
 *  - the system alert sound when a window IS focused, for failures and needs-you moments only.
 */

export type NoticeKind = 'failure' | 'attention' | 'done'

type PushFn = (event: PushEvent) => void

/** Which kinds a notifications setting lets through. Pure; exported for tests. */
export function allowsNotice(setting: AppSettings['notifications'], kind: NoticeKind): boolean {
  switch (setting) {
    case 'off':
      return false
    case 'failures':
      return kind === 'failure'
    case 'attention':
      return kind !== 'done'
    case 'all':
      return true
    default:
      return kind !== 'done'
  }
}

/**
 * Decide what a notice does given the settings and window focus. Pure; exported for tests.
 * `toast` — push an in-app toast; `system` — a system notification; `beep` — the alert sound.
 */
export function planNotice(
  settings: Pick<AppSettings, 'notifications' | 'notificationSound'>,
  kind: NoticeKind,
  windowFocused: boolean
): { toast: boolean; system: boolean; beep: boolean } {
  if (!allowsNotice(settings.notifications, kind)) return { toast: false, system: false, beep: false }
  // A finished run is only news when the window is elsewhere; the sidebar dot covers the in-app case.
  if (kind === 'done') return { toast: false, system: !windowFocused, beep: false }
  return {
    toast: true,
    system: !windowFocused,
    beep: windowFocused && settings.notificationSound
  }
}

function anyWindowFocused(): boolean {
  return BrowserWindow.getAllWindows().some((w) => w.isFocused())
}

/**
 * Raise a notice. `title` is the headline (the system notification's title, and the toast's lead);
 * `body` the detail. Never throws — a notification must not take a run down with it.
 */
export function notify(
  push: PushFn,
  notice: { kind: NoticeKind; title: string; body?: string; threadId?: ThreadId }
): void {
  try {
    const settings = getSettings()
    const focused = anyWindowFocused()
    const plan = planNotice(settings, notice.kind, focused)
    const thread = notice.threadId ? getThreadMeta(notice.threadId) : null
    const where = thread?.title ? ` — ${thread.title}` : ''
    const text = notice.body ? `${notice.title}: ${notice.body}` : notice.title
    if (plan.toast) {
      push({
        kind: 'notice',
        tone: notice.kind === 'failure' ? 'error' : notice.kind === 'attention' ? 'warn' : 'info',
        text: text.length > 240 ? `${text.slice(0, 239)}…` : text,
        threadId: notice.threadId
      })
    }
    if (plan.system && Notification.isSupported()) {
      const n = new Notification({
        title: `${notice.title}${where}`,
        body: notice.body ? (notice.body.length > 200 ? `${notice.body.slice(0, 199)}…` : notice.body) : '',
        silent: !settings.notificationSound
      })
      n.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        if (notice.threadId) push({ kind: 'notice', tone: 'info', text: '', threadId: notice.threadId })
      })
      n.show()
    }
    if (plan.beep) shell.beep()
  } catch {
    /* never let a notification break the run */
  }
}
