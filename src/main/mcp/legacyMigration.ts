import type { McpServerConfig } from '@shared/types'

/**
 * The browser MCP formerly registered as `abrowser` (run from the stale ~/Downloads/agent-browser copy)
 * was renamed Latchkey on 2026-09-11. Installs seeded before the rename keep an enabled `abrowser` row,
 * and the seeder's duplicate check compares id or command+args — both differ — so the next launch would
 * add `latchkey` too and run two browser servers side by side, the old one still carrying the Google
 * cookie-copying behaviour that signed the user out of their real Chrome.
 *
 * Given the rows in the store and the host's `~/.claude.json` servers, this returns the one change to
 * make: replace the legacy row with a `latchkey` row that keeps the user's enabled/policy choices, or
 * nothing. Pure, so the decision is testable without a database or a filesystem.
 */
export interface LegacyBrowserMigration {
  removeId: string
  add: McpServerConfig
}

interface HostEntry {
  command?: string
  args?: unknown
  env?: Record<string, string>
}

function isLegacyAbrowser(config: McpServerConfig): boolean {
  if (config.id !== 'abrowser') return false
  const args = (config.args ?? []).join(' ')
  return /\babrowser\b/.test(args) || /agent-browser/.test(`${config.command ?? ''} ${JSON.stringify(config.env ?? {})}`)
}

export function planLegacyBrowserMigration(
  existing: McpServerConfig[],
  host: Record<string, HostEntry>
): LegacyBrowserMigration | null {
  const legacy = existing.find(isLegacyAbrowser)
  if (!legacy) return null
  if (existing.some((c) => c.id === 'latchkey')) {
    // Latchkey is already registered; the legacy row is pure duplication.
    return { removeId: legacy.id, add: existing.find((c) => c.id === 'latchkey')! }
  }
  const entry = host.latchkey
  if (!entry || typeof entry.command !== 'string' || !entry.command) return null
  // The old row's env pointed PYTHONPATH (or similar) at the Downloads copy; never carry that forward.
  const env = entry.env && Object.keys(entry.env).length ? entry.env : undefined
  return {
    removeId: legacy.id,
    add: {
      ...legacy,
      id: 'latchkey',
      label: 'latchkey',
      transport: 'stdio',
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env,
      // per-tool policy was keyed by abrowser_* tool names, which no longer exist
      toolPolicy: undefined
    }
  }
}
