import { describe, expect, it } from 'vitest'
import { extractDeterministic, isFragment, RULE_MAX_DRAFTS } from './selfLearnRules'

const t = (...lines: string[]) => lines.join('\n')

describe('extractDeterministic', () => {
  it('captures an explicit remember-this statement as a preference', () => {
    const out = extractDeterministic(
      t('User: remember that I always want tests run before you say something works', 'Assistant: Noted.')
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('preference')
    expect(out[0]!.confidence).toBeGreaterThanOrEqual(0.9)
    expect(out[0]!.content).toMatch(/tests run/i)
  })

  it('captures a durable environment fact with a path or port', () => {
    const out = extractDeterministic(
      t('Assistant: The gateway listens on port 20128 and the store lives at /Users/dylan/.lattice/memory-tombstones')
    )
    expect(out.some((d) => d.type === 'environment')).toBe(true)
    expect(out[0]!.content).toMatch(/20128|\.lattice/)
  })

  it('captures a gotcha as a warning', () => {
    const out = extractDeterministic(
      t('Assistant: Relaunching the app silently does nothing, because the running process keeps the old bundle in memory.')
    )
    expect(out[0]!.type).toBe('warning')
  })

  it('turns a real command sequence into a workflow with steps and gotchas', () => {
    const out = extractDeterministic(
      t(
        'User: ship it',
        'Assistant: Rebuild and install a code change',
        '  pnpm build',
        '  pnpm package',
        '  ditto release/mac-arm64/Lattice.app /Applications/Lattice.app.new',
        '  codesign -dvv /Applications/Lattice.app',
        'Gotcha: relaunching does not install a new bundle, so quit and reopen afterwards.'
      )
    )
    const wf = out.find((d) => d.type === 'workflow')
    expect(wf).toBeTruthy()
    expect(wf!.content).toMatch(/\*\*Steps\*\*/)
    expect(wf!.content).toMatch(/1\. `pnpm build`/)
    expect(wf!.content).toMatch(/\*\*Gotchas\*\*/)
    expect(wf!.content.length).toBeLessThanOrEqual(600)
  })

  it('ignores a single command (not a procedure)', () => {
    const out = extractDeterministic(t('Assistant: Run `pnpm test` when you are done.'))
    expect(out.some((d) => d.type === 'workflow')).toBe(false)
  })

  it('returns nothing for chatter', () => {
    expect(extractDeterministic(t('User: thanks', 'Assistant: You are welcome!'))).toHaveLength(0)
  })

  it('caps and dedupes what one run may add', () => {
    const out = extractDeterministic(
      t(
        'User: remember that I never want emoji in commit messages',
        'User: remember that I never want emoji in commit messages',
        'User: always run the linter before committing any change',
        'User: from now on keep the changelog updated for every release',
        'User: make sure every migration has a rollback path before merging'
      )
    )
    expect(out.length).toBeLessThanOrEqual(RULE_MAX_DRAFTS)
    const contents = out.map((d) => d.content.toLowerCase())
    expect(new Set(contents).size).toBe(contents.length)
  })

  it('does not turn the user\'s own bug report into a warning', () => {
    // Captured verbatim from the live store before the speaker gate existed.
    const out = extractDeterministic(
      t('User: some doesnt work eg could not close watch http 501. also its too big theres space where it should just be in the top right', 'Assistant: On it.')
    )
    expect(out.some((d) => d.type === 'warning')).toBe(false)
  })

  it('only the assistant states decisions, warnings, and environment facts', () => {
    const out = extractDeterministic(
      t(
        'User: the gateway listens on port 20128 and I think we should go with sqlite',
        'Assistant: Understood. The gateway listens on port 20128 and the store lives at /Users/dylan/.lattice.'
      )
    )
    expect(out.every((d) => d.type === 'environment')).toBe(true)
    expect(out).toHaveLength(1)
  })

  it('drops fragments that cannot stand alone: lead-ins, questions, pronoun subjects, markup', () => {
    expect(isFragment('Three places now explain themselves instead of throwing a status code:')).toBe(true)
    expect(isFragment("It's also the escape hatch for a wedged session because the API stays answerable")).toBe(true)
    expect(isFragment('Does relaunching the app silently do nothing here?')).toBe(true)
    expect(isFragment('| col | col | ---- | ---- | 1 | 2 |')).toBe(true)
    expect(isFragment('Relaunching the app silently does nothing, because the running process keeps the old bundle.')).toBe(false)
    const out = extractDeterministic(t("Assistant: It's also the case that this silently breaks when the port is busy:"))
    expect(out).toHaveLength(0)
  })

  it('strips bold markup from a captured sentence', () => {
    const out = extractDeterministic(t('Assistant: The **watchdog** silently breaks when /tmp/lattice-lock is left behind after a crash.'))
    expect(out[0]!.content).not.toContain('**')
    expect(out[0]!.content).toContain('watchdog')
  })
})
