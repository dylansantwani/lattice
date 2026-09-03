import React from 'react'
import { useStore } from '@/state/store'
import { I } from './Icon'

/**
 * Renders the transient `notice` set by `flash()` — the confirmation/warning feedback that slash
 * commands and other actions emit (e.g. "Goal set", "Theme → midnight", "Unknown effort"). The
 * store auto-clears it after a few seconds; this just mirrors it into a floating toast.
 */
export function Toast(): React.JSX.Element | null {
  const notice = useStore((s) => s.notice)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const selectThread = useStore((s) => s.selectThread)
  if (!notice) return null
  // A notice about another thread (a failure there, a question waiting) is a link to it.
  const jump = notice.threadId && notice.threadId !== activeThreadId ? notice.threadId : undefined
  const icon = notice.tone === 'error' ? 'error' : notice.tone === 'warn' ? 'warning' : 'check_circle'
  return (
    <div
      className={`toast toast-${notice.tone}${jump ? ' clickable' : ''}`}
      role={notice.tone === 'error' ? 'alert' : 'status'}
      aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
      onClick={jump ? () => void selectThread(jump) : undefined}
      title={jump ? 'Open that chat' : undefined}
    >
      <I name={icon} size={15} />
      <span>{notice.text}</span>
      {jump && <span className="toast-jump">Open →</span>}
    </div>
  )
}
