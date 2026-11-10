import { defineCron } from 'theokit/server/cron'

import { mainProcessOnly } from '../factory/worker-only'
import { actionDeps } from '../panel/deps'
import { runConflictRetries, runDueRetries } from '../panel/retry-waiting'

/**
 * Keeps the promise of the "Will retry itself" column: every five minutes it runs again the failed tasks
 * whose time came (a quota that is back, an outage that had its wait), a few per pass so a quota coming
 * back for the whole queue does not start every sandbox at once. Three per pass is 36 an hour. The same
 * pass runs again, as many more, the done tasks whose pull request GitHub refused for a conflict with
 * the base, since another task merged first.
 */
const PER_PASS = 3

/** Logs a pass that started or skipped a task; a pass with nothing to do stays quiet. */
function report(event: string, result: { started: number; skipped: number }): void {
  if (result.started > 0 || result.skipped > 0) console.log(JSON.stringify({ event, ...result }))
}

export default defineCron('retry-due', {
  schedule: '*/5 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    let deps
    try {
      deps = actionDeps()
    } catch (error) {
      console.error(JSON.stringify({ event: 'retry_due_not_configured', error: String(error) }))
      return
    }
    report('retry_due', await runDueRetries(deps, { limit: PER_PASS }))
    report('retry_conflict', await runConflictRetries(deps, { limit: PER_PASS }))
  }),
})
