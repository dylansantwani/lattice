import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-agentmem-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from '../store/eventStore'
import * as agentStore from '../store/agents'
import { getDb, closeDb } from '../store/db'
import {
  appendChangeLogLine,
  applyWorkingMemoryEdit,
  archiveWorkingMemory,
  HARD_LIMIT,
  readWorkingMemory,
  SOFT_LIMIT,
  workingMemoryNote,
  workingMemoryPath,
  writeWorkingMemory
} from './agentMemory'

let wsId: string

beforeEach(() => {
  getDb().exec(
    'DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM fleets; DELETE FROM agent_profiles; DELETE FROM fleet_changes'
  )
  agentStore.resetAgentCache()
  rmSync(join(mockDataDir, 'data', 'agent-memory'), { recursive: true, force: true })
  wsId = store.updateWorkspace(store.ensureDefaultWorkspace().id, { roots: [mockDataDir] }).id
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

function fleet() {
  const fleetId = agentStore.createFleet({ workspaceId: wsId, name: 'Print Desk' }).id
  const lead = agentStore.createAgent({ fleetId, name: 'Lead', kind: 'orchestrator', model: 'm/x' }).profile
  const sourcer = agentStore.createAgent({ fleetId, name: 'Sourcer', kind: 'worker', model: 'm/x' }).profile
  return { fleetId, lead, sourcer }
}

const DOC = `# Lead — working memory

## Current focus
Knife stands.

## Lessons learned
- 2026-09-01 · use sold filter

## Open threads
- ask about budget
`

describe('applyWorkingMemoryEdit', () => {
  it('appends to the end of a section, before the next heading', () => {
    const res = applyWorkingMemoryEdit(DOC, { action: 'append', section: 'Lessons learned', text: '- 2026-09-02 · eBay blocks plain fetch; use latchkey' })
    expect('content' in res).toBe(true)
    const content = (res as { content: string }).content
    expect(content).toContain('- 2026-09-01 · use sold filter\n- 2026-09-02 · eBay blocks plain fetch; use latchkey\n\n## Open threads')
  })

  it('appends to the last section and creates a missing section at the end', () => {
    const last = applyWorkingMemoryEdit(DOC, { action: 'append', section: 'open threads', text: '- second' }) as { content: string }
    expect(last.content.endsWith('- ask about budget\n- second\n')).toBe(true)
    const created = applyWorkingMemoryEdit(DOC, { action: 'append', section: 'Agent notes', text: '- Sourcer: good at eBay' }) as { content: string }
    expect(created.content.endsWith('## Agent notes\n- Sourcer: good at eBay\n')).toBe(true)
  })

  it('matches a section by unique prefix and reports an ambiguous one', () => {
    const doc = `${DOC}\n## Lessons from users\n- x\n`
    expect(applyWorkingMemoryEdit(DOC, { action: 'append', section: 'Less', text: '- y' })).toHaveProperty('content')
    expect(applyWorkingMemoryEdit(doc, { action: 'append', section: 'Less', text: '- y' })).toHaveProperty('error')
  })

  it('replaces and removes a section', () => {
    const replaced = applyWorkingMemoryEdit(DOC, { action: 'replace_section', section: 'Current focus', text: 'Phone stands now.' }) as { content: string }
    expect(replaced.content).toContain('## Current focus\nPhone stands now.\n\n## Lessons learned')
    expect(replaced.content).not.toContain('Knife stands.')
    const removed = applyWorkingMemoryEdit(DOC, { action: 'remove_section', section: 'Open threads' }) as { content: string }
    expect(removed.content).not.toContain('Open threads')
    expect(applyWorkingMemoryEdit(DOC, { action: 'remove_section', section: 'Nope' })).toHaveProperty('error')
  })

  it('str_replace requires a unique exact match; rewrite replaces everything', () => {
    expect((applyWorkingMemoryEdit(DOC, { action: 'str_replace', old: 'Knife stands.', new: 'Mugs.' }) as { content: string }).content).toContain('Mugs.')
    expect(applyWorkingMemoryEdit(DOC, { action: 'str_replace', old: 'absent', new: 'x' })).toHaveProperty('error')
    expect(applyWorkingMemoryEdit(DOC, { action: 'str_replace', old: '##', new: 'x' })).toHaveProperty('error')
    expect((applyWorkingMemoryEdit(DOC, { action: 'rewrite', text: '# New\n\n\n' }) as { content: string }).content).toBe('# New\n')
    expect(applyWorkingMemoryEdit(DOC, { action: 'rewrite', text: '  ' })).toHaveProperty('error')
  })

  it('refuses an append with no text', () => {
    expect(applyWorkingMemoryEdit(DOC, { action: 'append', section: 'Lessons learned', text: '  ' })).toHaveProperty('error')
  })
})

describe('reading and writing', () => {
  it('keys the file by agent id under the app data dir and starts from a kind-specific template', () => {
    const { lead, sourcer } = fleet()
    const mem = readWorkingMemory(lead)
    expect(mem.path).toBe(join(mockDataDir, 'data', 'agent-memory', `${lead.id}.md`))
    expect(mem.exists).toBe(false)
    expect(mem.content).toContain('## Lessons learned')
    expect(mem.content).toContain('## Change log')
    expect(mem.content).toContain('(Print Desk)')
    expect(readWorkingMemory(sourcer).content).toContain('## How I do this job')
    expect(readWorkingMemory(sourcer).content).not.toContain('## Change log')
    expect(workingMemoryPath(lead)).not.toBe(workingMemoryPath(sourcer))
  })

  it('writes atomically, reads back, and refuses content past the hard limit', () => {
    const { lead } = fleet()
    const ok = writeWorkingMemory(lead, '# notes\r\n- one\n\n\n')
    expect(ok.ok).toBe(true)
    expect(readFileSync(workingMemoryPath(lead), 'utf8')).toBe('# notes\n- one\n')
    expect(readWorkingMemory(lead).exists).toBe(true)
    const tooBig = writeWorkingMemory(lead, 'x'.repeat(HARD_LIMIT + 1))
    expect(tooBig.ok).toBe(false)
    expect(readFileSync(workingMemoryPath(lead), 'utf8')).toBe('# notes\n- one\n')
  })

  it('archives a removed agent\'s notebook instead of deleting it', () => {
    const { sourcer } = fleet()
    expect(archiveWorkingMemory(sourcer)).toBeUndefined()
    writeWorkingMemory(sourcer, '# Sourcer\n- lesson')
    const archived = archiveWorkingMemory(sourcer)!
    expect(archived.content).toContain('- lesson')
    expect(archived.archivedTo).toContain(join('agent-memory', 'removed', `sourcer-${sourcer.id}.md`))
    expect(existsSync(archived.archivedTo)).toBe(true)
    expect(existsSync(workingMemoryPath(sourcer))).toBe(false)
  })
})

describe('appendChangeLogLine', () => {
  it('creates the notebook from the template and keeps only the newest 25 bullets', () => {
    const { lead } = fleet()
    appendChangeLogLine(lead, 'added Sourcer by user')
    let content = readWorkingMemory(lead).content
    expect(content).toMatch(/## Change log\n- \d{4}-\d\d-\d\d \d\d:\d\d · added Sourcer by user\n$/)
    for (let i = 0; i < 30; i++) appendChangeLogLine(lead, `change ${i}`)
    content = readWorkingMemory(lead).content
    const bullets = content.split('## Change log')[1]!.split('\n').filter((l) => l.startsWith('- '))
    expect(bullets).toHaveLength(25)
    expect(bullets.at(-1)).toContain('change 29')
    expect(content).not.toContain('added Sourcer by user')
    // the rest of the notebook survives
    expect(content).toContain('## Lessons learned')
  })

  it('adds a change log section to a hand-written notebook that has none', () => {
    const { lead } = fleet()
    writeWorkingMemory(lead, '# mine\n\n## Lessons learned\n- keep it')
    appendChangeLogLine(lead, 'updated Sourcer (role) by Lead — kept missing the sold filter')
    const content = readWorkingMemory(lead).content
    expect(content).toContain('## Lessons learned\n- keep it\n\n## Change log\n- ')
    expect(content).toContain('kept missing the sold filter')
  })
})

describe('workingMemoryNote', () => {
  it('is null for a thread that is not a fleet agent', () => {
    const plain = store.createThread({ workspaceId: wsId, title: 'plain', model: 'm/x' }).id
    expect(workingMemoryNote(plain)).toBeNull()
  })

  it('always shows an orchestrator its notebook (the starter layout before it writes one)', () => {
    const { lead } = fleet()
    const starter = workingMemoryNote(lead.threadId)!
    expect(starter).toContain('<working_memory>')
    expect(starter).toContain('starter layout')
    writeWorkingMemory(lead, '# Lead\n\n## Lessons learned\n- eBay blocks plain fetch')
    const note = workingMemoryNote(lead.threadId)!
    expect(note).toContain('- eBay blocks plain fetch')
    expect(note).toContain('as of the start of this run')
    expect(note).not.toContain('soft limit')
  })

  it('gives a worker a one-line pointer until it writes its notebook', () => {
    const { sourcer } = fleet()
    const pointer = workingMemoryNote(sourcer.threadId)!
    expect(pointer).not.toContain('<working_memory>')
    expect(pointer).toContain('working_memory(action:"append"')
    writeWorkingMemory(sourcer, '# Sourcer\n- use latchkey for eBay')
    expect(workingMemoryNote(sourcer.threadId)).toContain('- use latchkey for eBay')
  })

  it('tells the agent to condense past the soft limit, and clips a hand-edited file past the hard limit', () => {
    const { lead } = fleet()
    writeWorkingMemory(lead, `# Lead\n${'- lesson\n'.repeat(Math.ceil(SOFT_LIMIT / 9) + 10)}`)
    expect(workingMemoryNote(lead.threadId)).toContain('past the 12000 soft limit')
    const path = workingMemoryPath(lead)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'y'.repeat(HARD_LIMIT + 500))
    const note = workingMemoryNote(lead.threadId)!
    expect(note).toContain('clipped')
    expect(note.length).toBeLessThan(HARD_LIMIT + 1000)
  })
})
