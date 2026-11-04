import { route } from 'theokit/server/define'

import { getDb } from '../../db'
import { githubAppFromEnv } from '../../factory/deps'
import { ownerOnly } from '../../panel/policy'
import { setupReport } from '../../panel/setup'
import { repository } from '../../db/schema'
import { eq } from 'drizzle-orm'

export const GET = route()
  .policy(ownerOnly)
  .handler(async () => {
    let github
    try {
      github = githubAppFromEnv()
    } catch {
      // Without the App's credentials the report says so as its first line.
    }
    const enabled = await getDb()
      .select({ id: repository.id })
      .from(repository)
      .where(eq(repository.enabled, true))
    return setupReport({ env: process.env, github, enabledRepositories: enabled.length })
  })
  .build()
