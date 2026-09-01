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
  if (!notice) return null
  return (
    <div className={`toast toast-${notice.tone}`} role="status" aria-live="polite">
      <I name={notice.tone === 'warn' ? 'warning' : 'check_circle'} size={15} />
      <span>{notice.text}</span>
    </div>
  )
}
