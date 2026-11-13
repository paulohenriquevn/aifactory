import { and, asc, eq, sql } from 'drizzle-orm'

import type { Database } from '../db'
import {
  decision,
  delivery,
  evidence,
  publication,
  releaseWait,
  repository,
  review,
  task,
  watch,
} from '../db/schema'
import type { GithubApp } from '../github/app'
import { autoMergeOrMergeable, type GithubApi } from '../github/pulls'

import { PRE_RELEASE_BRANCH, releaseBranchOf } from './branches'
import { publishedPackagesChanged } from './changed-packages'
import { addedChangesets, usesChangesets } from './changesets'
import { highestVersion, nextVersion, preReleaseNotes, preReleaseTag, type Bump } from './release'
import { shipContained } from './ship'
import { enterStage } from './stages'
import { outcome } from './transitions'

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
 * Hands the work over as a pre-release: a tag, marked as a pre-release, with the evidence in its notes.
 * It needs nobody's leave, because it moves nothing on the default branch.
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
    /** The commit that was verified and reviewed: the evidence is keyed by it. */
    sha: string
    /** The commit the tag points at, when it is not `sha` (the pre-release branch after an integration). */
    tagSha?: string
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
    tag: preReleaseTag(input.issueNumber, input.tagSha ?? input.sha),
    sha: input.tagSha ?? input.sha,
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
      sha: input.tagSha ?? input.sha,
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
  /** The promotion's merge commit; undefined while the release waits for the release branch's checks. */
  mergeSha: string | undefined
  /** The merge happened but the release object could not be created. */
  releaseError?: string
  /** The repository publishes with changesets: its own workflow tags the release, and a publication waits. */
  publishing?: 'changesets'
  /**
   * The release branch requires these checks, so nothing merged yet: GitHub merges the release pull request
   * through auto-merge once they pass, and the `integrate-after-ci` cron finishes the release then.
   */
  awaitingChecks?: string[]
  /** The release pull request, when the release waits for its checks. */
  pullRequestUrl?: string
  /**
   * Issues of released tasks that could not be commented on or closed, as `#<number>: <why>`. The release
   * stands; each is also on its task's `released` stage.
   */
  issueErrors?: string[]
}

/** What came of the promotion: the factory's own release, or a publication left to changesets. */
type Published = {
  created?: { tag: string; url: string }
  releaseError?: string
  publishing?: 'changesets'
}

