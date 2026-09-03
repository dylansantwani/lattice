import { describe, expect, it } from 'vitest'
import type { ThreadMeta } from '@shared/types'
import type { ToolDefinition } from '../tools/types'
import { toolEffect } from './runManager'
import { builtinTools } from '../tools/builtin'

const tool = (over: Partial<ToolDefinition>): ToolDefinition =>
  ({
    name: 'x',
    description: '',
    parameters: {},
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: () => '',
    run: async () => ({}),
    ...over
  }) as ToolDefinition

const meta = (over: Partial<ThreadMeta>): ThreadMeta =>
  ({ mode: 'act', permissionPreset: 'workspace', ...over }) as ThreadMeta

const read = tool({ resource: 'filesystem', action: 'read', riskTier: 'R0' })
const write = tool({ resource: 'filesystem', action: 'create', riskTier: 'R1' })
const del = tool({ resource: 'filesystem', action: 'delete', riskTier: 'R2' })
const shell = tool({ resource: 'shell', action: 'execute', riskTier: 'R2', allowedInPlan: false })
const mcp = tool({ resource: 'mcp', action: 'execute', riskTier: 'R1', mcpServerId: 'srv' })

describe('toolEffect — Auto (workspace) preset', () => {
  const auto = meta({ permissionPreset: 'workspace' })
  it('runs reads and workspace writes freely', () => {
    expect(toolEffect(read, auto)).toBe('allow')
    expect(toolEffect(write, auto)).toBe('allow')
  })
  it('asks before the shell and destructive file ops', () => {
    expect(toolEffect(shell, auto)).toBe('ask')
    expect(toolEffect(del, auto)).toBe('ask')
  })
  it('asks before MCP tools', () => {
    expect(toolEffect(mcp, auto)).toBe('ask')
  })
})

describe('toolEffect — Full preset', () => {
  const full = meta({ permissionPreset: 'full' })
  it('runs everything freely, no prompts', () => {
    expect(toolEffect(shell, full)).toBe('allow')
    expect(toolEffect(del, full)).toBe('allow')
    expect(toolEffect(mcp, full)).toBe('allow')
  })
})

describe('toolEffect — Manual preset', () => {
  const manual = meta({ permissionPreset: 'manual' })
  it('allows only read-only R0, denies the rest', () => {
    expect(toolEffect(read, manual)).toBe('allow')
    expect(toolEffect(write, manual)).toBe('deny')
    expect(toolEffect(shell, manual)).toBe('deny')
  })
})

describe('toolEffect — ask_user', () => {
  // ask_user is how the model talks to the person driving it, never a gated side effect.
  const ask = tool({ name: 'ask_user', resource: 'external_action', action: 'read', riskTier: 'R0' })
  it('is always allowed, in every preset and restrictive mode', () => {
    expect(toolEffect(ask, meta({ permissionPreset: 'manual' }))).toBe('allow')
    expect(toolEffect(ask, meta({ permissionPreset: 'workspace' }))).toBe('allow')
    expect(toolEffect(ask, meta({ permissionPreset: 'full' }))).toBe('allow')
    expect(toolEffect(ask, meta({ mode: 'review', permissionPreset: 'manual' }))).toBe('allow')
    expect(toolEffect(ask, meta({ mode: 'plan', permissionPreset: 'manual' }))).toBe('allow')
  })
})

describe('toolEffect — set_thread_title', () => {
  // Renaming the current chat is cosmetic self-management, allowed everywhere like ask_user —
  // even though it is an `edit`, which would otherwise be denied in review/manual.
  const rename = tool({ name: 'set_thread_title', resource: 'filesystem', action: 'edit', riskTier: 'R0' })
  it('is always allowed, in every preset and restrictive mode', () => {
    expect(toolEffect(rename, meta({ permissionPreset: 'manual' }))).toBe('allow')
    expect(toolEffect(rename, meta({ permissionPreset: 'workspace' }))).toBe('allow')
    expect(toolEffect(rename, meta({ permissionPreset: 'full' }))).toBe('allow')
    expect(toolEffect(rename, meta({ mode: 'review', permissionPreset: 'manual' }))).toBe('allow')
    expect(toolEffect(rename, meta({ mode: 'plan', permissionPreset: 'manual' }))).toBe('allow')
  })
})

