#!/usr/bin/env node
/** Bundle the Node-ABI CLI and alias Electron imports to the headless shim. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shim = resolve(root, 'src/headless/electron-shim.ts')
const sharedDir = resolve(root, 'src/shared')

const aliasPlugin = {
  name: 'lattice-cli-alias',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^electron$/ }, () => ({ path: shim }))
    buildApi.onResolve({ filter: /^@shared\// }, (args) => ({
      path: resolve(sharedDir, args.path.slice('@shared/'.length)) + (args.path.endsWith('.ts') ? '' : '.ts')
    }))
  }
}

await build({
  entryPoints: [resolve(root, 'src/cli/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: resolve(root, 'out/cli/lattice.cjs'),
  external: ['better-sqlite3', 'node-pty', 'ws'],
  plugins: [aliasPlugin],
  logLevel: 'info',
  sourcemap: false,
  legalComments: 'none'
})

console.log('built out/cli/lattice.cjs')
