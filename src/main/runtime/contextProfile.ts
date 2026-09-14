/**
 * Context profiles: how much standing context a thread's requests carry.
 *
 * The full profile is tuned for hosted frontier models with long windows and cheap cached prefills.
 * A local model on the user's own GPU pays for every token twice — prefill seconds on each cache
 * miss, and attention quality as the window fills — and usually runs a single llama.cpp slot where
 * any unrelated request (titling, memory distillation) evicts the cached prefix. Measured against
 * Qwen3.6-35B-A3B on an RTX 5080 (2026-09-12): a one-word reply cost a 14,078-token prompt, ~62% of
 * it tool schemas and tool prose the model did not need.
 *
 * The lean profile is a set of independent reductions, each switchable for measurement:
 *   tools     — drop tools a single local model cannot use well (subagent orchestration and
 *               cross-session messaging on one GPU slot, image tools on a text-only model, and
 *               `set_thread_title` — auto-titling already names the thread)
 *   schema    — compact tool descriptions and parameter docs to their first sentences
 *   inventory — replace the prose tool inventory (a second copy of every description) with one line
 *   prompt    — a condensed base system prompt carrying the same rules
 *   housekeeping — titling passes continue the thread's own request with reasoning off instead of
 *               sending a lone digest prompt at the thread's effort (measured: ~1,000 thinking
 *               tokens per title → 5–9), and a single-cache server keeps the conversation's prefix
 */
import type { ModelInfo } from '@shared/types'
import type { ToolDefinition } from '../tools/types'

export type ContextProfile = 'full' | 'lean'
export type ContextProfileSetting = 'auto' | 'full' | 'lean'
export type LeanPart = 'tools' | 'schema' | 'inventory' | 'prompt' | 'housekeeping'

export const LEAN_PARTS: readonly LeanPart[] = ['tools', 'schema', 'inventory', 'prompt', 'housekeeping']

/** Backends that run on the user's own hardware (model-picker source keys and gateway `owned_by`). */
const LOCAL_BACKENDS = new Set(['mac', 'pc5080', 'ollama', 'llamacpp', 'llama-cpp', 'llama.cpp', 'lmstudio', 'mlx', 'mlx-lm', 'vllm', 'local'])

export function isLocalModel(id: string | undefined, info?: Pick<ModelInfo, 'ownedBy' | 'provider'> | null): boolean {
  if (!id) return false
  const prefix = id.includes('/') ? id.split('/')[0]!.toLowerCase() : ''
  if (prefix && LOCAL_BACKENDS.has(prefix)) return true
  const owner = info?.ownedBy?.toLowerCase()
  return !!owner && LOCAL_BACKENDS.has(owner)
}

/**
 * The profile a thread's requests use. `LATTICE_CONTEXT_PROFILE` (full|lean) overrides for
 * benchmarks; otherwise the setting decides, and `auto` (the default) picks lean for local models.
 */
export function resolveContextProfile(
  setting: ContextProfileSetting | undefined,
  modelId: string | undefined,
  info?: Pick<ModelInfo, 'ownedBy' | 'provider'> | null,
  env: NodeJS.ProcessEnv = process.env
): ContextProfile {
  const forced = env.LATTICE_CONTEXT_PROFILE
  if (forced === 'full' || forced === 'lean') return forced
  if (setting === 'full' || setting === 'lean') return setting
  return isLocalModel(modelId, info) ? 'lean' : 'full'
}

/** Which lean reductions are active; `LATTICE_LEAN_PARTS=tools,schema` narrows them for ablation. */
export function leanParts(profile: ContextProfile, env: NodeJS.ProcessEnv = process.env): ReadonlySet<LeanPart> {
  if (profile !== 'lean') return new Set()
  const raw = env.LATTICE_LEAN_PARTS
  if (!raw) return new Set(LEAN_PARTS)
  return new Set(raw.split(',').map((part) => part.trim()).filter((part): part is LeanPart => (LEAN_PARTS as readonly string[]).includes(part)))
}

// ---------------------------------------------------------------------------- tools

/** Orchestration and messaging tools that assume many concurrent model slots. */
const LEAN_OMITTED = new Set([
  'run_agent',
  'agent_result',
  'peek_agents',
  'list_sessions',
  'peek_session',
  'send_message',
  'check_inbox',
  'set_thread_title'
])
/** Tools whose only purpose is to show the model an image. */
const IMAGE_TOOLS = new Set(['show_image', 'show_image_data', 'fetch_image'])

