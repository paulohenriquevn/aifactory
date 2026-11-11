import { defineCron } from 'theokit/server/cron'

import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { pollPublications } from '../factory/publish'
import { mainProcessOnly } from '../factory/worker-only'
import { createGithubApi } from '../github/pulls'

/**
 * Carries a release in a repository that publishes with changesets to npm, every minute: merges the Version
 * Packages pull request once its checks are green, then, when the repository's workflow has published,
 * releases the tasks that shipped and closes their issues with the versions. It also merges the back-merge
 * the repository opens from the release branch into the integration branch, once its checks are green.
 */
export default defineCron('publish-changesets', {
  schedule: '* * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    let deps
    try {
      deps = factoryDeps()
    } catch (error) {
      console.error(
        JSON.stringify({ event: 'publish_changesets_not_configured', error: String(error) }),
      )
      return
    }
    const result = await pollPublications({
      db: getDb(),
      github: deps.github,
      api: createGithubApi(),
    })
    const changed = result.merged.length + result.published.length + result.backMerged.length
    if (changed > 0 || result.errors.length > 0) {
      console.log(JSON.stringify({ event: 'publish_changesets', ...result }))
    }
  }),
})
