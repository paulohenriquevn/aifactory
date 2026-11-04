import { and, asc, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { decision, delivery, evidence, review, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import { nextVersion, preReleaseNotes, preReleaseTag, type Bump } from './release'
import { enterStage } from './stages'

/** How the factory treats a release (the promotion), as opposed to the pre-release it always makes. */
export type ReleaseMode =
  /** Only a person releases, from the panel. */
  | 'manual'
  /** Records what an agent would have released, and releases nothing. */
  | 'trial'
  /** The factory releases a commit that has green checks and an approving review. */
  | 'auto'

export type DeliverDeps = { db: Database; github: GithubApp; api: GithubApi }

/** The latest result of each check on a commit. Empty means nothing was verified. */
async function latestChecks(db: Database, taskId: number, sha: string) {
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.taskId, taskId), eq(evidence.sha, sha)))
    .orderBy(asc(evidence.id))
  const byName = new Map(rows.map((r) => [r.name, r]))
  return [...byName.values()]
}

/**
 * Hands the work over as a pre-release: a tag on the pushed commit, marked as a pre-release, with the
 * evidence in its notes. It needs nobody's leave, because it moves nothing on the default branch.
 * Every commit the factory delivers gets its own, and asking twice for one returns the first.
 */
export async function createPreRelease(
  deps: Pick<DeliverDeps, 'db' | 'api'>,
  input: {
    taskId: number
    repository: string
    token: string
    issueNumber: number
    title: string
    sha: string
    pullRequestUrl: string | undefined
    attempts: number
    costUsd: number
    agentSummary: string
  },
): Promise<{ tag: string; url: string }> {
  const checks = await latestChecks(deps.db, input.taskId, input.sha)
  const [latestReview] = (
    await deps.db
      .select()
      .from(review)
      .where(eq(review.taskId, input.taskId))
      .orderBy(asc(review.id))
  ).slice(-1)
  const { name, body } = preReleaseNotes({
    issueNumber: input.issueNumber,
    title: input.title,
    sha: input.sha,
    pullRequestUrl: input.pullRequestUrl,
    checks,
    review:
      latestReview && latestReview.sha === input.sha
        ? {
            reviewer: latestReview.reviewer,
            verdict: latestReview.verdict,
            summary: latestReview.summary,
          }
        : undefined,
    attempts: input.attempts,
    costUsd: input.costUsd,
    agentSummary: input.agentSummary,
  })
  const created = await deps.api.createRelease(input.repository, input.token, {
    tag: preReleaseTag(input.issueNumber, input.sha),
    sha: input.sha,
    name,
    body,
    prerelease: true,
  })
  const known = await deps.db
    .select({ id: delivery.id })
    .from(delivery)
    .where(and(eq(delivery.taskId, input.taskId), eq(delivery.tag, created.tag)))
  if (known.length === 0) {
    await deps.db.insert(delivery).values({
      taskId: input.taskId,
      kind: 'prerelease',
      tag: created.tag,
      url: created.url,
      sha: input.sha,
      actor: 'factory',
    })
  }
  return { tag: created.tag, url: created.url }
}

/** A release was asked for and something about the work does not allow it. The reason is shown as is. */
export class ReleaseRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseRefused'
  }
}

export type ReleaseResult = {
  tag: string | undefined
  url: string | undefined
  mergeSha: string
  /** The merge happened but the release object could not be created. */
  releaseError?: string
}

/**
 * Promotes a pre-released commit: merges its pull request and creates a full release. It refuses
 * unless the commit has a pre-release, green checks, and a pull request that is open, not a draft
 * and still at that commit, and the merge itself is pinned to that commit, so a push that lands
 * between the look and the merge makes GitHub refuse it instead of merging something unseen.
 *
 * `actor` is who decided: `human` from the panel, `agent:<name>` when an agent's approval was enough.
 */
