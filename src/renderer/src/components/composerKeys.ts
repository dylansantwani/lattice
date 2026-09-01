import type { AppSettings } from '@shared/types'

/** What an Enter keypress in the composer should do, given the sendKey preference + modifiers. */
export type SendAction = 'send' | 'queue' | 'newline'

/** The subset of a keyboard event this decision depends on. */
export interface KeyMods {
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

/**
 * Resolve an Enter keypress to an action, honoring the sendKey preference:
 *  - 'enter'     → Enter sends; ⌘/Ctrl+Enter queues; Shift+Enter is a newline.
 *  - 'mod-enter' → ⌘/Ctrl+Enter sends; a bare Enter is a newline (Shift+Enter too).
 *
 * 'send' is the send chord (the caller turns it into a steer while a run is active); 'newline'
 * means "let the textarea insert a line break" — i.e. don't intercept the key.
 */
export function sendAction(sendKey: AppSettings['sendKey'], e: KeyMods): SendAction {
  const mod = e.metaKey || e.ctrlKey
  if (sendKey === 'mod-enter') return mod ? 'send' : 'newline'
  // 'enter' mode
  if (e.shiftKey) return 'newline'
  return mod ? 'queue' : 'send'
}
