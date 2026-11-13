import { sql } from 'drizzle-orm'

import type { DoctorItemId, DoctorReport } from '../../shared/panel'
import { repository } from '../db/schema'
import { ensureBranches, integrationBranch } from '../factory/branches'
import { diagnose, publishMode, repairRefusal, type Repairable } from '../factory/doctor'
import { collectFacts, type DoctorSources } from '../factory/doctor-facts'
import { loadRepoConfig } from '../factory/repo-config'
import type { IssuesApi } from '../github/issues-api'
import type { GithubApi } from '../github/pulls'

import { ActionRefused } from './actions'
import { savedName } from './recipe'
import { FACTORY_LABEL_SPEC } from './work'

export type DoctorDeps = DoctorSources & {
  /** What the two repairs take on top of what the diagnosis reads. */
  api: DoctorSources['api'] & Pick<GithubApi, 'defaultBranch' | 'createBranch'>
  issues: Pick<IssuesApi, 'ensureLabel'>
  now?: () => Date
}

/**
 * Examines a repository the factory knows and keeps the report, with its time, in `repository.doctor`. The
 * way it publishes is kept in `repository.publish_mode` when it could be read, and left as it was when not.
 */
export async function repositoryDoctor(deps: DoctorDeps, fullName: string): Promise<DoctorReport> {
  const name = await savedName(deps.db, fullName)
  const facts = await collectFacts(deps, name)
  const report: DoctorReport = {
    fullName: name,
    at: (deps.now?.() ?? new Date()).toISOString(),
    items: diagnose(facts),
    publishMode: facts.publish.read ? publishMode(facts.publish.value) : null,
  }
  await deps.db
    .update(repository)
    .set({
      doctor: report,
      ...(report.publishMode ? { publishMode: report.publishMode } : {}),
    })
    .where(sql`lower(${repository.fullName}) = lower(${name})`)
  return report
}

/** What the App can do for a repository on its own: create the missing branches, create the label. */
const REPAIRS: Record<
  Repairable,
  (deps: DoctorDeps, name: string, token: string) => Promise<void>
> = {
  async branches(deps, name, token) {
    const config = await loadRepoConfig(deps.db, name)
    await ensureBranches(deps.api, name, token, {
      integration: integrationBranch(config),
      release: config.releaseBranch,
    })
  },
  async label(deps, name, token) {
    await deps.issues.ensureLabel(name, token, FACTORY_LABEL_SPEC)
  },
}

/**
 * Makes the repair of one item and examines the repository again. Only what the App can do is done; any
 * other item is refused with the reason it is not the factory's to repair.
 */
export async function repairRepository(
  deps: DoctorDeps,
  fullName: string,
  item: DoctorItemId,
): Promise<DoctorReport> {
  const name = await savedName(deps.db, fullName)
  const refused = repairRefusal(item)
  if (refused !== undefined) throw new ActionRefused(refused)
  try {
    const { token } = await deps.github.installationToken(name)
    await REPAIRS[item as Repairable](deps, name, token)
  } catch (error) {
    throw new ActionRefused(
      `${name} could not be repaired: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return repositoryDoctor(deps, name)
}
