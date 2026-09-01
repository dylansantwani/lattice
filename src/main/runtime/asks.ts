import type { AskRequest, AskResponse } from '@shared/types'
import type { PushEvent } from '@shared/ipc'

/**
 * The ask broker. When the model calls the `ask_user` tool, the run manager parks
 * the call here: the question is pushed to the renderer, and the returned promise
 * resolves once the user answers (or the run is canceled while waiting).
 *
 * This mirrors the approval broker, but the payload is a free-form answer the model
 * reads back as the tool result, not an allow/deny decision.
 */

type PushFn = (event: PushEvent) => void

interface Pending {
  request: AskRequest
  settle: (response: AskResponse) => void
}

const pending = new Map<string, Pending>()

export function listPendingAsks(): AskRequest[] {
  return [...pending.values()].map((p) => p.request)
}

/**
 * Park a question awaiting the user's answer. Resolves with the answer, or a
 * canceled response if the run is aborted before the user responds.
 */
export function requestAsk(request: AskRequest, push: PushFn, signal: AbortSignal): Promise<AskResponse> {
  return new Promise<AskResponse>((resolve) => {
    let done = false
    const settle = (response: AskResponse): void => {
      if (done) return
      done = true
      pending.delete(request.id)
      signal.removeEventListener('abort', onAbort)
      resolve(response)
    }
    const onAbort = (): void => {
      push({ kind: 'ask.resolved', requestId: request.id })
      settle({ requestId: request.id, answer: '', canceled: true })
    }

    pending.set(request.id, { request, settle })
    push({ kind: 'ask.request', request })
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Called by the IPC layer when the user answers. Returns false if unknown/stale. */
export function resolveAsk(response: AskResponse, push: PushFn): boolean {
  const entry = pending.get(response.requestId)
  if (!entry) return false
  push({ kind: 'ask.resolved', requestId: response.requestId })
  entry.settle(response)
  return true
}
