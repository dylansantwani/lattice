import type { ProviderConfig } from '@shared/types'

/**
 * Pick the model + provider for a housekeeping pass (memory distillation, auto-titling): the
 * configured utility model when it resolves to a provider, else the thread's own. A utility model
 * gets no forced reasoning tier (a non-reasoning model rejects `reasoning_effort` with a 400); the
 * thread model reuses the effort that just succeeded on the turn. Kept in its own module so the
 * run manager and the self-learning pass share it without either importing the other's surface.
 */
export function utilityRoute(
  threadModel: string,
  threadProvider: ProviderConfig | null,
  effort: string | undefined,
  resolveProvider: ((model: string) => ProviderConfig | null) | undefined,
  utilityModel: string | undefined
): { model: string; provider: ProviderConfig | null; effort: string | undefined } {
  const utility = (utilityModel ?? '').trim()
  if (utility && utility !== threadModel) {
    const provider = resolveProvider?.(utility) ?? null
    if (provider) return { model: utility, provider, effort: undefined }
  }
  return { model: threadModel, provider: threadProvider, effort }
}
