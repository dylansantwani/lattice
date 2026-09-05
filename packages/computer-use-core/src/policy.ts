/**
 * Policy: mode/risk/target decisions. Fail-closed everywhere — an unknown
 * action type is treated as focus-requiring, and background_assist NEVER
 * escalates a focus-requiring action into Takeover.
 */
import type { Action, ActionFailureStatus, Mode } from '@lattice/computer-use-protocol'
import { requiresFocus } from '@lattice/computer-use-protocol'

export interface PolicyAllow {
  allowed: true
}

export interface PolicyDeny {
  allowed: false
  status: ActionFailureStatus
  reason: string
  /** true = re-observe/route differently and the same intent may succeed. */
  recoverable: boolean
}

export type PolicyDecision = PolicyAllow | PolicyDeny

/**
 * Mode-vs-action check. This is the layer that turns `type_text` in
 * background_assist into a structured `needs_focus` result instead of letting
 * it silently become a global key injection.
 */
export function evaluateActionPolicy(action: Action, mode: Mode): PolicyDecision {
  if (requiresFocus(action, mode)) {
    return {
      allowed: false,
      status: 'needs_focus',
      reason:
        `Action "${action.type}" requires foreground focus, but the session mode is "${mode}". ` +
        'Background Assist never moves the physical pointer, never injects global input, and never ' +
        'escalates to takeover on its own. Use a semantic action (click_element, set_value, paste, ' +
        'select_text, secondary_action) or ask the user to focus the target explicitly.',
      recoverable: false
    }
  }
  return { allowed: true }
}
