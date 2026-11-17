import { defineCron } from 'theokit/server/cron'

import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { mainProcessOnly } from '../factory/worker-only'
import { createIssuesApi } from '../github/issues-api'
import { measure } from '../metrics/measure'

/**
 * The factory measures itself every hour: its indicators as daily points, and the control bands read on
 * them. A broken rule is recorded; a 3 sigma point opens an issue. Nothing here involves a model.
 */
export default defineCron('measure', {
  schedule: '17 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    let deps
    try {
      deps = factoryDeps()
    } catch (error) {
      console.error(JSON.stringify({ event: 'measure_not_configured', error: String(error) }))
      return
    }
    const github = deps.github
    const issues = createIssuesApi()
    const result = await measure({
      db: getDb(),
      openIssue: async (repository, title, body) => {
        const { token } = await github.installationToken(repository)
        return (await issues.createIssue(repository, token, { title, body })).url
      },
    })
    if (result.signals.length > 0 || result.issues.length > 0) {
      console.log(JSON.stringify({ event: 'measure', ...result }))
    }
  }),
})
