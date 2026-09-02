import { describe, expect, it } from 'vitest'
import { lineDiff, diffStat, type DiffRow } from './filesDiff'

const texts = (rows: DiffRow[], type: DiffRow['type']): string[] =>
  rows.filter((r) => r.type === type).map((r) => (r as { text: string }).text)

describe('lineDiff', () => {
  it('marks only the changed line, keeping surrounding lines as context', () => {
    const before = 'a\nb\nc'
    const after = 'a\nB\nc'
    const rows = lineDiff(before, after)
    expect(texts(rows, 'del')).toEqual(['b'])
    expect(texts(rows, 'add')).toEqual(['B'])
    expect(texts(rows, 'ctx')).toEqual(['a', 'c'])
  })

  it('reports pure additions and deletions', () => {
    expect(diffStat('', 'x\ny\nz')).toEqual({ added: 3, removed: 0 })
    expect(diffStat('x\ny\nz', '')).toEqual({ added: 0, removed: 3 })
  })

  it('is empty (all context) for identical content', () => {
    const rows = lineDiff('same\ntext', 'same\ntext')
    expect(rows.every((r) => r.type === 'ctx')).toBe(true)
    expect(diffStat('same\ntext', 'same\ntext')).toEqual({ added: 0, removed: 0 })
  })

  it('collapses a long unchanged run into a fold marker', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const before = lines.join('\n')
    const after = ['CHANGED', ...lines.slice(1)].join('\n')
    const rows = lineDiff(before, after)
    const fold = rows.find((r) => r.type === 'fold')
    expect(fold).toBeDefined()
    // The change is preserved even though the long tail of identical lines is folded away.
    expect(texts(rows, 'add')).toContain('CHANGED')
    expect(rows.length).toBeLessThan(lines.length)
  })

  it('diffs a large change coarsely without hanging (all-removed then all-added)', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 4000 }, (_, i) => `new ${i}`).join('\n')
    const start = Date.now()
    const { added, removed } = diffStat(before, after)
    expect(Date.now() - start).toBeLessThan(500)
    expect(added).toBe(4000)
    expect(removed).toBe(4000)
  })
})
