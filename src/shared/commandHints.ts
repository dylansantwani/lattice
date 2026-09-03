/**
 * The last stage of a pipeline that swallows its input until EOF — nothing reaches the live
 * output (or `job_status`) until the whole command finishes. `cmd | tail -60` was the live case:
 * a ten-minute sweep whose "live output" stayed empty the entire time. Returns the offending
 * program name, or null when the command streams normally.
 */
export function bufferedByPipe(command: string): string | null {
  const stages = command.split(/\|\|?/).map((s) => s.trim())
  if (stages.length < 2) return null
  const last = stages[stages.length - 1] ?? ''
  const m = /^(?:\S*\/)?(tail|head|sort|uniq|wc|column|less|more|sponge|tac|rev)\b/.exec(last)
  return m ? m[1]! : null
}
