import { eq } from 'drizzle-orm'

import type { SetupReport } from '../../shared/panel'
import { getDb } from '../db'
import { repository } from '../db/schema'
import { withClaudeToken } from '../factory/claude-token'
import { githubAppFromEnv } from '../factory/deps'
import { knowledgeStatus } from '../knowledge/sync'

import { setupReport } from './setup'
import { realProbes } from './setup-probes'

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
  return setupReport({
    env: withClaudeToken(env),
    github,
    enabledRepositories: enabled.length,
    knowledge: await knowledgeStatus(getDb()),
    probes: realProbes,
  })
}
