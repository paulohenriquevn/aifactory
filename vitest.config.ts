import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // What the quality gates read: `pnpm coverage` writes coverage/coverage-final.json.
    coverage: {
      provider: 'v8',
      reporter: ['json', 'text-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts', 'src/test/**', 'src/**/fake-sandbox.ts'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
          exclude: ['src/**/*.integration.test.ts', 'src/**/*.e2e.test.ts'],
          setupFiles: ['src/test/quiet-jsdom-css.ts', 'src/test/no-real-docker.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          // Never the factory's own database: these suites truncate their tables.
          setupFiles: ['src/test/use-test-database.ts', 'src/test/no-real-docker.ts'],
        },
      },
      {
        // Real GitHub, real Vercel Sandbox, real Postgres. Costs a little and needs credentials.
        test: {
          name: 'e2e',
          include: ['src/**/*.e2e.test.ts'],
          testTimeout: 300_000,
          hookTimeout: 60_000,
          setupFiles: ['src/test/use-test-database.ts'],
        },
      },
    ],
  },
})
