/**
 * Canonical reasoning-effort taxonomy, verified across model families and gateways
 * (OpenAI, Anthropic/Claude, Gemini, Grok, DeepSeek/Qwen) + the adversarial id check.
 *
 * The standard ladder is: none < minimal < low < medium < high < xhigh < max.
 * `ultra` is an OmniRoute/Codex subscription extension above `max`; it is only
 * offered when the route metadata or a matching variant proves it is available.
 * Key correctness rules baked in here:
 *  - `thinking` / `reasoning` are NEVER effort tokens — they mark distinct models
 *    (gpt-5-thinking, grok-4-fast-reasoning); stripping them would merge real models.
 *  - `medium`, `max`, and `ultra` are ambiguous: they also occur inside real model names
 *    (mistral-medium, qwen-max, nemotron-ultra), so they only count as effort when a sibling base exists.
 *  - `ultracode` is not its own tier — it's a Claude Code mode that resolves to `xhigh`.
 */

export const EFFORT_RANK: Record<string, number> = {
  off: 0,
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7
}

export const EFFORT_LABELS: Record<string, string> = {
  off: 'No thinking',
  none: 'No thinking',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

/** All effort values accepted by the thread/slash-command controls. */
export const EFFORT_TIERS = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]

export function effortRank(t: string): number {
  return EFFORT_RANK[t.toLowerCase()] ?? 50
}

export function effortLabel(t: string): string {
  const k = t.toLowerCase()
  return EFFORT_LABELS[k] ?? k.charAt(0).toUpperCase() + k.slice(1)
}

/** De-dupe, lowercase, and order effort tiers from least → most effort. */
export function orderTiers(tiers: string[]): string[] {
  return [...new Set(tiers.map((t) => t.toLowerCase()))].sort((a, b) => effortRank(a) - effortRank(b))
}

// Effort words that never appear inside a real model id → safe to strip as a suffix anywhere.
const ALWAYS_TIER = ['none', 'minimal', 'low', 'high', 'xhigh']
// Effort words that also occur inside real model names → only a tier with a sibling base.
// `ultra` is a real model-name token too (e.g. Nemotron 3 Ultra), so it must remain here rather
// than being stripped unconditionally.
const AMBIGUOUS_TIER = ['medium', 'max', 'ultra']

const SEP = '[\\s_\\-:/]+'
const ALWAYS_RE = new RegExp(`${SEP}\\(?(${ALWAYS_TIER.join('|')})\\)?\\s*$`, 'i')
const AMBIGUOUS_RE = new RegExp(`${SEP}\\(?(${AMBIGUOUS_TIER.join('|')})\\)?\\s*$`, 'i')
// "ultracode" (Claude Code) = xhigh effort + workflow orchestration, not a distinct level.
const ULTRACODE_RE = new RegExp(`${SEP}\\(?ultracode\\)?\\s*$`, 'i')

/**
 * Peel every trailing always-tier / ultracode token off an id (repeatedly, so
 * "gpt-5-thinking-high" → stem "gpt-5-thinking" + ["high"]). Returns the base stem and tiers found.
 */
export function peelAlwaysTiers(id: string): { stem: string; tiers: string[] } {
  let cur = id.trim()
  const tiers: string[] = []
  for (let i = 0; i < 6; i++) {
    const u = cur.match(ULTRACODE_RE)
    if (u) {
      tiers.push('xhigh')
      cur = cur.slice(0, u.index).trim()
      continue
    }
    const m = cur.match(ALWAYS_RE)
    if (m) {
      tiers.push(m[1]!.toLowerCase())
      cur = cur.slice(0, m.index).trim()
      continue
    }
    break
  }
  return { stem: cur, tiers }
}

/** If an id ends in an ambiguous tier token, the stem without it and the token; else null. */
export function peelAmbiguousTier(id: string): { stem: string; tier: string } | null {
  const m = id.match(AMBIGUOUS_RE)
  if (!m) return null
  return { stem: id.slice(0, m.index).trim(), tier: m[1]!.toLowerCase() }
}

/** Stable base identity for a route id (always-tiers/ultracode removed), for matching/highlighting. */
export function baseStem(id: string): string {
  return peelAlwaysTiers(id).stem.toLowerCase()
}

/**
 * Known effort ranges per model family, from the effort-tier research. Gateways frequently list
 * a model as one row with no `effort_tiers` metadata and no per-effort variant rows, which left
 * the composer showing only a generic low/medium/high. This fills in the real ladder — e.g. Opus
 * 4.8 goes up through `max`, GPT-5.6 goes up through `max`, and older GPT families get their
 * model-specific lower/upper bounds — matched from the id + name.
 *
 * The OpenAI ranges mirror the current model docs: GPT-5.6 supports none→max, GPT-5.5/GPT-5.4/
 * GPT-5.2 support none→xhigh, GPT-5.3/5.2 Codex support low→xhigh, GPT-5.1 supports none→high,
 * and the original GPT-5 supports minimal→high. OmniRoute's cx/codex GPT-5.6 Sol/Terra routes
 * may additionally advertise `ultra`; ordinary OpenAI/OpenRouter routes do not get it implicitly.
 */
