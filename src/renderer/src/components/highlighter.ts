import { createHighlighter, type Highlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

/**
 * A single shared Shiki highlighter for the whole renderer. Code blocks in Markdown call
 * {@link highlightCode}, which lazily boots this once and then tokenizes synchronously.
 *
 * Choices that matter here:
 * - JS regex engine, not the Oniguruma WASM one. It needs no `.wasm` asset to resolve through the
 *   Electron/Vite bundler, so highlighting "just works" in every build with one fewer moving part.
 * - Two paired themes loaded together (Vitesse dark/light). We render with `defaultColor: false`,
 *   so every token carries both a `--shiki-dark` and `--shiki-light` custom property; a tiny bit of
 *   CSS then picks the right one for the active app theme (only Paper is light — see global.css).
 * - `structure: 'inline'` returns just the `<span class="line">` runs with no `<pre>/<code>` wrapper,
 *   so we can drop the tokens straight into the existing code-block chrome without nested shells.
 */

const DARK_THEME = 'vitesse-dark'
const LIGHT_THEME = 'vitesse-light'

// A generous but bounded language set — everything this app realistically shows in a fenced block.
// Anything outside it falls back to un-highlighted plain text rather than throwing.
const LANGS = [
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'json',
  'jsonc',
  'bash',
  'python',
  'css',
  'scss',
  'html',
  'xml',
  'yaml',
  'toml',
  'sql',
  'rust',
  'go',
  'c',
  'cpp',
  'csharp',
  'java',
  'ruby',
  'php',
  'markdown',
  'diff',
  'docker',
  'ini',
  'swift',
  'kotlin',
  'lua',
  'graphql',
  'make',
  'powershell'
]

// Common fence tags that don't match a Shiki id 1:1. Shiki knows some aliases itself, but pinning
// the ones we see keeps behavior predictable regardless of the loaded grammar set.
const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  shellsession: 'bash',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  py: 'python',
  py3: 'python',
  rb: 'ruby',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
  dockerfile: 'docker',
  htm: 'html',
  plist: 'xml',
  text: 'text',
  plaintext: 'text',
  txt: 'text'
}

let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [DARK_THEME, LIGHT_THEME],
      langs: LANGS,
      engine: createJavaScriptRegexEngine()
    })
  }
  return highlighterPromise
}

/** Map a fence tag to a loaded grammar id, or `null` when we should leave the block un-highlighted. */
function resolveLang(lang: string | undefined, hl: Highlighter): string | null {
  if (!lang) return null
  const key = lang.trim().toLowerCase()
  if (!key || key === 'text' || key === 'plaintext' || key === 'txt') return null
  const id = ALIASES[key] ?? key
  if (id === 'text') return null
  return hl.getLoadedLanguages().includes(id) ? id : null
}

/**
 * Tokenize `code` to an inline HTML string (line spans only). Resolves to `null` when the language
 * is unknown/plain, so the caller renders the raw text unchanged. Never throws for callers.
 */
export async function highlightCode(code: string, lang: string | undefined): Promise<string | null> {
  if (!code) return null
  try {
    const hl = await getHighlighter()
    const resolved = resolveLang(lang, hl)
    if (!resolved) return null
    return hl.codeToHtml(code, {
      lang: resolved,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
      structure: 'inline'
    })
  } catch {
    return null
  }
}
