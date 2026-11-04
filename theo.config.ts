import { config } from 'theokit'

import { storageFromEnv } from './src/server/db/config'
import { LOCK_SECONDS } from './src/server/factory/lease'
import { jobBackend } from './src/server/factory/job-backend'

/**
 * The project has two surfaces, and one of them is the whole backend.
 *
 * `src/app` is the interface. `src/server` is everything that only runs on the server — and agents
 * are part of that, not a third surface beside it. An agent shares this project's context, auth,
 * services and infrastructure with every controller and route; a layout that puts `agents/` beside
 * `server/` suggests two backends and invites both to grow their own copy of all four.
 *
 * The paths are declared rather than inherited. The defaults are still the flat layout
 * (`app`, `server`, `agents`), so a project that says nothing keeps working exactly as before —
 * writing them down is what lets this scaffold move without waiting for a major, and what stops a
 * future default change from silently relocating anyone's code.
 */
export default config()
  .appDir('src/app')
  .serverDir('src/server')
  .agentsDir('src/server/agents')
  .set({ storage: storageFromEnv(), jobs: jobsFromEnv() })
  .build()

/**
 * Persistent jobs on the same Postgres pool. `theokit start` creates the table, leases jobs and
 * runs them in this process. The worker runs the leases of a tick one after another, so one job per
 * tick. The lock is short (two minutes) and the `run-task` job extends it while a run is alive
 * (`ctx.extendLease`), so a worker that crashes frees its job in minutes, not after the longest
 * possible run (usetheokit/theokit#1132).
 *
 * Without `DATABASE_URL` there is no backend, and the server still starts and reports not ready.
 */
function jobsFromEnv(): TheoConfigJobs | undefined {
  if (!storageFromEnv()) return undefined
  return {
    backend: jobBackend(),
    worker: { enabled: true, pollIntervalMs: 2_000, batchSize: 1, lockSeconds: LOCK_SECONDS },
  }
}
type TheoConfigJobs = NonNullable<Parameters<ReturnType<typeof config>['set']>[0]['jobs']>
