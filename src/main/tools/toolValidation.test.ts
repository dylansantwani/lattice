import { describe, expect, it } from 'vitest'
import { assertValidToolArguments, compileToolValidator, validateToolArguments } from './toolValidation'

describe('tool argument validation', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  it('reports required fields and types', () => {
    expect(validateToolArguments(schema, { path: 2 }).issues).toEqual([
      { path: '$.content', message: 'is required' },
      { path: '$.path', message: 'must be string' }
    ])
  })
  it('caches compiled validators by schema identity', () => expect(compileToolValidator(schema)).toBe(compileToolValidator(schema)))
  it('throws a concise field-level error', () => expect(() => assertValidToolArguments(schema, {})).toThrow(/\$\.path is required/))
})