export async function release(
  deps: DeliverDeps,
  taskId: number,
  options: { bump: Bump; actor: string },
): Promise<ReleaseResult> {
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new ReleaseRefused(`task ${taskId} does not exist`)
  if (row.stage === 'released') throw new ReleaseRefused('this task was already released')
  if (row.stage !== 'done' || !row.headSha) {
    throw new ReleaseRefused('only a finished task with a pull request can be released')
  }
  const sha = row.headSha
  const [pre] = await deps.db
    .select()
    .from(delivery)
    .where(and(eq(delivery.taskId, taskId), eq(delivery.kind, 'prerelease'), eq(delivery.sha, sha)))
  if (!pre)
    throw new ReleaseRefused('there is no pre-release for the commit the pull request is at')
  const checks = await latestChecks(deps.db, taskId, sha)
  if (checks.length === 0 || checks.some((c) => !c.passed)) {
    throw new ReleaseRefused('the checks are not green on this commit')
  }

  const { token } = await deps.github.installationToken(row.repository)
  const pr = await deps.api.findPullRequest(row.repository, token, `factory/${row.issueNumber}`)
  if (!pr) throw new ReleaseRefused('the pull request was not found')
  if (pr.merged) throw new ReleaseRefused('the pull request was already merged')
  if (pr.state !== 'open') throw new ReleaseRefused('the pull request is closed')
  if (pr.draft) throw new ReleaseRefused('the pull request is a draft: mark it ready first')
  if (pr.headSha !== sha) {
    throw new ReleaseRefused(
      `the pull request moved to ${pr.headSha.slice(0, 7)}, which was not delivered (${sha.slice(0, 7)} was)`,
    )
  }

  // Takes the task so two clicks cannot merge twice. It is given back if the merge does not happen.
  const claimed = await deps.db
    .update(task)
    .set({ stage: 'released' })
    .where(and(eq(task.id, taskId), eq(task.stage, 'done')))
    .returning({ id: task.id })
  if (claimed.length === 0) throw new ReleaseRefused('this task is being released')

  let merged: { sha: string }
  try {
    merged = await deps.api.mergePullRequest(row.repository, token, pr.number, sha, 'squash')
  } catch (error) {
    await deps.db.update(task).set({ stage: 'done' }).where(eq(task.id, taskId))
    throw new ReleaseRefused(
      `GitHub did not merge it: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let created: { tag: string; url: string } | undefined
  let releaseError: string | undefined
  try {
    const latest = await deps.api.latestReleaseTag(row.repository, token)
    const tag = nextVersion(latest, options.bump)
    const made = await deps.api.createRelease(row.repository, token, {
      tag,
      sha: merged.sha,
      name: `${tag}: ${row.issueTitle}`,
      body: [
        `Release of #${row.issueNumber}: ${row.issueTitle}.`,
        '',
        `Promoted from the pre-release \`${pre.tag}\` (${pre.url}) by ${options.actor}.`,
        `Pull request: ${row.pullRequestUrl ?? pr.url}`,
        '',
      ].join('\n'),
      prerelease: false,
    })
    created = { tag: made.tag, url: made.url }
  } catch (error) {
    releaseError = error instanceof Error ? error.message : String(error)
  }

  await deps.db.insert(decision).values({
    taskId,
    kind: 'release',
    sha,
    note: `${options.actor}${created ? ` -> ${created.tag}` : ''}`,
  })
  if (created) {
    await deps.db.insert(delivery).values({
      taskId,
      kind: 'release',
      tag: created.tag,
      url: created.url,
      sha: merged.sha,
      actor: options.actor,
    })
  }
  await enterStage(deps.db, taskId, 'released', {
    actor: options.actor,
    mergeSha: merged.sha,
    sha,
    ...(created ? { tag: created.tag, url: created.url } : {}),
    ...(releaseError ? { releaseError } : {}),
  })
  return { tag: created?.tag, url: created?.url, mergeSha: merged.sha, releaseError }
}
