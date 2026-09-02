/**
 * Line diff for the Files inspector's session-diff view. Produces GitHub-style rows (context / added
 * / removed) with long unchanged stretches collapsed to a fold marker. Bounded so a large file never
 * blows up: common prefix/suffix are trimmed first, and the differing middle only runs a full LCS
 * when it is small — otherwise it degrades to "all removed, then all added", which is correct if
 * coarse. Kept separate from the transcript's inline `Diff.tsx` so the two can evolve independently.
 */

export type DiffRow =
  | { type: 'ctx'; text: string; a: number; b: number }
  | { type: 'add'; text: string; b: number }
  | { type: 'del'; text: string; a: number }
  | { type: 'fold'; count: number }

const LCS_LINE_CAP = 1500 // per side; above this the middle is diffed coarsely
const FOLD_MIN = 8 // collapse unchanged runs longer than this
const FOLD_KEEP = 3 // ...keeping this many lines of context on each edge

function splitLines(s: string): string[] {
  if (s === '') return []
  const lines = s.split('\n')
  // A trailing newline yields a final empty element; drop it so line counts read naturally.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Standard LCS backtrace over two line arrays → ordered rows, offset into the original files. */
function lcsRows(a: string[], b: string[], aBase: number, bBase: number): DiffRow[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'ctx', text: a[i]!, a: aBase + i, b: bBase + j })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ type: 'del', text: a[i]!, a: aBase + i })
      i++
    } else {
      rows.push({ type: 'add', text: b[j]!, b: bBase + j })
      j++
    }
  }
  while (i < n) rows.push({ type: 'del', text: a[i]!, a: aBase + i++ })
  while (j < m) rows.push({ type: 'add', text: b[j]!, b: bBase + j++ })
  return rows
}

/** Collapse runs of more than FOLD_MIN consecutive context rows into a fold marker. */
function foldContext(rows: DiffRow[]): DiffRow[] {
  const out: DiffRow[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i]!.type !== 'ctx') {
      out.push(rows[i]!)
      i++
      continue
    }
    let j = i
    while (j < rows.length && rows[j]!.type === 'ctx') j++
    const run = j - i
    if (run > FOLD_MIN) {
      for (let k = i; k < i + FOLD_KEEP; k++) out.push(rows[k]!)
      out.push({ type: 'fold', count: run - FOLD_KEEP * 2 })
      for (let k = j - FOLD_KEEP; k < j; k++) out.push(rows[k]!)
    } else {
      for (let k = i; k < j; k++) out.push(rows[k]!)
    }
    i = j
  }
  return out
}

export function lineDiff(before: string, after: string): DiffRow[] {
  const a = splitLines(before)
  const b = splitLines(after)

  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let sa = a.length
  let sb = b.length
  while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) {
    sa--
    sb--
  }

  const rows: DiffRow[] = []
  for (let k = 0; k < p; k++) rows.push({ type: 'ctx', text: a[k]!, a: k, b: k })

  const midA = a.slice(p, sa)
  const midB = b.slice(p, sb)
  if (midA.length <= LCS_LINE_CAP && midB.length <= LCS_LINE_CAP) {
    rows.push(...lcsRows(midA, midB, p, p))
  } else {
    for (let k = 0; k < midA.length; k++) rows.push({ type: 'del', text: midA[k]!, a: p + k })
    for (let k = 0; k < midB.length; k++) rows.push({ type: 'add', text: midB[k]!, b: p + k })
  }

  for (let k = 0; k < a.length - sa; k++) {
    rows.push({ type: 'ctx', text: a[sa + k]!, a: sa + k, b: sb + k })
  }
  return foldContext(rows)
}

/** Added / removed line counts for a change summary badge. */
export function diffStat(before: string | null, after: string | null): { added: number; removed: number } {
  const rows = lineDiff(before ?? '', after ?? '')
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.type === 'add') added++
    else if (r.type === 'del') removed++
  }
  return { added, removed }
}
