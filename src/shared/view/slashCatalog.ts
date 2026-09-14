/** Framework-neutral metadata for the slash-command surfaces. */
export interface SlashCommandMeta {
  name: string
  aliases?: string[]
  title: string
  hint: string
  icon: string
  category: CommandCategory
  expectsArg?: 'required' | 'optional'
  argHint?: string
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

/** Order in which command categories are presented. */
export const CATEGORY_ORDER: CommandCategory[] = [
  'Session', 'Orchestration', 'Mode', 'Permissions', 'Model', 'Panels', 'Thread', 'Appearance'
]

/** The shared command inventory. Each surface supplies its own execution binding. */
export const SLASH_CATALOG: SlashCommandMeta[] = [
  { name: 'new', title: 'New thread', hint: 'Start a fresh conversation', icon: 'add', category: 'Session' },
  { name: 'clear', title: 'Clear conversation', hint: 'Wipe this thread’s messages, keep its settings', icon: 'mop', category: 'Session' },
  { name: 'compact', title: 'Compact context', hint: 'Summarize history to free up the context window', icon: 'compress', category: 'Session' },
  { name: 'goal', aliases: ['goals'], title: 'Set goal', hint: 'Pin a north-star the agent keeps in view, and hand it to the agent now (blank clears it)', icon: 'flag', category: 'Orchestration', expectsArg: 'optional', argHint: '<goal, or blank to clear>' },
  { name: 'system', aliases: ['instructions', 'sys'], title: 'System instructions', hint: 'Set standing instructions appended to the system prompt every turn (blank clears them)', icon: 'tune', category: 'Orchestration', expectsArg: 'optional', argHint: '<instructions, or blank to clear>' },
  { name: 'side', title: 'Side thread', hint: 'Fork a read-only side conversation from here', icon: 'call_split', category: 'Orchestration', expectsArg: 'optional', argHint: '<optional first prompt>' },
  { name: 'btw', title: 'Quick aside', hint: 'Open a small side-chat with this thread’s context; close to discard', icon: 'quickreply', category: 'Orchestration', expectsArg: 'optional', argHint: '<optional question>' },
  { name: 'plan', title: 'Plan mode', hint: 'Investigate and propose — no mutating actions', icon: 'lightbulb', category: 'Mode' },
  { name: 'act', title: 'Act mode', hint: 'Execute the task with permitted tools', icon: 'bolt', category: 'Mode' },
  { name: 'review', title: 'Review mode', hint: 'Inspect and assess — make no new edits', icon: 'rate_review', category: 'Mode' },
  { name: 'manual', title: 'Manual permissions', hint: 'Read-only tools; side-effects disabled', icon: 'lock', category: 'Permissions' },
  { name: 'auto', aliases: ['workspace'], title: 'Auto permissions', hint: 'Workspace reads/writes; shell asks first', icon: 'auto_mode', category: 'Permissions' },
  { name: 'full', title: 'Full permissions', hint: 'Full local access, no prompts', icon: 'lock_open', category: 'Permissions' },
  { name: 'model', title: 'Change model', hint: 'Open the model picker (⌘M)', icon: 'model_training', category: 'Model' },
  { name: 'think', title: 'Thinking effort', hint: 'Set reasoning effort for this thread', icon: 'neurology', category: 'Model', expectsArg: 'required', argHint: '<off | low | medium | high | max | ultra>' },
  { name: 'context', title: 'Context inspector', hint: 'Open the context budget panel', icon: 'donut_large', category: 'Panels' },
  { name: 'run', title: 'Run inspector', hint: 'Open the run event log', icon: 'terminal', category: 'Panels' },
  { name: 'tasks', title: 'Tasks', hint: 'Open the tasks / todo board', icon: 'checklist', category: 'Panels' },
  { name: 'task', aliases: ['todo'], title: 'Add task', hint: 'Add an item to this thread’s checklist', icon: 'add_task', category: 'Panels', expectsArg: 'required', argHint: '<what needs doing>' },
  { name: 'memory', title: 'Memory', hint: 'Open the memory inspector', icon: 'database', category: 'Panels' },
  { name: 'agents', title: 'Agents', hint: 'Open the subagent tree', icon: 'graph_3', category: 'Panels' },
  { name: 'mcp', title: 'MCP servers', hint: 'Open the MCP servers panel', icon: 'lan', category: 'Panels' },
  { name: 'settings', title: 'Settings', hint: 'Open settings (⌘,)', icon: 'settings', category: 'Panels' },
  { name: 'read', aliases: ['speak'], title: 'Read aloud', hint: 'Read the latest reply aloud (run again to stop)', icon: 'volume_up', category: 'Panels' },
  { name: 'autoread', title: 'Auto-read replies', hint: 'Toggle reading each reply aloud when it finishes', icon: 'record_voice_over', category: 'Panels' },
  { name: 'rename', title: 'Rename thread', hint: 'Give this thread a new title', icon: 'edit', category: 'Thread', expectsArg: 'required', argHint: '<new title>' },
  { name: 'pin', title: 'Pin thread', hint: 'Keep this thread at the top of the sidebar', icon: 'push_pin', category: 'Thread' },
  { name: 'unpin', title: 'Unpin thread', hint: 'Remove this thread from the pinned set', icon: 'keep_off', category: 'Thread' },
  { name: 'archive', title: 'Archive thread', hint: 'Move this thread out of the active list', icon: 'archive', category: 'Thread' },
  { name: 'theme', title: 'Change theme', hint: 'Switch the color theme', icon: 'palette', category: 'Appearance', expectsArg: 'required', argHint: '<graphite | midnight | paper | high-contrast>' }
]
