#!/usr/bin/env node
/**
 * Bundle the headless Lattice backend (src/headless/index.ts) to a single Node CJS file at
 * out/headless/index.cjs.
 *
 *  - `electron` is aliased to the headless shim (src/headless/electron-shim.ts) so the same
 *    main-process runtime runs without Electron.
 *  - `@shared/*` resolves to src/shared/*.
 *  - Native / must-be-installed modules stay external (installed on the VM): better-sqlite3,
 *    node-pty, ws. Everything else (MCP SDK, tokenizer, sse parser, …) is bundled in.
 *
 * Usage: node scripts/build-headless.mjs
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shim = resolve(root, 'src/headless/electron-shim.ts')
const sharedDir = resolve(root, 'src/shared')

/** Resolve `electron` → shim and `@shared/x` → src/shared/x. */
const aliasPlugin = {
  name: 'lattice-headless-alias',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: shim }))
    b.onResolve({ filter: /^@shared\// }, (args) => ({
      path: resolve(sharedDir, args.path.slice('@shared/'.length)) + (args.path.endsWith('.ts') ? '' : '.ts')
    }))
  }
}

await build({
  entryPoints: [resolve(root, 'src/headless/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: resolve(root, 'out/headless/index.cjs'),
  external: ['better-sqlite3', 'node-pty', 'ws'],
  plugins: [aliasPlugin],
  logLevel: 'info',
  sourcemap: false,
  legalComments: 'none'
})

// eslint-disable-next-line no-console
console.log('built out/headless/index.cjs')
