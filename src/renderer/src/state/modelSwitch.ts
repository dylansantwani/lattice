import type { ModelInfo } from '@shared/types'

/**
 * A deferred mid-chat model change awaiting the user's confirmation. Switching models mid-thread
 * re-sends the whole conversation to the new model (a fresh prompt-cache write, and possibly a
 * different context window / price), so the change is parked here until the user acknowledges it.
 */
export interface PendingModelSwitch {
  model: string
}

/** The implications of a pending switch, shown in the confirmation dialog. */
export interface ModelSwitchInfo {
  currentModel: string
  currentName: string
  targetModel: string
  targetName: string
  /** tokens of existing context that will be re-sent to the new model */
  contextTokens: number
  /** the new model's context window (0 when unknown) */
  targetContextLength: number
  /** whether the current context fits in the new model's window (true when the window is unknown) */
  fitsInTarget: boolean
  /** estimated USD to re-ingest the current context on the new model, when pricing is known */
  estInputCost?: number
}

/**
 * Warn only for a *real* mid-chat switch: a different model on a thread that already has history.
 * An empty thread has no context to carry over, and re-selecting the current model is a no-op, so
 * neither should interrupt the user with a dialog.
 */
export function shouldWarnModelSwitch(opts: {
  currentModel: string | undefined | null
  targetModel: string
  messageCount: number
}): boolean {
  const { currentModel, targetModel, messageCount } = opts
  if (!currentModel) return false
  if (currentModel === targetModel) return false
  return messageCount > 0
}

/** Compute the human-facing implications of switching the current thread to `targetModel`. */
export function computeModelSwitchInfo(opts: {
  currentModel: string
  currentName?: string
  targetModel: string
  target: ModelInfo | undefined
  contextTokens: number
}): ModelSwitchInfo {
  const { currentModel, targetModel, target, contextTokens } = opts
  const targetContextLength = target?.contextLength ?? 0
  const info: ModelSwitchInfo = {
    currentModel,
    currentName: opts.currentName ?? currentModel,
    targetModel,
    targetName: target?.name ?? targetModel,
    contextTokens,
    targetContextLength,
    // Unknown window (0) can't be judged — don't cry wolf about a fit we can't measure.
    fitsInTarget: targetContextLength === 0 ? true : contextTokens <= targetContextLength
  }
  const price = target?.pricing?.inputPerMTok
  if (typeof price === 'number' && price > 0 && contextTokens > 0) {
    info.estInputCost = (contextTokens / 1_000_000) * price
  }
  return info
}
