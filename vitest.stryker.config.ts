import { defineConfig } from 'vitest/config'

// What Stryker runs for each mutant: only the unit tests of the modules it mutates, no database.
export default defineConfig({
  test: {
    include: [
      'src/server/factory/evidence.test.ts',
      'src/server/factory/release.test.ts',
      'src/server/factory/review.test.ts',
      'src/server/factory/watch.test.ts',
      'src/server/factory/waiting.test.ts',
      'src/server/factory/harness.test.ts',
      'src/server/factory/harness-codex.test.ts',
      'src/server/factory/harness-registry.test.ts',
      'src/server/factory/deps.test.ts',
      'src/server/panel/session.test.ts',
      'src/app/lib/assist.test.ts',
      'src/app/lib/repo-form.test.ts',
      'src/server/agents/hooks/only-tools.test.ts',
      'src/server/factory/repo-reader.test.ts',
      'src/server/factory/plan.test.ts',
      'src/server/factory/branches.test.ts',
      'src/server/factory/docker-sandbox.test.ts',
      'src/server/factory/sandbox-provider.test.ts',
      'src/server/factory/repo-config.test.ts',
      'src/server/panel/work.test.ts',
      'src/app/lib/format.test.ts',
      'src/shared/panel.test.ts',
      'src/app/panel.test.tsx',
      'src/app/page.test.tsx',
    ],
  },
})
