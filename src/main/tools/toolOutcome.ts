export type ToolOutcomeStatus = 'ok' | 'error' | 'canceled' | 'partial' | 'no_match' | 'exit_nonzero' | 'unknown'

export interface NormalizedToolOutcome {
  ok: boolean
  status: ToolOutcomeStatus
  /** Original result, retained so existing callers can keep reading tool-specific fields. */
  result?: unknown
  error?: string
  canceled?: boolean
  diagnostics?: Record<string, unknown>
  [key: string]: unknown
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined

/** Normalize MCP and built-in result shapes without discarding the original payload. */
export function normalizeToolOutcome(value: unknown): NormalizedToolOutcome {
  const source = record(value)
  if (source?.isError === true) {
    return { ...source, ok: false, status: 'error', result: value, error: typeof source.error === 'string' ? source.error : 'Tool reported an error.' }
  }
  if (source?.canceled === true) return { ...source, ok: false, status: 'canceled', result: value, canceled: true }
  if (source?.timedOut === true) return { ...source, ok: false, status: 'error', result: value, error: 'Tool timed out.' }
  if (source?.partial === true) return { ...source, ok: true, status: 'partial', result: value }
  if (source?.noMatch === true || source?.status === 'no_match') return { ...source, ok: true, status: 'no_match', result: value }
  if (typeof source?.exitCode === 'number' && source.exitCode !== 0) return { ...source, ok: false, status: 'exit_nonzero', result: value }
  return { ...(source ?? {}), ok: true, status: 'ok', result: value }
}
