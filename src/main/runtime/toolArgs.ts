import { coerceToolArgs } from '../providers/openaiCompat'

/**
 * The argument text a tool call is EXECUTED with. Valid or repairable JSON runs as the coerced
 * object (identical to what the wire carries). An unrecoverable buffer that still has content is
 * passed through raw so `executeToolCall` fails on the model's actual text — the parse error then
 * names the real defect. An empty buffer executes as `{}` (the model truly sent nothing; schema
 * validation's "required" message is honest there).
 */
export function executableToolArgs(raw: string): string {
  const coerced = coerceToolArgs(raw)
  return coerced.kind === 'unrecoverable' && raw.trim() !== '' ? raw : coerced.text
}

const UNPARSEABLE_TAIL_CHARS = 160

/**
 * Denial text for a call whose arguments were not a JSON object. Carries the parser's own message
 * (which for JSON.parse includes the failing position), the size, and the TAIL of what the model
 * sent — the defect in every observed case (a brace-short nested batch) sits in the last few bytes.
 * Ends with a corrective instruction so the model re-issues the call instead of re-sending it.
 */
export function describeUnparseableArgs(name: string, rawArgs: string, err: unknown): string {
  // coerceToolArgs' issue carries the parser message PLUS the bracket fault when there is one.
  const coerced = coerceToolArgs(rawArgs)
  const why = coerced.kind === 'unrecoverable' && coerced.issue ? coerced.issue : err instanceof Error ? err.message : String(err)
  const trimmed = rawArgs.trim()
  const tail = trimmed.length > UNPARSEABLE_TAIL_CHARS ? `…${trimmed.slice(-UNPARSEABLE_TAIL_CHARS)}` : trimmed
  return (
    `Invalid arguments for ${name}: the arguments you sent were not a valid JSON object (${why}). ` +
    `Received ${trimmed.length} characters ending in: ${tail} ` +
    `Re-issue the call with balanced, complete JSON — check that every nested object and array is closed.`
  )
}
