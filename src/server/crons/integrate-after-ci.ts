import { defineCron } from 'theokit/server/cron'

import { pollAwaitingIntegrations } from '../factory/await-ci'
import { releaseModeFromEnv } from '../factory/deps'
import { mainProcessOnly } from '../factory/worker-only'
import { createPromotionApi } from '../github/promotion-api'
import { retryAutomatically, sendBackAutomatically } from '../panel/actions'
import { actionDeps } from '../panel/deps'

/**
 * Finishes the integrations that wait for a repository's required checks, every two minutes: once GitHub
 * merged the verified commit, the pre-release branch advances and the pre-release is made; a required check
 * that failed sends the work back to its agent, with the error lines read from its log or annotations, and
 * what the factory may not decide goes to a person.
 */
export default defineCron('integrate-after-ci', {
  schedule: '*/2 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    let deps
    try {
      deps = actionDeps()
    } catch (error) {
      console.error(
        JSON.stringify({ event: 'integrate_after_ci_not_configured', error: String(error) }),
      )
      return
    }
    const actions = deps
    const result = await pollAwaitingIntegrations({
      db: deps.db,
      github: deps.github,
      api: deps.api,
      checks: createPromotionApi(),
      releaseMode: releaseModeFromEnv(process.env),
      sendBack: (taskId, note) => sendBackAutomatically(actions, taskId, note),
      startOver: (taskId) => retryAutomatically(actions, taskId),
    })
    const { waiting, ...moved } = result
    if (Object.values(moved).some((list) => list.length > 0)) {
      console.log(JSON.stringify({ event: 'integrate_after_ci', waiting, ...moved }))
    }
  }),
})
