import React from 'react'
import { useStore } from '@/state/store'
import { I } from './Icon'

/**
 * Transient, self-clearing feedback for command actions (goal set, thread forked,
 * context compacted, an invalid argument, …). Driven by the store's `notice`/`flash`.
 */
export function Toast(): React.JSX.Element | null {
  const notice = useStore((s) => s.notice)
  if (!notice) return null
  return (
    <div className="toast-layer" aria-live="polite">
      <div className={`toast ${notice.tone}`} role="status">
        <I name={notice.tone === 'warn' ? 'warning' : 'check_circle'} size={16} />
        <span>{notice.text}</span>
      </div>
    </div>
  )
}
