import { eq } from 'drizzle-orm'

import type { SetupReport } from '../../shared/panel'
import { getDb } from '../db'
import { repository } from '../db/schema'
import { githubAppFromEnv } from '../factory/deps'

import { setupReport } from './setup'

/** What stands between this install and a first pull request, read from the environment and from GitHub. */
export async function readSetup(env: NodeJS.ProcessEnv = process.env): Promise<SetupReport> {
  let github
  try {
    github = githubAppFromEnv(env)
  } catch {
    // Without the App's credentials the report says so as its first line.
  }
  const enabled = await getDb()
    .select({ id: repository.id })
    .from(repository)
    .where(eq(repository.enabled, true))
  return setupReport({ env, github, enabledRepositories: enabled.length })
}
