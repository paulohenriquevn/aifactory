import type { Database } from '../db'
import { decision } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import { PRE_RELEASE_BRANCH } from './branches'
import { release } from './deliver'
import type { ReleaseMode } from './deliver'

/** What the factory handed over, or why it could not. A failure to hand over never fails the task. */
export type Handed = { tag: string; url: string } | { error: string }

/** Where the pre-release branch is after an integration, or why it could not follow. */
export type Advanced = {
  /** The pre-release branch advanced, and this is where it is. */
  developSha?: string
  developError?: string
  /**
   * Where the work waits to reach the pre-release branch when GitHub would not let the factory advance it
   * (a protected branch): a pull request from the integration branch, which the factory only opens.
   */
  developPullRequest?: string
}

/** What the integration did, or why it did not happen. Nothing set means it did not run. */
export type Integrated = Advanced & {
  /** The pull request was merged, and this is the commit on the integration branch. */
  mergedSha?: string
  /** GitHub refused to merge the pull request, which stays open for a person. */
  error?: string
  /**
   * The integration branch requires these checks, so GitHub merges the pull request through auto-merge once
   * they pass, and the `integrate-after-ci` cron finishes the integration then.
   */
  awaitingChecks?: string[]
}

export const describeIntegration = (integrated: Integrated) => ({
  ...(integrated.error ? { integrationError: integrated.error } : {}),
  ...(integrated.mergedSha ? { mergedSha: integrated.mergedSha } : {}),
  ...(integrated.developSha ? { developSha: integrated.developSha } : {}),
  ...(integrated.developError ? { developError: integrated.developError } : {}),
  ...(integrated.developPullRequest ? { developPullRequest: integrated.developPullRequest } : {}),
  ...(integrated.awaitingChecks ? { awaitingChecks: integrated.awaitingChecks } : {}),
})

export const describeDelivery = (handed: Handed) =>
  'tag' in handed
    ? { preRelease: handed.tag, preReleaseUrl: handed.url }
    : { preReleaseError: handed.error }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A protected pre-release branch only takes a pull request, so the factory opens one from the integration
 * branch, or finds the one already open, and leaves the merge to whoever the branch's rules ask. It is one
 * standing pull request: later integrations add to it. Failing to open it is not an error: the work is
 * integrated either way.
 */
async function proposePreRelease(
  api: GithubApi,
  repository: string,
  token: string,
  from: string,
): Promise<string | undefined> {
  try {
    return (
      await api.openPullRequest(repository, token, {
        head: from,
        base: PRE_RELEASE_BRANCH,
        title: `Pre-release: ${from} into ${PRE_RELEASE_BRANCH}`,
        body: `${PRE_RELEASE_BRANCH} accepts changes only through a pull request, so the factory could not advance it. Merging this pull request publishes what has been integrated into ${from}.`,
      })
    ).url
  } catch {
    return undefined
  }
}

/**
 * What follows a merge into the integration branch, however it was made: the pre-release branch advances to
 * include it, or, when GitHub will not let the factory write there, a pull request waits for whoever may.
 */
export async function advancePreRelease(
  api: GithubApi,
  input: { repository: string; token: string; integration: string; mergedSha: string },
): Promise<Advanced> {
  try {
    const develop = await api.mergeBranch(
      input.repository,
      input.token,
      PRE_RELEASE_BRANCH,
      input.mergedSha,
    )
    return { developSha: develop.sha }
  } catch (error) {
    return {
      developError: message(error),
      developPullRequest: await proposePreRelease(
        api,
        input.repository,
        input.token,
        input.integration,
      ),
    }
  }
}

/**
 * What the release mode says to do once a commit is delivered and approved. `trial` records what an agent
 * would have released; `auto` releases it, and records why when that is refused. It returns the tag of a
 * release that was made.
 */
export async function releaseByMode(
  deps: { db: Database; github: GithubApp; api: GithubApi },
  input: { taskId: number; sha: string; mode: ReleaseMode | undefined; actor: string },
): Promise<string | undefined> {
  const { taskId, sha, actor } = input
  const record = (note: string) =>
    deps.db.insert(decision).values({ taskId, kind: 'would_release', sha, note })
  if (input.mode === 'trial') {
    await record(`${actor}: checks green and the review approved`)
    return undefined
  }
  if (input.mode !== 'auto') return undefined
  try {
    return (await release(deps, taskId, { bump: 'patch', actor })).tag
  } catch (error) {
    await record(`an automatic release was refused: ${message(error)}`)
    return undefined
  }
}
