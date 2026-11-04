import { defineCron } from 'theokit/server/cron'

import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { inTransaction } from '../factory/resume-queue'
import { SNAPSHOT_TTL_MS } from '../factory/vercel-sandbox'
import { pollAnswers } from '../factory/waiting'
import { createGithubApi } from '../github/pulls'

/**
 * Looks for answers to the questions agents asked, every minute. A comment webhook would be quicker,
 * but it needs another event on the GitHub App, and a poll also covers a server that was down when
 * the person replied.
 */
export default defineCron('poll-answers', {
  schedule: '* * * * *',
  async handler() {
    let deps
    try {
      deps = factoryDeps()
    } catch (error) {
      console.error(JSON.stringify({ event: 'poll_answers_not_configured', error: String(error) }))
      return
    }
    const result = await pollAnswers({
      db: getDb(),
      github: deps.github,
      api: createGithubApi(),
      inTransaction,
      deleteSnapshot: deps.sandbox.deleteSnapshot?.bind(deps.sandbox),
      ttlMs: SNAPSHOT_TTL_MS,
    })
    if (result.answered.length > 0 || result.expired.length > 0) {
      console.log(JSON.stringify({ event: 'poll_answers', ...result }))
    }
  },
})