/**
 * Promotes the pre-release branch to the release branch (the default one): a pull request from `develop`
 * is opened, or the one already open is taken, and merged, and a full release is created on the merge.
 * It is a promotion of the branch, so everything on `develop` goes with the item that was asked for.
 *
 * It refuses unless the item was integrated (its pull request was merged into the integration branch),
 * has a pre-release and green checks, and the pull request from `develop` is open and not a draft. The
 * merge is pinned to the commit seen, so a push that lands between the look and the merge makes GitHub
 * refuse it instead of merging something unseen.
 *
 * A release branch that requires status checks cannot take the merge before they report, so the release
 * waits instead: auto-merge is turned on, pinned to the same commit, and `pollAwaitingReleases` finishes the
 * release (the tag, or the publication of a changesets repository) once GitHub merges it.
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
  const allowed = outcome(row, 'release')
  if (allowed.kind !== 'action') throw new ReleaseRefused(allowed.reason)
  // Only integrated work with a commit is released.
  const headSha = row.headSha!
  const pre = await latestPreRelease(deps.db, taskId)
  if (!pre) throw new ReleaseRefused('there is no pre-release for this work')
  const checks = await latestChecks(deps.db, taskId, headSha)
  if (checks.length === 0 || checks.some((c) => !c.passed)) {
    throw new ReleaseRefused('the checks are not green on this commit')
  }

  const { token } = await deps.github.installationToken(row.repository)
  const [saved] = await deps.db
    .select({ releaseBranch: repository.releaseBranch })
    .from(repository)
    .where(sql`lower(${repository.fullName}) = lower(${row.repository})`)
  const target = await releaseBranchOf(deps.api, row.repository, token, saved ?? {})
  const usesChangesets = await changesetsToShip(deps, row.repository, token, target)
  let opened: { number: number; url: string }
  try {
    opened = await deps.api.openPullRequest(row.repository, token, {
      head: PRE_RELEASE_BRANCH,
      base: target,
      title: `Release: ${row.issueTitle}`,
      body: [
        `Promotes \`${PRE_RELEASE_BRANCH}\` to \`${target}\`, with #${row.issueNumber}: ${row.issueTitle}.`,
        '',
        `Pre-release: \`${pre.tag}\` (${pre.url}). Everything on \`${PRE_RELEASE_BRANCH}\` is released with it.`,
        '',
      ].join('\n'),
    })
  } catch (error) {
    throw new ReleaseRefused(
      `the pull request from ${PRE_RELEASE_BRANCH} to ${target} could not be opened: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const pr = await deps.api.findPullRequest(row.repository, token, PRE_RELEASE_BRANCH)
  if (!pr || pr.number !== opened.number)
    throw new ReleaseRefused('the release pull request was not found')
  if (pr.state !== 'open') throw new ReleaseRefused('the release pull request is closed')
  if (pr.draft) throw new ReleaseRefused('the release pull request is a draft: mark it ready first')
  const sha = pr.headSha
  const pull = { number: pr.number, url: pr.url }
  const required = await deps.api.requiredChecks(row.repository, token, target)
  if (required.length > 0) {
    const waited = await waitForChecks(deps, {
      row,
      pull,
      sha,
      target,
      token,
      required,
      changesets: usesChangesets,
      ...options,
    })
    // A clean pull request already passed the checks, so it is merged below like one with none required.
    if (waited !== 'mergeable') return waited
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
    merged = await deps.api.mergePullRequest(row.repository, token, pr.number, sha, {
      method: 'merge',
    })
  } catch (error) {
    await deps.db.update(task).set({ stage: 'done' }).where(eq(task.id, taskId))
    throw new ReleaseRefused(
      `GitHub did not merge it: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return completeRelease(deps, {
    row,
    pre,
    pull,
    token,
    target,
    sha,
    mergeSha: merged.sha,
    changesets: usesChangesets,
    ...options,
  })
}

/** The latest pre-release of a task: what a release promotes. */
export async function latestPreRelease(db: Database, taskId: number) {
  const [pre] = (
    await db
      .select()
      .from(delivery)
      .where(and(eq(delivery.taskId, taskId), eq(delivery.kind, 'prerelease')))
      .orderBy(asc(delivery.id))
  ).slice(-1)
  return pre
}

/** What finishing a release needs, whether the factory merged the promotion or GitHub did. */
type Promotion = {
  row: typeof task.$inferSelect
  pull: { number: number; url: string }
  token: string
  target: string
  /** The head of the release pull request that was promoted. */
  sha: string
  changesets: boolean
  bump: Bump
  actor: string
}

/**
 * Leaves the promotion to GitHub: auto-merge is turned on, pinned to the head seen, and the release waits
 * in `release_wait` for the release branch's required checks. A repository has one release pull request, so
 * a second release while one waits is refused; GitHub refusing auto-merge refuses the release and says why.
 * When GitHub refuses because the pull request is already clean, nothing waits: the claim is dropped and
 * `mergeable` tells the caller to merge it itself.
 */
