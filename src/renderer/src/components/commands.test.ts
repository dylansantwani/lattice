import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMANDS, CATEGORY_ORDER, findCommand, filterCommands } from './commands'
import { useStore } from '@/state/store'

describe('command table — structural invariants', () => {
  it('every command is well-formed and in a known category', () => {
    for (const c of COMMANDS) {
      expect(c.name, `${c.name} name`).toMatch(/^[a-z][a-z-]*$/)
      expect(c.title, `${c.name} title`).toBeTruthy()
      expect(c.hint, `${c.name} hint`).toBeTruthy()
      expect(c.icon, `${c.name} icon`).toBeTruthy()
      expect(CATEGORY_ORDER, `${c.name} category`).toContain(c.category)
      expect(typeof c.run, `${c.name} run`).toBe('function')
    }
  })

  it('command names and aliases are unique and non-colliding', () => {
    const seen = new Set<string>()
    for (const c of COMMANDS) {
      for (const key of [c.name, ...(c.aliases ?? [])]) {
        expect(seen.has(key), `duplicate command key: ${key}`).toBe(false)
        seen.add(key)
      }
    }
  })
})

describe('findCommand', () => {
  it('resolves by name, case-insensitively', () => {
    expect(findCommand('goal')?.name).toBe('goal')
    expect(findCommand('GOAL')?.name).toBe('goal')
  })
  it('resolves by alias', () => {
    // `/auto` is aliased to `workspace`
    expect(findCommand('workspace')?.name).toBe('auto')
  })
  it('returns undefined for unknown names', () => {
    expect(findCommand('definitely-not-a-command')).toBeUndefined()
  })
})

describe('filterCommands ranking', () => {
  it('an exact name match ranks first', () => {
    expect(filterCommands('goal')[0]?.name).toBe('goal')
  })
  it('an empty query returns every available command', () => {
    const available = COMMANDS.filter((c) => c.available?.() ?? true).length
    expect(filterCommands('').length).toBe(available)
    expect(filterCommands('').length).toBeGreaterThan(0)
  })
  it('a no-match query returns nothing', () => {
    expect(filterCommands('zzzznope')).toEqual([])
  })
})

describe('command handlers reach the store', () => {
  // The handlers call `useStore.getState().<method>(...)`; stub those so we can assert the
  // wiring without a live main process. This is the exact path a `/` command runs through.
  const setGoal = vi.fn().mockResolvedValue(undefined)
  const send = vi.fn().mockResolvedValue(undefined)
  const setEffort = vi.fn()
  const flash = vi.fn()
  const setUi = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useStore.setState({
      setGoal,
      send,
      setEffort,
      flash,
      setUi,
      threads: [],
      activeThreadId: null
    } as never)
  })

  it('/goal <text> pins the goal and sends it as a message', async () => {
    await findCommand('goal')!.run('ship the redesign')
    expect(setGoal).toHaveBeenCalledWith('ship the redesign')
    expect(flash).toHaveBeenCalledWith('Goal set')
    // trimmed text is sent as a normal turn so the agent acts on it
    expect(send).toHaveBeenCalledWith({ text: 'ship the redesign', disposition: 'send' })
  })

  it('/goal with a blank arg clears the goal and sends nothing', async () => {
    await findCommand('goal')!.run('   ')
    expect(setGoal).toHaveBeenCalledWith('   ')
    expect(flash).toHaveBeenCalledWith('Goal cleared')
    expect(send).not.toHaveBeenCalled()
  })

  it('/think with a valid tier sets effort', () => {
    findCommand('think')!.run('high')
    expect(setEffort).toHaveBeenCalledWith('high')
    expect(flash).toHaveBeenCalledWith('Thinking effort → high')
  })

  it('/think with an unknown tier warns and does not set effort', () => {
    findCommand('think')!.run('turbo')
    expect(setEffort).not.toHaveBeenCalled()
    expect(flash).toHaveBeenCalledWith(expect.stringContaining('Unknown effort'), 'warn')
  })

  it('/theme with an unknown name warns', () => {
    findCommand('theme')!.run('chartreuse')
    expect(flash).toHaveBeenCalledWith(expect.stringContaining('Unknown theme'), 'warn')
  })

  it('/context opens the inspector on the context tab', () => {
    findCommand('context')!.run('')
    expect(setUi).toHaveBeenCalledWith({ inspectorOpen: true, inspectorTab: 'context' })
  })
})
