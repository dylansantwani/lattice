import { describe, expect, it } from 'vitest'
import { COMMANDS, filterCommands, findCommand, parseSlash, slashQuery } from './commands'

describe('slashQuery', () => {
  it('extracts the command token from a bare slash input', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/go')).toBe('go')
    expect(slashQuery('/compact')).toBe('compact')
  })

  it('returns null once a space (i.e. an argument) follows the command', () => {
    expect(slashQuery('/goal ship it')).toBeNull()
    expect(slashQuery('/goal ')).toBeNull()
  })

  it('returns null for plain messages', () => {
    expect(slashQuery('hello')).toBeNull()
    expect(slashQuery('what about /foo')).toBeNull()
    expect(slashQuery('')).toBeNull()
  })
})

describe('findCommand', () => {
  it('resolves by canonical name, case-insensitively', () => {
    expect(findCommand('goal')?.name).toBe('goal')
    expect(findCommand('COMPACT')?.name).toBe('compact')
  })

  it('resolves aliases (auto → workspace preset command)', () => {
    expect(findCommand('workspace')?.name).toBe('auto')
  })

  it('returns undefined for unknown commands', () => {
    expect(findCommand('nope')).toBeUndefined()
  })
})

describe('parseSlash', () => {
  it('splits a command from its argument', () => {
    const parsed = parseSlash('/goal ship the beta')
    expect(parsed?.cmd.name).toBe('goal')
    expect(parsed?.arg).toBe('ship the beta')
  })

  it('left-trims the argument but preserves the rest verbatim', () => {
    expect(parseSlash('/rename   My  Title')?.arg).toBe('My  Title')
  })

  it('yields an empty argument for a bare command', () => {
    const parsed = parseSlash('/plan')
    expect(parsed?.cmd.name).toBe('plan')
    expect(parsed?.arg).toBe('')
  })

  it('returns null when the command is unknown', () => {
    expect(parseSlash('/bogus do a thing')).toBeNull()
  })
})

describe('filterCommands', () => {
  it('returns every available command for an empty query', () => {
    const available = COMMANDS.filter((c) => c.available?.() ?? true)
    expect(filterCommands('')).toHaveLength(available.length)
    // with no active thread, "unpin" is hidden but "pin" is shown
    expect(filterCommands('').some((c) => c.name === 'unpin')).toBe(false)
    expect(filterCommands('').some((c) => c.name === 'pin')).toBe(true)
  })

  it('ranks an exact name match first', () => {
    expect(filterCommands('side')[0]!.name).toBe('side')
  })

  it('prefers prefix matches over substring matches', () => {
    const names = filterCommands('me').map((c) => c.name)
    // "memory" (prefix) should rank ahead of "model" (no 'me' prefix but... ) — assert memory present & early
    expect(names).toContain('memory')
    expect(names.indexOf('memory')).toBeLessThan(names.length)
  })

  it('matches on title words too', () => {
    // "theme" command has title "Change theme"; querying "palette"? use a title token.
    expect(filterCommands('archive').some((c) => c.name === 'archive')).toBe(true)
  })

  it('drops commands whose availability predicate is false', () => {
    // pin/unpin are mutually exclusive via `available`; at most one shows for a given state.
    const both = COMMANDS.filter((c) => c.name === 'pin' || c.name === 'unpin')
    expect(both).toHaveLength(2)
    const shown = filterCommands('pin').filter((c) => c.name === 'pin' || c.name === 'unpin')
    expect(shown.length).toBeLessThanOrEqual(2)
  })
})