async function waitForChecks(
  deps: DeliverDeps,
  input: Promotion & { required: string[] },
): Promise<ReleaseResult | 'mergeable'> {
  const { row, pull, token } = input
  const [waiting] = await deps.db
    .select({ pullRequestUrl: releaseWait.pullRequestUrl })
    .from(releaseWait)
    .where(and(eq(releaseWait.repository, row.repository), eq(releaseWait.status, 'waiting')))
  const busy = () =>
    new ReleaseRefused(
      `a release of ${row.repository} already waits for the checks of ${waiting?.pullRequestUrl ?? pull.url}`,
    )
  if (waiting) throw busy()
  const [claimed] = await deps.db
    .insert(releaseWait)
    .values({
      taskId: row.id,
      repository: row.repository,
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.url,
      sha: input.sha,
      releaseBranch: input.target,
      bump: input.bump,
      actor: input.actor,
      changesets: input.changesets,
      checks: input.required,
    })
    .onConflictDoNothing()
    .returning({ id: releaseWait.id })
  if (!claimed) throw busy()
  let next: 'waiting' | 'mergeable'
  try {
    next = await autoMergeOrMergeable(deps.api, {
      repo: row.repository,
      token,
      number: pull.number,
      sha: input.sha,
    })
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    await deps.db
      .update(releaseWait)
      .set({ status: 'refused', detail: why, endedAt: new Date() })
      .where(eq(releaseWait.id, claimed.id))
    throw new ReleaseRefused(why)
  }
  if (next === 'mergeable') {
    await deps.db.delete(releaseWait).where(eq(releaseWait.id, claimed.id))
    return 'mergeable'
  }
  return {
    tag: undefined,
    url: undefined,
    mergeSha: undefined,
    awaitingChecks: input.required,
    pullRequestUrl: pull.url,
    ...(input.changesets ? { publishing: 'changesets' as const } : {}),
  }
}

/**
 * What follows the promotion's merge, however it was made: the factory's own release or the publication a
 * changesets repository makes, the watch on the merge commit, and the task's move to `released`. With its own
 * tag, every task whose merge the promotion contains is released too, and each issue is told the version
 * and closed; a changesets publication does the same once its packages are out (`publish.ts`).
 */
export async function completeRelease(
  deps: DeliverDeps,
  input: Promotion & { pre: typeof delivery.$inferSelect; mergeSha: string },
): Promise<ReleaseResult> {
  const { row, pre, pull, token, target, sha, mergeSha, actor } = input
  const taskId = row.id
  const published: Published = input.changesets
    ? await handToChangesets(deps, { row, target, mergeSha, actor })
    : await createOwnRelease(deps, { row, pre, pr: pull, token, mergeSha, bump: input.bump, actor })
  const { created, releaseError, publishing } = published

  // The merge is on the default branch now, so its checks are watched from here on.
  await deps.db.insert(watch).values({
    taskId,
    repository: row.repository,
    sha: mergeSha,
    pullRequestNumber: pull.number,
    tag: created?.tag ?? null,
  })
  await deps.db.insert(decision).values({
    taskId,
    kind: 'release',
    sha,
    note: [actor, created?.tag, publishing].filter(Boolean).join(' -> '),
  })
  if (created) {
    // Every task whose work the promotion carries is released with this one, and its issue closed.
    const shipped = await shipContained(deps, {
      repository: row.repository,
      token,
      promotedSha: mergeSha,
      releaseBranch: target,
      askedTaskId: taskId,
      actor,
      tags: [created],
      detail: { sha },
    })
    return { tag: created.tag, url: created.url, mergeSha, issueErrors: shipped.issueErrors }
  }
  await enterStage(deps.db, taskId, 'released', {
    actor,
    mergeSha,
    sha,
    ...(releaseError ? { releaseError } : {}),
    publishing,
  })
  return { tag: undefined, url: undefined, mergeSha, releaseError, publishing }
}

/**
 * Whether the release is left to changesets: true when the repository publishes with changesets and a
 * changeset waits, which is one the pre-release branch added since its merge base with the release branch
 * (`addedChangesets`). With none waiting, what the same comparison lists decides. A change only to packages changesets never publishes (private, ignored,
 * or no package at all) is the factory's own release, since no changeset can exist for them and reaching the
 * release branch is what makes them available. A change to a published package is refused, naming it: the
 * promotion would land and the package would not be published.
 */
