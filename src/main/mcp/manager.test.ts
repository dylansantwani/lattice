import { describe, expect, it } from 'vitest'
import { MCP_CALL_TIMEOUT_MS, mcpRequestOptions } from './manager'

describe('MCP request contract', () => {
  it('passes the caller abort signal and a bounded timeout to the SDK', () => {
    const controller = new AbortController()
    expect(mcpRequestOptions({ signal: controller.signal })).toEqual({ signal: controller.signal, timeout: MCP_CALL_TIMEOUT_MS })
    expect(MCP_CALL_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
