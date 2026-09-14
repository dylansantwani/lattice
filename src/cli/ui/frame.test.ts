import { describe, expect, it } from 'vitest'
import { renderFrame } from './frame'

describe('terminal frame renderer', () => {
  it('wraps narrow content and keeps a stable composer/status footer', () => {
    const lines = renderFrame({
      header: 'workspace · src',
      blocks: [{ kind: 'assistant', text: 'one two three four five' }],
      todos: ['1 pending'],
      composer: 'continue',
      status: 'act · workspace',
      color: false
    }, 24)
    expect(lines).toEqual([
      'workspace · src',
      '⏺ one two three four',
      '⏺ five',
      '1 pending',
      '────────────────────────',
      '› continue',
      'act · workspace'
    ])
  })
})