describe('toolEffect — fetch_image (real builtin, network R1 read)', () => {
  const fetchImage = builtinTools.find((t) => t.name === 'fetch_image')!
  it('asks under Auto (workspace), same as any other non-R0 side effect', () => {
    expect(toolEffect(fetchImage, meta({ permissionPreset: 'workspace' }))).toBe('ask')
  })
  it('is denied under Manual (only R0 reads pass)', () => {
    expect(toolEffect(fetchImage, meta({ permissionPreset: 'manual' }))).toBe('deny')
  })
  it('is denied in Review mode (only R0 reads pass, regardless of preset)', () => {
    expect(toolEffect(fetchImage, meta({ mode: 'review', permissionPreset: 'full' }))).toBe('deny')
  })
  it('is denied in Plan mode (not allowedInPlan — a network fetch is a real side effect)', () => {
    expect(toolEffect(fetchImage, meta({ mode: 'plan', permissionPreset: 'full' }))).toBe('deny')
  })
  it('is allowed under Full, no prompt', () => {
    expect(toolEffect(fetchImage, meta({ permissionPreset: 'full' }))).toBe('allow')
  })
})

describe('toolEffect — web search/fetch (real builtins, network R1 read)', () => {
  const webSearch = builtinTools.find((t) => t.name === 'web_search')!
  const webFetch = builtinTools.find((t) => t.name === 'web_fetch')!
  it('asks under Auto (workspace)', () => {
    expect(toolEffect(webSearch, meta({ permissionPreset: 'workspace' }))).toBe('ask')
    expect(toolEffect(webFetch, meta({ permissionPreset: 'workspace' }))).toBe('ask')
  })
  it('requires Full access and is not available in Plan/Review/Manual', () => {
    for (const tool of [webSearch, webFetch]) {
      expect(toolEffect(tool, meta({ permissionPreset: 'manual' }))).toBe('deny')
      expect(toolEffect(tool, meta({ mode: 'plan', permissionPreset: 'full' }))).toBe('deny')
      expect(toolEffect(tool, meta({ mode: 'review', permissionPreset: 'full' }))).toBe('deny')
      expect(toolEffect(tool, meta({ permissionPreset: 'full' }))).toBe('allow')
    }
  })
})

describe('toolEffect — show_image / show_image_data (real builtins, filesystem R0 read)', () => {
  const showImage = builtinTools.find((t) => t.name === 'show_image')!
  const showImageData = builtinTools.find((t) => t.name === 'show_image_data')!
  it('runs freely everywhere a plain read does, including Review and Plan', () => {
    for (const t of [showImage, showImageData]) {
      expect(toolEffect(t, meta({ permissionPreset: 'manual' }))).toBe('allow')
      expect(toolEffect(t, meta({ permissionPreset: 'workspace' }))).toBe('allow')
      expect(toolEffect(t, meta({ permissionPreset: 'full' }))).toBe('allow')
      expect(toolEffect(t, meta({ mode: 'review', permissionPreset: 'manual' }))).toBe('allow')
      expect(toolEffect(t, meta({ mode: 'plan', permissionPreset: 'manual' }))).toBe('allow')
    }
  })
})

describe('toolEffect — modes', () => {
  it('review exposes only R0 reads', () => {
    const review = meta({ mode: 'review', permissionPreset: 'full' })
    expect(toolEffect(read, review)).toBe('allow')
    expect(toolEffect(write, review)).toBe('deny')
    expect(toolEffect(shell, review)).toBe('deny')
  })
  it('plan strips tools not allowed in plan', () => {
    const plan = meta({ mode: 'plan', permissionPreset: 'full' })
    expect(toolEffect(shell, plan)).toBe('deny') // allowedInPlan: false
    expect(toolEffect(read, plan)).toBe('allow') // allowedInPlan: true
  })
})
