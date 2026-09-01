import React, { useMemo, useState } from 'react'

export type DiffLine = { type: 'add' | 'del' | 'ctx'; text: string }

/**
 * Line-level diff via longest-common-subsequence. Inputs here are edit fragments
 * (old_string / new_string), so they're small — an O(n·m) DP is comfortable, and we
 * cap defensively for the rare large replacement.
 */
export function lineDiff(before: string, after: string, cap = 600): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length > cap || b.length > cap) {
    // Too big to diff cheaply — fall back to a whole-block replace view.
    return [
      ...a.map((text): DiffLine => ({ type: 'del', text })),
      ...b.map((text): DiffLine => ({ type: 'add', text }))
    ]
  }

  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]! })
      i++
    } else {
      out.push({ type: 'add', text: b[j]! })
      j++
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++]! })
  while (j < m) out.push({ type: 'add', text: b[j++]! })
  return out
}

/** A +green / −red unified diff, collapsed by default with an add/remove summary. */
export function FileDiff({
  path,
  before,
  after,
  kind
}: {
  path: string
  before: string
  after: string
  kind: 'edit' | 'write'
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const lines = useMemo(() => lineDiff(before, after), [before, after])
  const added = lines.filter((l) => l.type === 'add').length
  const removed = lines.filter((l) => l.type === 'del').length
  const name = path.split('/').pop() || path

  return (
    <div className="filediff">
      <button className="filediff-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="msym chev" style={{ fontSize: 16 }}>
          {open ? 'expand_more' : 'chevron_right'}
        </span>
        <span className="msym" style={{ fontSize: 15 }}>
          {kind === 'write' ? 'note_add' : 'edit_document'}
        </span>
        <span className="filediff-path" title={path}>
          {name}
        </span>
        <span className="filediff-stat">
          {added > 0 && <span className="add">+{added}</span>}
          {removed > 0 && <span className="del">−{removed}</span>}
        </span>
      </button>
      {open && (
        <div className="filediff-body">
          {lines.map((l, idx) => (
            <div key={idx} className={`dl ${l.type}`}>
              <span className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
              <span className="txt">{l.text || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