export function knownEffortTiers(idAndName: string): string[] {
  const s = idAndName.toLowerCase()
  // Anthropic Claude
  if (/opus[\s._-]*(4[\s._-]*8|5)\b|opus5/.test(s)) return ['low', 'medium', 'high', 'xhigh', 'max']
  if (/opus[\s._-]*4[\s._-]*7\b/.test(s)) return ['low', 'medium', 'high', 'xhigh']
  if (/opus[\s._-]*4[\s._-]*6\b/.test(s)) return ['low', 'medium', 'high', 'max']
  if (/opus/.test(s)) return ['low', 'medium', 'high']
  if (/sonnet/.test(s)) return ['low', 'medium', 'high']
  if (/haiku/.test(s)) return ['low', 'medium', 'high']
  // OpenAI
  const isCodexSubscriptionRoute = /(?:^|\/)(?:cx|codex|cxa)\//.test(s)
  const gpt56 = /gpt[\s._-]*5[\s._-]*6\b/.test(s)
  if (gpt56) {
    const tiers = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
    // The base cx/codex routes do not always include capability metadata, but their
    // `-ultra` siblings are a reliable indication that this gateway-only tier exists.
    if (
      (isCodexSubscriptionRoute && /(?:sol|terra)\b/.test(s)) ||
      /gpt[\s._-]*5[\s._-]*6[\s._-]*(?:sol|terra)[\s._-]*ultra\b/.test(s)
    ) {
      tiers.push('ultra')
    }
    return tiers
  }
  if (/gpt[\s._-]*5[\s._-]*5\b/.test(s) && /\bpro\b/.test(s)) return ['medium', 'high', 'xhigh']
  if (/gpt[\s._-]*5[\s._-]*5\b|gpt[\s._-]*5\.5/.test(s)) return ['none', 'low', 'medium', 'high', 'xhigh']
  if (/gpt[\s._-]*5[\s._-]*4\b/.test(s) && /\bpro\b/.test(s)) return ['medium', 'high', 'xhigh']
  if (/gpt[\s._-]*5[\s._-]*4\b/.test(s)) return ['none', 'low', 'medium', 'high', 'xhigh']
  if (/gpt[\s._-]*5[\s._-]*3\b/.test(s) && /\bcodex\b/.test(s)) return ['low', 'medium', 'high', 'xhigh']
  if (/gpt[\s._-]*5[\s._-]*2\b/.test(s) && /\bpro\b/.test(s)) return ['medium', 'high', 'xhigh']
  if (/gpt[\s._-]*5[\s._-]*2\b/.test(s) && /\bcodex\b/.test(s)) return ['low', 'medium', 'high', 'xhigh']
  if (/gpt[\s._-]*5[\s._-]*2\b/.test(s)) return ['none', 'low', 'medium', 'high', 'xhigh']
  if (/gpt[\s._-]*5[\s._-]*1\b/.test(s) && /\bcodex\b/.test(s)) return ['low', 'medium', 'high', 'xhigh']
  if (/gpt[\s._-]*5[\s._-]*1\b/.test(s)) return ['none', 'low', 'medium', 'high']
  if (/gpt[\s._-]*5\b/.test(s) && /\bpro\b/.test(s)) return ['high']
  if (/gpt[\s._-]*5/.test(s)) return ['minimal', 'low', 'medium', 'high']
  if (/\bo4[\s._-]*mini\b/.test(s)) return ['low', 'medium', 'high']
  if (/\bo[13][\s._-]|\bo[13]\b/.test(s)) return ['low', 'medium', 'high']
  // Google Gemini (thinking)
  if (/gemini.*(flash[\s._-]*lite|lite)/.test(s)) return ['minimal', 'low', 'medium', 'high']
  if (/gemini/.test(s)) return ['low', 'medium', 'high']
  // xAI Grok
  if (/grok[\s._-]*4/.test(s)) return ['low', 'medium', 'high', 'xhigh']
  if (/grok/.test(s)) return ['low', 'medium', 'high']
  return []
}

/**
 * The effort ladder to actually offer for a model: whatever the gateway declared (or we
 * reconstructed from variant rows), unioned with the known range for its family, ordered
 * least→most. Empty for models that don't reason.
 */
export function resolveEffortTiers(model: {
  id: string
  name: string
  capabilities: { reasoning: boolean; effortTiers: string[] }
}): string[] {
  const declared = model.capabilities.effortTiers ?? []
  if (!model.capabilities.reasoning && declared.length === 0) return []
  const known = knownEffortTiers(`${model.id} ${model.name}`)
  const merged = orderTiers([...declared, ...known])
  if (merged.length) return merged
  return model.capabilities.reasoning ? ['low', 'medium', 'high'] : []
}
