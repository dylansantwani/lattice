import { useStore, activeThread } from '@/state/store'
import type { Mode, PermissionPreset } from '@shared/types'
import { CATEGORY_ORDER, SLASH_CATALOG, type CommandCategory, type SlashCommandMeta } from '@shared/view/slashCatalog'
import { EFFORT_TIERS } from './effort'
import { resolveSpeechSettings } from '@shared/speech'
import { getSpeaker } from '@/speech/speaker'

export { CATEGORY_ORDER, type CommandCategory }

/** A renderer-bound slash command. The shared catalog owns all presentation metadata. */
export interface SlashCommand extends SlashCommandMeta {
  available?: () => boolean
  run: (arg: string) => void | Promise<void>
}

type InspectorTab = 'context' | 'run' | 'tasks' | 'memory' | 'agents' | 'mcp'
const s = () => useStore.getState()
const setMode = (mode: Mode) => () => void s().setMode(mode)
const setPreset = (preset: PermissionPreset) => () => void s().setPreset(preset)
const openTab = (tab: InspectorTab) => () => s().setUi({ inspectorOpen: true, inspectorTab: tab })

const THEMES: Record<string, string> = {
  graphite: 'graphite', midnight: 'midnight', paper: 'paper', 'high-contrast': 'high-contrast', contrast: 'high-contrast'
}

const RUNS: Record<string, SlashCommand['run']> = {
  new: () => void s().newThread(),
  clear: () => void s().clearThread(),
  compact: () => void s().compactThread(),
  goal: async (arg) => {
    const goal = arg.trim()
    await s().setGoal(arg)
    if (!goal) { s().flash('Goal cleared'); return }
    s().flash('Goal set')
    await s().send({ text: goal, disposition: activeThread(s())?.running ? 'queue' : 'send' })
  },
  system: async (arg) => {
    const text = arg.trim()
    await s().saveSettings({ customInstructions: text })
    s().flash(text ? 'System instructions updated' : 'System instructions cleared')
  },
  side: (arg) => void s().forkThread({ titlePrefix: 'Side', seed: arg }),
  btw: (arg) => void s().openAside(arg),
  plan: setMode('plan'), act: setMode('act'), review: setMode('review'),
  manual: setPreset('manual'), auto: setPreset('workspace'), full: setPreset('full'),
  model: () => s().openModelPicker(),
  think: (arg) => {
    const tier = arg.trim().toLowerCase()
    if (!EFFORT_TIERS.includes(tier)) { s().flash(`Unknown effort “${tier}”. Try: ${EFFORT_TIERS.join(', ')}`, 'warn'); return }
    void s().setEffort(tier)
    s().flash(`Thinking effort → ${tier}`)
  },
  context: openTab('context'), run: openTab('run'), tasks: openTab('tasks'),
  task: (arg) => {
    const title = arg.trim()
    if (!title) return
    void s().addTodo(title)
    s().setUi({ inspectorOpen: true, inspectorTab: 'tasks' })
    s().flash(`Task added: ${title}`)
  },
  memory: openTab('memory'), agents: openTab('agents'), mcp: openTab('mcp'),
  settings: () => s().setUi({ settingsOpen: true }),
  read: () => {
    const speaker = getSpeaker()
    if (speaker.getState().status !== 'idle') { speaker.stop(); return }
    const reply = [...s().messages].reverse().find((message) => message.role === 'assistant' && message.status && message.text.trim())
    if (!reply) { s().flash('No reply to read yet', 'warn'); return }
    void speaker.speak(reply.id, reply.text, s().settings?.speech)
  },
  autoread: () => {
    const speech = resolveSpeechSettings(s().settings?.speech)
    void s().saveSettings({ speech: { ...speech, autoRead: !speech.autoRead } })
    if (speech.autoRead) getSpeaker().stop()
    s().flash(speech.autoRead ? 'Auto-read off' : 'Auto-read on: replies will be read aloud as they finish')
  },
  rename: (arg) => { const id = s().activeThreadId; if (id && arg.trim()) void s().renameThread(id, arg) },
  pin: () => { const id = s().activeThreadId; if (id) void s().setThreadPinned(id, true) },
  unpin: () => { const id = s().activeThreadId; if (id) void s().setThreadPinned(id, false) },
  archive: () => { const id = s().activeThreadId; if (id) void s().setThreadArchived(id, true) },
  theme: (arg) => {
    const key = arg.trim().toLowerCase()
    const theme = THEMES[key]
    if (!theme) { s().flash(`Unknown theme “${key}”. Try: graphite, midnight, paper, high-contrast`, 'warn'); return }
    void s().saveSettings({ theme: theme as never })
    s().flash(`Theme → ${theme}`)
  }
}

const AVAILABILITY: Partial<Record<string, SlashCommand['available']>> = {
  pin: () => !activeThread(s())?.pinned,
  unpin: () => !!activeThread(s())?.pinned
}

export const COMMANDS: SlashCommand[] = SLASH_CATALOG.map((command) => ({
  ...command,
  available: AVAILABILITY[command.name],
  run: RUNS[command.name]!
}))

/** Look up a command by name or alias (case-insensitive). */
export function findCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase()
  return COMMANDS.find((c) => c.name === n || c.aliases?.includes(n))
}

/** Filter and rank the slash menu, excluding commands unavailable in the current thread. */
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
