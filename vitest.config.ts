import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/**/*.integration.test.ts', 'src/**/*.e2e.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          // Never the factory's own database: these suites truncate their tables.
          setupFiles: ['src/test/use-test-database.ts'],
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
