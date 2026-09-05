/**
 * Context-aware scaling: shared helpers that let the runtime and the UI treat a model's context
 * window as a first-class budget. A 64k-context local model (a llama.cpp slot, say) can't absorb a
 * 48 KB tool result the way a 200k cloud model can — a single dump like that is a fifth of its whole
 * window. These helpers (a) format a window compactly, (b) decide when a window is "small" enough to
 * flag and scale for, and (c) scale a byte/char cap down proportionally to the window.
 *
 * Pure and dependency-free so it is trivially testable and safe to import from both the main process
 * (tool truncation, the subagent-model prompt) and the renderer (the subagent card, the orbit).
 */

/**
 * The window at or above which we apply no extra scaling — a model this large is treated as
 * "full size" and gets the baseline caps. Roughly the low end of the current frontier cloud
 * models (Claude/GPT/Gemini all sit at 200k+), so anything below it is a deliberately smaller model.
 */
export const FULL_CONTEXT_WINDOW = 200_000

/**
 * Below this a window is "small": worth flagging in the UI (a subagent on it holds less history and
 * truncates tool output sooner than the main agent) and worth scaling tool output down for. Chosen
 * so the common local models (32k–64k) and mid-tier routes trip it, while 128k+ models don't.
 */
export const SMALL_CONTEXT_WINDOW = 100_000

/** True for a real, positive window that is smaller than {@link SMALL_CONTEXT_WINDOW}. */
export function isSmallContextWindow(tokens: number | undefined): boolean {
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 && tokens < SMALL_CONTEXT_WINDOW
}

/**
 * Pick the cleanest label for a token count at one unit, preferring an exact integer in either
 * base-1000 (cloud windows: 128000 → 128) or base-1024 (local llama.cpp windows: 65536 → 64), and
 * falling back to a one-decimal base-1000 figure when neither is exact. Both bases can be integers
 * for the same value (128000 is 128·1000 and 125·1024); base-1000 is tried first so 128000 reads as
 * "128k", while 65536 — only integral in base-1024 — reads as "64k".
 */
function unitLabel(tokens: number, base1000: number, suffix: string): string {
  const dec = tokens / base1000
  const bin = tokens / (base1000 * 1.024)
  const val = Number.isInteger(dec) ? dec : Number.isInteger(bin) ? bin : Math.round(dec * 10) / 10
  return `${val}${suffix}`
}

/**
 * A model's context window as a compact label: 65536 → "64k", 128000 → "128k", 262144 → "256k",
 * 1_048_576 → "1M", 200000 → "200k". Non-positive / non-finite → "—".
 */
export function fmtContextWindow(tokens: number | undefined): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return '—'
  if (tokens >= 1_000_000) return unitLabel(tokens, 1_000_000, 'M')
  if (tokens >= 1_000) return unitLabel(tokens, 1_000, 'k')
  return String(Math.round(tokens))
}

/**
 * Scale a baseline cap (bytes or characters) to a model's context window. A full-size window keeps
 * the baseline; a smaller window gets a proportionally smaller cap, floored at `minCap` so even a
 * tiny window still returns something useful. An unknown/invalid window keeps the baseline (we never
 * scale on a guess). Linear in the window: a 64k model gets ~32% of the baseline, a 100k model ~50%.
 */
export function scaleContextCap(
  contextLength: number | undefined,
  fullCap: number,
  minCap: number,
  fullContext = FULL_CONTEXT_WINDOW
): number {
  if (typeof contextLength !== 'number' || !Number.isFinite(contextLength) || contextLength <= 0) return fullCap
  if (contextLength >= fullContext) return fullCap
  const scaled = Math.round(fullCap * (contextLength / fullContext))
  return Math.max(minCap, Math.min(fullCap, scaled))
}
