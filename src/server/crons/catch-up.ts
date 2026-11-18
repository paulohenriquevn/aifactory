import { defineCron } from 'theokit/server/cron'

import { getDb } from '../db'
import { catchUp } from '../factory/catch-up'
import { githubAppFromEnv } from '../factory/deps'
import { resolvedCatchUp } from '../factory/resolved-release'
import { mainProcessOnly } from '../factory/worker-only'
import { fetchIssue } from '../github/issues'
import { createGithubApi } from '../github/pulls'
import { githubPass } from '../github/budget-pass'

const releaseResolvedPass = resolvedCatchUp()

/**
 * Asks GitHub for the webhooks that did not get through while the factory was down. It runs every
 * five minutes, so a restart is caught up within one tick of the server coming back. The same pass
 * releases the tasks resolved with no change whose commit reached the release branch without a release
 * of the factory moving them, a few at a time.
 */
export default defineCron('catch-up', {
  schedule: '*/5 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(
    githubPass('catch-up', async () => {
      let app
      try {
        app = githubAppFromEnv()
      } catch (error) {
        console.error(JSON.stringify({ event: 'catch_up_not_configured', error: String(error) }))
        return
      }
      const result = await catchUp({ db: getDb(), app })
      if (result.redelivered.length > 0 || result.gaveUp.length > 0 || result.errors.length > 0) {
        console.log(JSON.stringify({ event: 'catch_up', ...result }))
      }
      await releaseResolvedPass({ db: getDb(), app, api: createGithubApi(), fetchIssue })
    }),
  ),
})
