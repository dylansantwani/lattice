import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  PROTOCOL_VERSION,
  TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  ACTION_TYPES,
  ACTION_METADATA,
  MODE_POLICY,
  requiresFocus,
  isTerminalState,
  ACTIONABLE_STATES
} from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const examplesDir = join(here, '..', 'examples')
const schemaDir = join(here, '..', 'schema')

describe('schemas', () => {
  it('all schema files parse as valid JSON with required top-level fields', () => {
    const files = readdirSync(schemaDir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThanOrEqual(5)
    for (const f of files) {
      const doc = JSON.parse(readFileSync(join(schemaDir, f), 'utf8'))
      expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(doc.title).toBeTruthy()
      expect(doc.type).toBe('object')
    }
  })
})

describe('wire examples', () => {
  it('all example files parse as JSON', () => {
    const files = readdirSync(examplesDir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThanOrEqual(7)
    for (const f of files) {
      expect(() => JSON.parse(readFileSync(join(examplesDir, f), 'utf8'))).not.toThrow()
    }
  })

  it('session example matches protocol version and mode enum', () => {
    const s = JSON.parse(readFileSync(join(examplesDir, 'session.example.json'), 'utf8'))
    expect(s.protocol).toBe(PROTOCOL_VERSION)
    expect(MODE_POLICY[s.mode]).toBeDefined()
    expect(s.state).toBeTypeOf('string')
  })

  it('action examples reference known action types', () => {
    const click = JSON.parse(
      readFileSync(join(examplesDir, 'action.request.click_element.example.json'), 'utf8')
    )
    expect(ACTION_TYPES).toContain(click.action.type)
    expect(requiresFocus(click.action, 'background_assist')).toBe(false)

    const typeText = JSON.parse(
      readFileSync(join(examplesDir, 'action.request.type_text.example.json'), 'utf8')
    )
    expect(requiresFocus(typeText.action, 'background_assist')).toBe(true)
    expect(requiresFocus(typeText.action, 'takeover')).toBe(false)
  })

  it('stale result example matches the fail-result shape', () => {
    const r = JSON.parse(readFileSync(join(examplesDir, 'action.result.stale.example.json'), 'utf8'))
    expect(r.status).toBe('stale')
    expect(typeof r.reason).toBe('string')
  })
})

describe('contract constants', () => {
  it('every tool has a description', () => {
    for (const t of TOOL_NAMES) expect(TOOL_DESCRIPTIONS[t]).toBeTruthy()
  })

  it('every action type has metadata and an honest focus flag', () => {
    for (const a of ACTION_TYPES) {
      const meta = ACTION_METADATA[a]
      expect(meta).toBeDefined()
      expect(typeof meta.focusable).toBe('boolean')
      expect(typeof meta.semantic).toBe('boolean')
    }
  })

  it('unknown action types fail closed (focus required)', () => {
    expect(requiresFocus({ type: 'brand_new_thing' }, 'background_assist')).toBe(true)
  })

  it('mode policy: only background_assist is the default; takeover never implicit', () => {
    expect(MODE_POLICY.background_assist.default).toBe(true)
    expect(MODE_POLICY.shared_control.default).toBe(false)
    expect(MODE_POLICY.takeover.default).toBe(false)
    expect(MODE_POLICY.background_assist.mayMovePhysicalPointer).toBe(false)
    expect(MODE_POLICY.background_assist.mayInjectGlobalKeys).toBe(false)
    expect(isTerminalState('ended')).toBe(true)
    expect(isTerminalState('paused')).toBe(false)
    expect(ACTIONABLE_STATES.has('paused')).toBe(false)
  })
})