async function changesetsToShip(
  deps: Pick<DeliverDeps, 'api'>,
  repo: string,
  token: string,
  target: string,
): Promise<boolean> {
  if (
    !usesChangesets(await deps.api.listDirectory(repo, token, '.changeset', PRE_RELEASE_BRANCH))
  ) {
    return false
  }
  const files = await deps.api.changedFiles(repo, token, target, PRE_RELEASE_BRANCH)
  if (addedChangesets(files).length > 0) return true
  const published = await publishedPackagesChanged(deps.api, repo, token, {
    head: PRE_RELEASE_BRANCH,
    files,
  })
  if (published.length > 0) {
    throw new ReleaseRefused(
      `${PRE_RELEASE_BRANCH} has no changeset, and it changes ${published.join(', ')} since ${target}, so nothing of that would be published: this repository releases with changesets, and its release workflow publishes only what a .changeset/*.md file describes`,
    )
  }
  return false
}

/**
 * Leaves the version to the repository's release workflow and records the publication the
 * `publish-changesets` cron carries on: the Version Packages merge, then the published tags.
 */
async function handToChangesets(
  deps: Pick<DeliverDeps, 'db'>,
  input: { row: typeof task.$inferSelect; target: string; mergeSha: string; actor: string },
): Promise<Published> {
  await deps.db.insert(publication).values({
    taskId: input.row.id,
    repository: input.row.repository,
    releaseBranch: input.target,
    promotedSha: input.mergeSha,
    actor: input.actor,
  })
  return { publishing: 'changesets' }
}

/** The version the factory's own release of a repository takes next: the one after its highest `v` tag. */
export async function nextOwnTag(
  api: GithubApi,
  repo: string,
  token: string,
  bump: Bump,
): Promise<string> {
  return nextVersion(highestVersion(await api.versionTags(repo, token)), bump)
}

/** What the factory's own release of a promotion is made of. */
export type OwnRelease = {
  row: typeof task.$inferSelect
  pre: typeof delivery.$inferSelect
  /** What the notes link the promotion by: the release pull request, or the merge commit. */
  promotion: { label: string; url: string }
  token: string
  mergeSha: string
  tag: string
  actor: string
}

/**
 * Creates the full release of a promotion, and its tag, on the merge commit. Asking twice for one tag returns
 * the first (`createRelease`), so a pass that runs again releases once.
 */
export async function createOwnTag(
  api: GithubApi,
  input: OwnRelease,
): Promise<{ tag: string; url: string }> {
  const { row, pre, tag } = input
  const made = await api.createRelease(row.repository, input.token, {
    tag,
    sha: input.mergeSha,
    name: `${tag}: ${row.issueTitle}`,
    body: [
      `Release of #${row.issueNumber}: ${row.issueTitle}.`,
      '',
      `Promoted from the pre-release \`${pre.tag}\` (${pre.url}) by ${input.actor}.`,
      `${input.promotion.label}: ${input.promotion.url}`,
      `Pull request of the work: ${row.pullRequestUrl ?? input.promotion.url}`,
      '',
    ].join('\n'),
    prerelease: false,
  })
  return { tag: made.tag, url: made.url }
}

/**
 * Tags the promotion with the version after the highest `v` tag and creates its release, for a repository
 * that does not publish with changesets, or one whose promotion changes no package changesets publishes.
 * A failure is returned, not thrown: the merge already happened.
 */
async function createOwnRelease(
  deps: Pick<DeliverDeps, 'api'>,
  input: Omit<OwnRelease, 'tag' | 'promotion'> & { pr: { url: string }; bump: Bump },
): Promise<Published> {
  const { row, pr, token } = input
  try {
    const tag = await nextOwnTag(deps.api, row.repository, token, input.bump)
    const promotion = { label: 'Release pull request', url: pr.url }
    return { created: await createOwnTag(deps.api, { ...input, tag, promotion }) }
  } catch (error) {
    return { releaseError: error instanceof Error ? error.message : String(error) }
  }
}
