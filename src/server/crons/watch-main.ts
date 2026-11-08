import { defineCron } from 'theokit/server/cron'

import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { pollWatches } from '../factory/watch'
import { createGithubApi } from '../github/pulls'
import { mainProcessOnly } from '../factory/worker-only'

/**
 * Watches the default branch after a release, every minute. A red merge commit gets a pull request
 * that reverts it, which a person merges or closes. The factory never merges it.
 */
export default defineCron('watch-main', {
  schedule: '* * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    let deps
    try {
      deps = factoryDeps()
    } catch (error) {
      console.error(JSON.stringify({ event: 'watch_main_not_configured', error: String(error) }))
      return
    }
    const result = await pollWatches({ db: getDb(), github: deps.github, api: createGithubApi() })
    if (result.red.length > 0 || result.green.length > 0 || result.silent.length > 0) {
      console.log(JSON.stringify({ event: 'watch_main', ...result }))
    }
  }),
})
