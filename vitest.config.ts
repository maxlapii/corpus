import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

const PACKAGES = ['shared', 'domain', 'db', 'auth', 'security', 'ai', 'telegram', 'knowledge']

export default defineConfig({
  resolve: {
    alias: [
      // Subpath imports first, e.g. `@corpus/db/test-support`.
      {
        find: new RegExp(`^@corpus/(${PACKAGES.join('|')})/(.*)$`),
        replacement: `${root}packages/$1/src/$2.ts`,
      },
      {
        find: new RegExp(`^@corpus/(${PACKAGES.join('|')})$`),
        replacement: `${root}packages/$1/src/index.ts`,
      },
      { find: /^@corpus\/api\/(.*)$/, replacement: `${root}apps/api/src/$1.ts` },
      { find: '@corpus/api', replacement: `${root}apps/api/src/index.ts` },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: 'forks',
    reporters: ['default'],
    coverage: { provider: 'v8', reportsDirectory: 'coverage' },
  },
})
