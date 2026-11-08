import { defineCron } from 'theokit/server/cron'

import { mainProcessOnly } from '../factory/worker-only'
import { actionDeps } from '../panel/deps'
import { runDueRetries } from '../panel/retry-waiting'

/**
 * Keeps the promise of the "Will retry itself" column: every five minutes it runs again the failed tasks
 * whose time came (a quota that is back, an outage that had its wait), a few per pass so a quota coming
 * back for the whole queue does not start every sandbox at once. Three per pass is 36 an hour.
 */
const PER_PASS = 3

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
    const result = await runDueRetries(deps, { limit: PER_PASS })
    if (result.started > 0 || result.skipped > 0) {
      console.log(JSON.stringify({ event: 'retry_due', ...result }))
    }
  }),
})