export function leanToolSet<T extends Pick<ToolDefinition, 'name'>>(tools: T[], opts: { vision: boolean }): T[] {
  return tools.filter((tool) => !LEAN_OMITTED.has(tool.name) && (opts.vision || !IMAGE_TOOLS.has(tool.name)))
}

const DESCRIPTION_MAX = 320
const PARAM_DESCRIPTION_MAX = 140

/** Leading sentences of `text` that fit in `max` characters (always at least the first, clipped). */
export function leadingSentences(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const sentences = clean.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [clean]
  let out = ''
  for (const sentence of sentences) {
    const next = out ? `${out} ${sentence.trim()}` : sentence.trim()
    if (next.length > max) break
    out = next
  }
  if (out) return out
  const clipped = clean.slice(0, max - 1)
  return `${clipped.slice(0, Math.max(clipped.lastIndexOf(' '), max * 0.6))}…`
}

type JsonSchema = Record<string, unknown>

function compactSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(compactSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: JsonSchema = {}
  for (const [key, value] of Object.entries(schema as JsonSchema)) {
    if (key === 'description' && typeof value === 'string') out.description = leadingSentences(value, PARAM_DESCRIPTION_MAX)
    else if (key === 'examples' || key === 'example') continue
    else out[key] = compactSchema(value)
  }
  return out
}

const compacted = new WeakMap<object, unknown>()

/**
 * The tool with its description cut to its leading sentences and every parameter description
 * shortened. Names, types, enums and required lists — what the model needs to form a valid call —
 * are untouched. Memoized per definition so the bytes are identical on every request (prefix cache).
 */
export function compactTool<T extends Pick<ToolDefinition, 'name' | 'description' | 'parameters'>>(tool: T): T {
  const hit = compacted.get(tool)
  if (hit) return hit as T
  const next = {
    ...tool,
    // find_mcp's description IS the server catalog; clipping it would hide what can be loaded.
    description: tool.name === 'find_mcp' ? tool.description : leadingSentences(tool.description, DESCRIPTION_MAX),
    parameters: compactSchema(tool.parameters) as T['parameters']
  }
  compacted.set(tool, next)
  return next
}

// ---------------------------------------------------------------------------- prompt

/**
 * The lean tool inventory. The full inventory repeats every tool's first sentence in prose so a
 * frontier model never claims a missing capability; the schemas already say the same thing, and a
 * one-line assurance keeps that benefit.
 */
export function leanToolInventory(tools: Array<Pick<ToolDefinition, 'name'>>): string {
  const has = (name: string): boolean => tools.some((tool) => tool.name === name)
  const lines = [
    '# Tools',
    'Your tools are provided through function calling. They are real and they work: use them to do the work instead of describing it or claiming you cannot.'
  ]
  if (has('find_mcp')) lines.push('More integrations load on demand: call `find_mcp` with a server id from its description.')
  return lines.join('\n')
}

/** The condensed base prompt: every rule of the full prompt that changes behavior, without the essays. */
export const LEAN_SYSTEM_PROMPT = `You are Lattice, an autonomous agent working on the user's machine. Answer in GitHub-flavored Markdown, concise and technically precise.

- Drive the task to completion without waiting to be prompted for each step. When something fails, read the actual error, fix the cause, and try the next distinct approach; stop only when done or truly blocked.
- Every tool round re-sends the whole conversation, so batch independent calls (parallel calls or the \`batch\` tool) and skip checks that would not change your next step.
- Read before you edit, make the smallest correct change, and verify it (run the test, re-read the file) before calling it done. Finish the whole task, not a partial version or a plan.
- Anything slow (installs, builds, test suites, servers, downloads) runs in the background (\`shell\` with background: true, or \`start_job\`); keep working meanwhile and never wait with sleep.
- For a task with several steps, keep a short checklist with \`todo_write\` and update it as you go.
- Use \`ask_user\` only when a real choice or missing detail blocks you, or before an irreversible action.
- A new message while you work is usually a course correction: fold it in and keep what you already verified.
- End with the result first: what changed, what you verified, and anything left undone.`
