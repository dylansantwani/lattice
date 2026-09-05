import { defineConfig } from 'vitest/config'

// Gate-1 black-box e2e: spawns the compiled bin/ and drives it over stdio
// with a real MCP SDK client. Run with `pnpm test:e2e` (or
// `../../node_modules/.bin/vitest run -c vitest.e2e.config.ts`).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.e2e.ts'],
    testTimeout: 30000,
    hookTimeout: 30000
  }
})
