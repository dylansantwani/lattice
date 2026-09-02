import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

// Runtime dependencies the main/preload bundles must import from node_modules instead of inlining.
// electron-vite's externalizeDepsPlugin is supposed to derive this from package.json, but its
// `config` hook is a no-op under Vite 8 (it mutates a config object that is no longer the one the
// build reads), so every main-process dependency has to be listed here by hand. Forgetting one is
// not a loud failure: Rolldown inlines the package and, as happened with gpt-tokenizer, can emit a 0-byte
// out/main/index.js — Electron then starts with an empty main script and never opens a window.
// The assertNonEmptyEntry plugin below turns that into a build error.
const NATIVE_EXTERNALS = [
  'better-sqlite3',
  'node-pty',
  'eventsource-parser',
  '@modelcontextprotocol/sdk',
  /^@modelcontextprotocol\/sdk\//,
  'gpt-tokenizer',
  /^gpt-tokenizer\//,
  'electron'
]

/**
 * Fail the build if an entry chunk comes out empty. A 0-byte main bundle is otherwise reported as
 * a successful build ("out/main/index.js  0.00 kB") and only shows up as an app that never
 * opens a window.
 */
function assertNonEmptyEntry(): Plugin {
  return {
    name: 'lattice:assert-non-empty-entry',
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry) continue
        if (chunk.code.trim().length === 0) {
          this.error(
            `${fileName} is empty. A dependency the bundler cannot inline is probably being bundled — ` +
              'add it to NATIVE_EXTERNALS in electron.vite.config.ts.'
          )
        }
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), assertNonEmptyEntry()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        external: NATIVE_EXTERNALS
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin(), assertNonEmptyEntry()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
        external: NATIVE_EXTERNALS
      }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@': resolve('src/renderer/src')
      }
    }
  }
})
