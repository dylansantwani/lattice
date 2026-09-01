import { useStore, activeThread } from '@/state/store'
import type { Mode, PermissionPreset } from '@shared/types'

/**
 * A slash command surfaced in the composer's `/` menu. Commands are self-contained:
 * their handlers reach into the store directly, so the menu and composer only need to
 * resolve a command by name and call `run`.
 */
export interface SlashCommand {
  /** canonical name without the leading slash, e.g. "goal" */
  name: string
  aliases?: string[]
  /** short imperative label shown in the menu */
  title: string
  /** one-line description */
  hint: string
  /** Material Symbols glyph */
  icon: string
  category: CommandCategory
  /**
   * Whether the command consumes the rest of the line as an argument:
   *  - 'required': selecting it fills the composer with "/name " and waits for input
   *  - 'optional': it runs immediately, using any argument already typed
   *  - undefined:  it takes no argument and runs immediately
   */
  expectsArg?: 'required' | 'optional'
  /** placeholder describing the argument, shown in the menu (e.g. "<text>") */
  argHint?: string
  /** hidden from the menu when this returns false (still runnable if typed) */
  available?: () => boolean
  run: (arg: string) => void | Promise<void>
}

export type CommandCategory =
  | 'Session'
  | 'Orchestration'
  | 'Mode'
  | 'Permissions'
  | 'Model'
  | 'Panels'
  | 'Thread'
  | 'Appearance'

/** Order in which categories are grouped in the menu. */
export const CATEGORY_ORDER: CommandCategory[] = [
  'Session',
  'Orchestration',
  'Mode',
  'Permissions',
  'Model',
  'Panels',
  'Thread',
  'Appearance'
]

const s = () => useStore.getState()
const setMode = (mode: Mode) => () => void s().setMode(mode)
const setPreset = (preset: PermissionPreset) => () => void s().setPreset(preset)
const openTab = (tab: 'context' | 'run' | 'tasks' | 'memory' | 'agents' | 'mcp') =>
  () => s().setUi({ inspectorOpen: true, inspectorTab: tab })

const EFFORT_TIERS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THEMES: Record<string, string> = {
  graphite: 'graphite',
  midnight: 'midnight',
  paper: 'paper',
  'high-contrast': 'high-contrast',
  contrast: 'high-contrast'
}

