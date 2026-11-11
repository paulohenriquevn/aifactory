import { defineCron } from 'theokit/server/cron'

import { mainProcessOnly } from '../factory/worker-only'
import { newIssuesCapFromEnv } from '../factory/promotion'
import { pollPromotions } from '../factory/promotion-watch'
import { createIssuesApi } from '../github/issues-api'
import { createPromotionApi } from '../github/promotion-api'
import { actionDeps } from '../panel/deps'

/**
 * Watches the promotion pull requests of every enabled repository, every five minutes. A check that failed
 * on a head commit is rerun once, then filed as an issue the factory's agents fix (or one for a person, when
 * no change can fix it), so a red promotion does not wait for someone to read its log.
 */
export default defineCron('watch-promotions', {
  schedule: '*/5 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    let deps
    let cap
    try {
      deps = actionDeps()
      cap = newIssuesCapFromEnv(process.env)
    } catch (error) {
      console.error(
        JSON.stringify({ event: 'watch_promotions_not_configured', error: String(error) }),
      )
      return
    }
    const result = await pollPromotions({
      db: deps.db,
      app: deps.github,
      api: createPromotionApi(),
      github: deps.api,
      issues: createIssuesApi(),
      maxNewIssuesPerRepository: cap,
    })
    const { errors, ...done } = result
    if (errors.length > 0) {
      console.error(JSON.stringify({ event: 'watch_promotions_failed', errors }))
    }
    if (done.reruns > 0 || done.opened.length > 0 || done.commented.length > 0 || done.capped > 0) {
      console.log(JSON.stringify({ event: 'watch_promotions', ...done }))
    }
  }),
})
