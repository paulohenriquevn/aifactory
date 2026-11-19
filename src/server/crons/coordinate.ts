import { defineCron } from 'theokit/server/cron'

import { coordinate } from '../coordinator/coordinate'
import { modelScopeDrafter } from '../coordinator/draft'
import { modelUnblocker } from '../coordinator/unblock'
import { evolveLog } from '../coordinator/evolve'
import { evolve, evolveDeps } from '../coordinator/evolve-apply'
import { coordinatorModeFromEnv } from '../coordinator/mode'
import { releaseModeFromEnv } from '../factory/deps'
import { inTransaction } from '../factory/resume-queue'
import { mainProcessOnly } from '../factory/worker-only'
import { fetchIssue } from '../github/issues'
import { createIssuesApi } from '../github/issues-api'
import { actionDeps } from '../panel/deps'
import { githubPass } from '../github/budget-pass'
import { createPromotionApi } from '../github/promotion-api'

/**
 * The coordinator's pass, every ten minutes: the exceptions of the factory's tasks, one action from a
 * closed set for each, applied through the panel's own actions and recorded (`coordinator/`). What it would
 * escalate, and a builder question nobody answered in 15 minutes, goes to the unblocker first. Then Evolve:
 * a failure that repeats on three tasks in a week becomes an issue for the factory, and its effect is
 * measured a week after it closes (`coordinator/evolve.ts`). In `trial`, the default, it records what it
 * would do and applies nothing, and Evolve only logs what it would file; `off` skips the pass.
 */
export default defineCron('coordinate', {
  schedule: '*/10 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(
    githubPass('coordinate', async () => {
      const mode = coordinatorModeFromEnv(process.env)
      if (mode === 'off') return
      let deps
      try {
        const actionsApi = createPromotionApi()
        deps = {
          ...actionDeps(),
          issues: createIssuesApi(),
          readIssue: (repo: string, number: number, token: string) =>
            fetchIssue(repo, number, token),
          drafter: modelScopeDrafter(),
          releaseMode: releaseModeFromEnv(process.env),
          ciChecks: actionsApi,
          unblocker: modelUnblocker(),
          checkReruns: actionsApi,
          answerInTransaction: inTransaction,
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'coordinate_not_configured', error: String(error) }))
        return
      }
      const result = await coordinate(deps, mode)
      if (Object.values(result).some((n) => n > 0)) {
        console.log(JSON.stringify({ event: 'coordinate', mode, ...result }))
      }
      const evolution = evolveDeps({ db: deps.db, github: deps.github, api: deps.api }, deps.issues)
      for (const line of evolveLog(await evolve(evolution, mode), mode)) console.log(line)
    }),
  ),
})