export const COMMANDS: SlashCommand[] = [
  // ---- Session ----
  { name: 'new', title: 'New thread', hint: 'Start a fresh conversation', icon: 'add', category: 'Session', run: () => void s().newThread() },
  {
    name: 'clear',
    title: 'Clear conversation',
    hint: 'Wipe this thread’s messages, keep its settings',
    icon: 'mop',
    category: 'Session',
    run: () => void s().clearThread()
  },
  {
    name: 'compact',
    title: 'Compact context',
    hint: 'Summarize history to free up the context window',
    icon: 'compress',
    category: 'Session',
    run: () => void s().compactThread()
  },

  // ---- Orchestration ----
  {
    name: 'goal',
    title: 'Set goal',
    hint: 'Pin a north-star the agent keeps in view (blank clears it)',
    icon: 'flag',
    category: 'Orchestration',
    expectsArg: 'optional',
    argHint: '<goal, or blank to clear>',
    run: (arg) => {
      void s().setGoal(arg)
      s().flash(arg.trim() ? 'Goal set' : 'Goal cleared')
    }
  },
  {
    name: 'side',
    title: 'Side thread',
    hint: 'Fork a read-only side conversation from here',
    icon: 'call_split',
    category: 'Orchestration',
    expectsArg: 'optional',
    argHint: '<optional first prompt>',
    run: (arg) => void s().forkThread({ titlePrefix: 'Side', seed: arg })
  },
  {
    name: 'btw',
    title: 'Quick aside',
    hint: 'Fork a side thread for a by-the-way question',
    icon: 'quickreply',
    category: 'Orchestration',
    expectsArg: 'optional',
    argHint: '<optional question>',
    run: (arg) => void s().forkThread({ titlePrefix: 'BTW', seed: arg })
  },

  // ---- Mode ----
  { name: 'plan', title: 'Plan mode', hint: 'Investigate and propose — no mutating actions', icon: 'lightbulb', category: 'Mode', run: setMode('plan') },
  { name: 'act', title: 'Act mode', hint: 'Execute the task with permitted tools', icon: 'bolt', category: 'Mode', run: setMode('act') },
  { name: 'review', title: 'Review mode', hint: 'Inspect and assess — make no new edits', icon: 'rate_review', category: 'Mode', run: setMode('review') },

  // ---- Permissions ----
  { name: 'manual', title: 'Manual permissions', hint: 'Read-only tools; side-effects disabled', icon: 'lock', category: 'Permissions', run: setPreset('manual') },
  { name: 'auto', title: 'Auto permissions', hint: 'Workspace reads/writes; shell asks first', icon: 'auto_mode', category: 'Permissions', aliases: ['workspace'], run: setPreset('workspace') },
  { name: 'full', title: 'Full permissions', hint: 'Full local access, no prompts', icon: 'lock_open', category: 'Permissions', run: setPreset('full') },

  // ---- Model ----
  { name: 'model', title: 'Change model', hint: 'Open the model picker (⌘M)', icon: 'model_training', category: 'Model', run: () => s().setUi({ modelPickerOpen: true }) },
  {
    name: 'think',
    title: 'Thinking effort',
    hint: 'Set reasoning effort for this thread',
    icon: 'neurology',
    category: 'Model',
    expectsArg: 'required',
    argHint: '<off | low | medium | high | max>',
    run: (arg) => {
      const tier = arg.trim().toLowerCase()
      if (!EFFORT_TIERS.includes(tier)) {
        s().flash(`Unknown effort “${tier}”. Try: ${EFFORT_TIERS.join(', ')}`, 'warn')
        return
      }
      void s().setEffort(tier)
      s().flash(`Thinking effort → ${tier}`)
    }
  },

  // ---- Panels ----
  { name: 'context', title: 'Context inspector', hint: 'Open the context budget panel', icon: 'donut_large', category: 'Panels', run: openTab('context') },
  { name: 'run', title: 'Run inspector', hint: 'Open the run event log', icon: 'terminal', category: 'Panels', run: openTab('run') },
  { name: 'tasks', title: 'Tasks', hint: 'Open the tasks / todo board', icon: 'checklist', category: 'Panels', run: openTab('tasks') },
  { name: 'memory', title: 'Memory', hint: 'Open the memory inspector', icon: 'database', category: 'Panels', run: openTab('memory') },
  { name: 'agents', title: 'Agents', hint: 'Open the subagent tree', icon: 'graph_3', category: 'Panels', run: openTab('agents') },
  { name: 'mcp', title: 'MCP servers', hint: 'Open the MCP servers panel', icon: 'lan', category: 'Panels', run: openTab('mcp') },
  { name: 'settings', title: 'Settings', hint: 'Open settings (⌘,)', icon: 'settings', category: 'Panels', run: () => s().setUi({ settingsOpen: true }) },

  // ---- Thread ----
  {
    name: 'rename',
    title: 'Rename thread',
    hint: 'Give this thread a new title',
    icon: 'edit',
    category: 'Thread',
    expectsArg: 'required',
    argHint: '<new title>',
    run: (arg) => {
      const id = s().activeThreadId
      if (id && arg.trim()) void s().renameThread(id, arg)
    }
  },
  {
    name: 'pin',
    title: 'Pin thread',
    hint: 'Keep this thread at the top of the sidebar',
    icon: 'push_pin',
    category: 'Thread',
    available: () => !activeThread(s())?.pinned,
    run: () => {
      const id = s().activeThreadId
      if (id) void s().setThreadPinned(id, true)
    }
  },
  {
    name: 'unpin',
    title: 'Unpin thread',
    hint: 'Remove this thread from the pinned set',
    icon: 'keep_off',
    category: 'Thread',
    available: () => !!activeThread(s())?.pinned,
    run: () => {
      const id = s().activeThreadId
      if (id) void s().setThreadPinned(id, false)
    }
  },
  {
    name: 'archive',
    title: 'Archive thread',
    hint: 'Move this thread out of the active list',
    icon: 'archive',
    category: 'Thread',
    run: () => {
      const id = s().activeThreadId
      if (id) void s().setThreadArchived(id, true)
    }
  },

  // ---- Appearance ----
  {
    name: 'theme',
    title: 'Change theme',
    hint: 'Switch the color theme',
    icon: 'palette',
    category: 'Appearance',
    expectsArg: 'required',
    argHint: '<graphite | midnight | paper | high-contrast>',
    run: (arg) => {
      const key = arg.trim().toLowerCase()
      const theme = THEMES[key]
      if (!theme) {
        s().flash(`Unknown theme “${key}”. Try: graphite, midnight, paper, high-contrast`, 'warn')
        return
      }
      void s().saveSettings({ theme: theme as never })
      s().flash(`Theme → ${theme}`)
    }
  }
]

/** Look up a command by name or alias (case-insensitive). */
export function findCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase()
  return COMMANDS.find((c) => c.name === n || c.aliases?.includes(n))
}

/**
 * Filter + rank commands for a query (the text after the leading `/`, before any space).
 * Exact/prefix matches on the name rank first, then alias prefixes, then substring matches
 * on the name or title. Unavailable commands are dropped.
 */
export function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase().trim()
  const usable = COMMANDS.filter((c) => c.available?.() ?? true)
  if (!q) return usable
  const scored: { c: SlashCommand; score: number }[] = []
  for (const c of usable) {
    const name = c.name.toLowerCase()
    const title = c.title.toLowerCase()
    let score = -1
    if (name === q) score = 100
    else if (name.startsWith(q)) score = 80
    else if (c.aliases?.some((a) => a.startsWith(q))) score = 70
    else if (name.includes(q)) score = 50
    else if (title.includes(q)) score = 30
    if (score >= 0) scored.push({ c, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name)).map((x) => x.c)
}
