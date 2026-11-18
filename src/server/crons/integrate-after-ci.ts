import { defineCron } from 'theokit/server/cron'

import { adoptMergedHandoffs, pollAwaitingIntegrations } from '../factory/await-ci'
import { pollAwaitingReleases } from '../factory/await-release'
import { releaseModeFromEnv } from '../factory/deps'
import { adoptPromotions, pollPromotionWaits, promoteResolved } from '../factory/promotion-merge'
import { passLine } from '../factory/pass-line'
import { mainProcessOnly } from '../factory/worker-only'
import { createPromotionApi } from '../github/promotion-api'
import {
  mergeFixedBase,
  sendBackAutomatically,
  sendBackConflictAutomatically,
} from '../panel/actions'
import { actionDeps } from '../panel/deps'
import { githubPass } from '../github/budget-pass'

/**
 * Finishes the integrations that wait for a repository's required checks, every two minutes: once GitHub
 * merged the verified commit, the pre-release branch advances and the pre-release is made; a required check
 * that failed sends the work back to its agent, with the error lines read from its log or annotations, and
 * what the factory may not decide goes to a person.
 * Releases that wait for the release branch's required checks are finished the same way: once GitHub merged
 * the release pull request, the release is made; a failed check refuses it, with the reason, for a person.
 * Promotions into the pre-release branch are looked at first: one GitHub merged ends its hold, so the
 * integrations it held out go in on the same pass, and one whose head moved is pinned to the new head. An
 * open promotion that nothing waits on, while integrated work waits for a release, is pinned the same way.
 * A pull request a handoff left, once a person merged it, is integrated from that merge (`adoptMergedHandoffs`).
 */
export default defineCron('integrate-after-ci', {
  schedule: '*/2 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(
    githubPass(
      'integrate-after-ci',
      async () => {
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
        const github = { db: deps.db, github: deps.github, api: deps.api }
        const passes: [string, () => Promise<Record<string, unknown>>][] = [
          ['promotion_after_ci', () => pollPromotionWaits(github)],
          ['promotion_adopted', () => adoptPromotions(github)],
          ['promotion_resolved', () => promoteResolved(github)],
          [
            'integrate_after_ci',
            () =>
              pollAwaitingIntegrations({
                ...github,
                checks: createPromotionApi(),
                releaseMode: releaseModeFromEnv(process.env),
                sendBack: (taskId, note) => sendBackAutomatically(actions, taskId, note),
                mergeBase: (taskId, note) => mergeFixedBase(actions, taskId, note),
                sendBackConflict: (taskId, base) =>
                  sendBackConflictAutomatically(actions, taskId, base),
              }),
          ],
          [
            'handoff_merged',
            () => adoptMergedHandoffs({ ...github, releaseMode: releaseModeFromEnv(process.env) }),
          ],
          ['release_after_ci', () => pollAwaitingReleases(github)],
        ]
        // In this order: a promotion GitHub merged ends its hold, so the integrations it held go in on this pass.
        for (const [event, pass] of passes) {
          const line = passLine(event, await pass())
          if (line) console.log(line)
        }
      },
      { waitsForLimit: true },
    ),
  ),
})
