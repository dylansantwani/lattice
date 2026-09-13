import { describe, expect, it } from 'vitest'
import { PermissionSpecError, parsePermissionSpec, parsePermissionSpecs } from './permissionSpec'

describe('parsePermissionSpec', () => {
  it('maps a scoped shell allowance to the persisted PermissionRule shape', () => {
    expect(parsePermissionSpec('shell:git *', 'allow', { createId: () => 'rule_1', now: () => 42 })).toEqual({
      id: 'rule_1', subject: 'main', resource: 'shell', action: 'execute', scope: 'git *',
      effect: 'allow', duration: 'thread', createdAt: 42
    })
  })

  it('maps filesystem and network tools without widening their resource/action', () => {
    expect(parsePermissionSpec('fs_write:src/**', 'deny', { now: () => 1 })).toMatchObject({
      resource: 'filesystem', action: 'create', scope: 'src/**', effect: 'deny', duration: 'thread'
    })
    expect(parsePermissionSpec('web_fetch', 'allow', { now: () => 1 })).toMatchObject({
      resource: 'network', action: 'read', effect: 'allow', duration: 'thread'
    })
  })

  it('supports MCP tool names while retaining the tool name as a broker scope', () => {
    expect(parsePermissionSpec('mcp__browser__navigate', 'allow', { now: () => 1 })).toMatchObject({
      resource: 'mcp', action: 'execute', scope: 'mcp__browser__navigate', effect: 'allow'
    })
  })

  it('produces MCP rules the run broker actually matches (resource + action + tool-name scope)', async () => {
    const { setThreadRules, threadRuleEffect } = await import('../main/runtime/approvals')
    const rule = parsePermissionSpec('mcp__latchkey__*', 'allow', { now: () => 1 })
    setThreadRules('t-mcp', [rule])
    // mirrors runManager: an MCP call is checked with the tool definition's resource/action and its name as scope
    expect(threadRuleEffect('t-mcp', 'mcp', 'execute', 'mcp__latchkey__latchkey_batch')).toBe('allow')
    expect(threadRuleEffect('t-mcp', 'mcp', 'execute', 'mcp__openbrowser__browser_act')).toBeUndefined()
    expect(parsePermissionSpec('find_mcp', 'allow', { now: () => 1 })).toMatchObject({ resource: 'mcp', action: 'read' })
  })

  it('allocates stable unique ids when parsing repeated flags together', () => {
    expect(parsePermissionSpecs(['shell:git *'], ['fs_delete:tmp/**'], { now: () => 1 }).map((rule) => rule.id)).toEqual([
      'cli-rule-0', 'cli-rule-1'
    ])
  })

  it.each(['', ' :x', 'shell:', 'does_not_exist', 'web_fetch:  '])('rejects invalid specs: %j', (spec) => {
    expect(() => parsePermissionSpec(spec, 'allow')).toThrow(PermissionSpecError)
  })
})
