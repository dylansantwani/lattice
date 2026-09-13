import { describe, expect, it } from 'vitest'
import {
  addsInformation,
  carriesMoreInformation,
  contentTokens,
  containsAsRewording,
  digest,
  findDuplicatePairs,
  isNearDuplicate,
  jaccard,
  similarity
} from './similarity'

const d = digest

describe('contentTokens', () => {
  it('drops stopwords, the generic subject, and punctuation', () => {
    expect([...contentTokens("The user's macOS username is dylan.")]).toEqual(['macos', 'username', 'dylan'])
  })
})

describe('isNearDuplicate — the live-store username cluster', () => {
  // Five rows the old containment check let through, none containing another verbatim.
  const variants = [
    "User's local username/home is dylan at /Users/dylan",
    "User's macOS username is dylan (home directory /Users/dylan).",
    "User's username on macOS is dylan (home directory /Users/dylan)",
    "User's macOS username is 'dylan' (home at /Users/dylan)",
    "User's macOS home directory is /Users/dylan"
  ]
  it('collapses every rewording of the same fact', () => {
    const base = d(variants[1]!)
    for (const v of variants.slice(2)) expect(isNearDuplicate(base, d(v))).toBe(true)
  })

  it('and the distiller’s "User…" / "The user…" subject flip', () => {
    expect(isNearDuplicate(d('User prefers terse answers'), d('The user prefers terse answers.'))).toBe(true)
  })

  it('keeps two distinct facts that merely share common words apart', () => {
    expect(isNearDuplicate(d('The user prefers tabs over spaces'), d('The user prefers dark themes over light'))).toBe(false)
    expect(isNearDuplicate(d('Uses zsh'), d('Uses vim'))).toBe(false)
  })

  it('keeps the two Bambu printer facts with different serials apart from a generic one', () => {
    const a = d('The user operates two Bambu A1 Combo printers (serials 03900D5B2907081 and 03919D561813616) in cloud mode')
    const b = d('Chronic print failures occur with battery-box socket models on both printers')
    expect(isNearDuplicate(a, b)).toBe(false)
  })
})

describe('containsAsRewording — blob immunity', () => {
  it('treats a short fact inside a comparable-length text as a rewording', () => {
    expect(containsAsRewording(d('prefers terse answers'), d('the user prefers terse answers, always'))).toBe(true)
  })

  it('never lets a document swallow a one-line fact it happens to contain', () => {
    const fact = 'Prefers terse answers'
    const doc = 'Claude Code global instructions:\n\n' + 'Lorem ipsum. '.repeat(200) + fact.toLowerCase() + ' and more. '.repeat(50)
    expect(containsAsRewording(d(fact), d(doc))).toBe(false)
    expect(isNearDuplicate(d(fact), d(doc))).toBe(false)
  })

  it('requires the contained side to be a real sentence', () => {
    expect(containsAsRewording(d('zsh'), d('uses zsh with oh-my-zsh'))).toBe(false)
  })
})

describe('jaccard / similarity', () => {
  it('is 0 for disjoint sets and 1 for identical text', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0)
    expect(similarity(d('Runs on macOS'), d('Runs on macOS'))).toBe(1)
    expect(jaccard(new Set(), new Set())).toBe(0)
  })
})

describe('carriesMoreInformation', () => {
  it('is true when the candidate is a strict superset of the existing tokens', () => {
    expect(
      carriesMoreInformation(d("The user's macOS username is dylan (home /Users/dylan)"), d("The user's macOS username is dylan"))
    ).toBe(true)
  })
  it('is false for a plain rewording of the same information', () => {
    expect(carriesMoreInformation(d("The user's username on macOS is dylan"), d("The user's macOS username is dylan"))).toBe(false)
  })
  it('is false when the candidate is shorter', () => {
    expect(carriesMoreInformation(d('Uses pnpm'), d('Uses pnpm as the package manager for every repo'))).toBe(false)
  })
  it('tolerates one dropped token when several are added', () => {
    expect(
      carriesMoreInformation(
        d('The user prefers pnpm workspaces with strict peer deps and frozen lockfiles'),
        d('The user prefers pnpm workspaces')
      )
    ).toBe(true)
  })
})

describe('addsInformation — corrections revise, subsets drop', () => {
  it('is true for a one-word correction of a near-duplicate (the quality-loss case)', () => {
    const stored = d('The user operates two Bambu A1 Combo printers in cloud mode')
    const corrected = d('The user operates two Bambu A1 Combo printers in LAN mode')
    expect(isNearDuplicate(stored, corrected)).toBe(true)
    expect(addsInformation(corrected, stored)).toBe(true)
  })
  it('is true for a refinement and false for a strict subset or pure rewording', () => {
    const stored = d("The user's macOS username is dylan")
    expect(addsInformation(d("The user's macOS username is dylan (home /Users/dylan)"), stored)).toBe(true)
    expect(addsInformation(d("The user's username on macOS is dylan"), stored)).toBe(false)
    expect(addsInformation(d('username dylan'), stored)).toBe(false)
    expect(addsInformation(d(''), stored)).toBe(false)
  })
})

describe('findDuplicatePairs', () => {
  it('returns every pair above the threshold, best first, and nothing for distinct items', () => {
    const items = [
      { id: '1', content: "User's macOS username is dylan (home /Users/dylan)" },
      { id: '2', content: "The user's username on macOS is dylan (home directory /Users/dylan)" },
      { id: '3', content: 'Deploys with electron-builder' }
    ]
    const pairs = findDuplicatePairs(items)
    expect(pairs).toHaveLength(1)
    expect([pairs[0]!.a.id, pairs[0]!.b.id]).toEqual(['1', '2'])
    expect(pairs[0]!.score).toBeGreaterThanOrEqual(0.6)
  })
})
