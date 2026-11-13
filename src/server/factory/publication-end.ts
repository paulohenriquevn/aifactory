import { eq } from 'drizzle-orm'

import type { Database } from '../db'
import { publication, task } from '../db/schema'
import type { GithubApi } from '../github/pulls'

import { publishedPackagesChanged } from './changed-packages'
import {
  NOT_OPENED,
  releaseRunGraceOver,
  releaseRunOf,
  versionBranchFor,
  versionBranchWaits,
  versionPullRequestFrom,
} from './changesets'
import { createOwnTag, latestPreRelease, nextOwnTag } from './deliver'
import { shipContained, unclosedNote } from './ship'
import { enterStage } from './stages'
import { classify } from './watch'

type Publication = typeof publication.$inferSelect

export type EndDeps = { db: Database; api: GithubApi; now?: () => Date }

/** What came of a publication the release workflow opened no Version Packages pull request for. */
export type Ending = { wait: string } | { failed: string } | { released: string }

/**
 * Ends a publication whose release run finished without opening a Version Packages pull request, which it
 * does when no changeset waits on the release branch (theokit-plugins after #269: the changesets the factory
 * counted had been consumed by an earlier release). Nothing was published, so the publication would wait
 * forever. It waits while the grace window lasts, while a check on the promoted commit still runs, and
 * while none has reported. Then:
 *
 * - a failed check fails the publication: the release branch is red, and a person has to look;
 * - a promotion that changes a package changesets publishes fails it, naming the package, since nothing
 *   published it and a tag of the factory would not either;
 * - otherwise the promotion is released as the factory's own, as `release()` does for a changesets repository
 *   whose promotion changes no published package: the patch after the highest `v` tag, then every task the
 *   promotion contains is released and its issue closed.
 *
 * A failure is recorded on the publication and on the task's `released` stage, where the panel shows it.
 *
 * Before any of that, a version branch the release workflow pushed for this promotion without a pull request
 * gets one, and the publication waits for it: it never ends while such a branch waits.
 */
export async function endWithoutVersionPullRequest(
  deps: EndDeps,
  p: Publication,
  token: string,
): Promise<Ending> {
  const opened = await openFromVersionBranch(deps, p, token)
  if (opened) return opened
  if (!releaseRunGraceOver(p.startedAt, deps.now?.() ?? new Date())) return { wait: NOT_OPENED }
  const checks = await deps.api.commitChecks(p.repository, token, p.promotedSha)
  const run = releaseRunOf(classify(checks), p.promotedSha)
  if ('wait' in run) return run
  if ('failed' in run) {
    return fail(
      deps.db,
      p,
      `the release workflow opened no Version Packages pull request, and ${run.failed}: nothing was published`,
    )
  }
  const files = await deps.api.changedFiles(p.repository, token, `${p.promotedSha}^`, p.promotedSha)
  const published = await publishedPackagesChanged(deps.api, p.repository, token, {
    head: p.promotedSha,
    files,
  })
  if (published.length > 0) {
    return fail(
      deps.db,
      p,
      `${finishedWithout(p)}, so nothing was published, and the promotion changes ${published.join(', ')}: a changeset for it has to reach ${p.releaseBranch} for it to be published`,
    )
  }
  return releaseOwn(deps, p, token)
}

/**
 * Opens the Version Packages pull request from the version branch when the release workflow pushed it after
 * the promotion and opened none, which it does where the organisation does not let Actions open pull requests
 * (usetheokit/theokit). The next pass finds it and merges it once its checks are green.
 */
async function openFromVersionBranch(
  deps: EndDeps,
  p: Publication,
  token: string,
): Promise<Ending | undefined> {
  const head = versionBranchFor(p.releaseBranch)
  const branch = await deps.api.branchAhead(p.repository, token, p.releaseBranch, head)
  if (!versionBranchWaits(branch, p.startedAt)) return undefined
  const pr = await deps.api.openPullRequest(
    p.repository,
    token,
    versionPullRequestFrom(p.releaseBranch, p.promotedSha),
  )
  return {
    wait: `opened Version Packages #${pr.number} from ${head}, which the release workflow pushed without a pull request`,
  }
}

const finishedWithout = (p: Publication) =>
  `the release workflow finished on ${p.promotedSha.slice(0, 7)} without a Version Packages pull request`

async function fail(db: Database, p: Publication, reason: string): Promise<Ending> {
  await db
    .update(publication)
    .set({ status: 'failed', detail: reason })
    .where(eq(publication.id, p.id))
  await enterStage(db, p.taskId, 'released', {
    actor: p.actor,
    mergeSha: p.promotedSha,
    releaseError: reason,
  })
  return { failed: reason }
}

/**
 * Releases the promotion as the factory's own. The tag is chosen once and kept on the publication before it
 * is made, so a pass that fails after the tag and runs again makes the same one instead of the next.
 */
async function releaseOwn(deps: EndDeps, p: Publication, token: string): Promise<Ending> {
  const [row] = await deps.db.select().from(task).where(eq(task.id, p.taskId))
  const pre = await latestPreRelease(deps.db, p.taskId)
  if (!row || !pre) throw new Error(`task ${p.taskId} has no pre-release to release`)
  const tag = p.tags?.[0] ?? (await nextOwnTag(deps.api, p.repository, token, 'patch'))
  await deps.db
    .update(publication)
    .set({ tags: [tag] })
    .where(eq(publication.id, p.id))
  const created = await createOwnTag(deps.api, {
    row,
    pre,
    tag,
    token,
    mergeSha: p.promotedSha,
    actor: p.actor,
    promotion: {
      label: 'Promoted commit',
      url: `https://github.com/${p.repository}/commit/${p.promotedSha}`,
    },
  })
  const shipped = await shipContained(deps, {
    repository: p.repository,
    token,
    promotedSha: p.promotedSha,
    releaseBranch: p.releaseBranch,
    askedTaskId: p.taskId,
    actor: p.actor,
    tags: [created],
  })
  await deps.db
    .update(publication)
    .set({
      status: 'published',
      tags: [created.tag],
      publishedAt: new Date(),
      detail: `${finishedWithout(p)}, and the promotion changes no package changesets publishes, so the factory released it as ${created.tag}${unclosedNote(shipped)}`,
    })
    .where(eq(publication.id, p.id))
  return { released: created.tag }
}
