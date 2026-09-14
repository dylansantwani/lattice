const CLEAR_LINE = '\u001b[2K'

/** Render only changed lines in a live region; unchanged frames produce no terminal writes. */
export function diffLines(previous: readonly string[], next: readonly string[]): string {
  if (previous.length === next.length && previous.every((line, index) => line === next[index])) return ''
  const out: string[] = []
  const rows = Math.max(previous.length, next.length)
  for (let index = 0; index < rows; index += 1) {
    const line = next[index] ?? ''
    if (line === previous[index]) continue
    if (index > 0) out.push(`\u001b[${rows - index}A`)
    out.push(CLEAR_LINE, line)
    if (index < rows - 1) out.push(`\u001b[${rows - index}B`)
  }
  return out.join('')
}

export const renderDiff = diffLines
