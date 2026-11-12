import { desc, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { publication, repository } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import { integrationBranch } from './branches'
import { isPackageTag, pickBackMerge, versionBranchFor } from './changesets'
import { shipContained } from './ship'
import { classify } from './watch'

export type PublishDeps = { db: Database; github: GithubApp; api: GithubApi }

export type PublishResult = {
  /** Publications whose Version Packages pull request was merged, by the factory or seen merged. */
  merged: number[]
  /** Publications whose packages are out, with their tasks released. */
  published: number[]
  waiting: number
  /** Back-merges from the release branch into the integration branch merged on this pass, as `repo#number`. */
  backMerged: string[]
  /** What stopped a publication on this pass; it is looked at again on the next one. */
  errors: string[]
}

type Publication = typeof publication.$inferSelect

/** Where the Version Packages pull request is: merged (its number), or why the publication waits. */
type VersionStep = { merged: number } | { wait: string }

const NOT_OPENED =
  'no Version Packages pull request yet: the release workflow opens it after the promotion'

/**
 * Takes the Version Packages pull request as far as it can: merged when its checks are green, pinned to the
 * head that was looked at. The owner's decision to release covers it, since without it the promotion
 * publishes nothing. It is the only pull request this step merges.
 */
async function mergeVersionPullRequest(
  deps: PublishDeps,
  p: Publication,
  token: string,
): Promise<VersionStep> {
  const pr = await deps.api.findPullRequest(p.repository, token, versionBranchFor(p.releaseBranch))
  if (!pr) return { wait: NOT_OPENED }
  const name = `Version Packages #${pr.number}`
  if (pr.merged) {
    // One merged before this promotion belongs to an earlier release.
    const after = pr.mergedAt !== undefined && pr.mergedAt.getTime() >= p.startedAt.getTime()
    return after ? { merged: pr.number } : { wait: NOT_OPENED }
  }
  if (pr.state === 'closed') return { wait: `${name} was closed without being merged` }
  return mergeWhenGreen(deps, p.repository, token, pr, name)
}

/**
 * Merges an open pull request with a merge commit once the checks on its head are green, pinned to that
 * head, so a push between the look and the merge makes GitHub refuse it. A draft, or checks that failed,
 * still run or are missing, leave it open for a later pass.
 */
async function mergeWhenGreen(
  deps: PublishDeps,
  repo: string,
  token: string,
  pr: { number: number; headSha: string; draft: boolean },
  name: string,
): Promise<VersionStep> {
  if (pr.draft) return { wait: `${name} is a draft` }
  const seen = classify(await deps.api.commitChecks(repo, token, pr.headSha))
  if (seen.state === 'red') {
    return { wait: `checks failed on ${name}: ${seen.failing.join(', ')}` }
  }
  if (seen.state !== 'green') return { wait: `the checks on ${name} are not green yet` }
  await deps.api.mergePullRequest(repo, token, pr.number, pr.headSha, { method: 'merge' })
  return { merged: pr.number }
}

const note = (db: Database, id: number, detail: string) =>
  db.update(publication).set({ detail }).where(eq(publication.id, id))

/** One publication, one step further: the Version Packages merge, then the published versions. */
async function advance(deps: PublishDeps, p: Publication, result: PublishResult) {
  const { token } = await deps.github.installationToken(p.repository)
  let merged = ''
  if (p.versionPullRequest === null) {
    const step = await mergeVersionPullRequest(deps, p, token)
    if ('wait' in step) {
      await note(deps.db, p.id, step.wait)
      result.waiting += 1
      return
    }
    merged = `merged Version Packages #${step.merged} for ${p.actor}; `
    await deps.db
      .update(publication)
      .set({ versionPullRequest: step.merged, detail: merged })
      .where(eq(publication.id, p.id))
    result.merged.push(p.id)
  }
  const tags = (await deps.api.releasesSince(p.repository, token, p.startedAt)).filter((r) =>
    isPackageTag(r.tag),
  )
  if (tags.length === 0) {
    await note(deps.db, p.id, `${merged}waiting for the release workflow to publish`)
    result.waiting += 1
    return
  }
  const shipped = await shipContained(deps, {
    repository: p.repository,
    token,
    promotedSha: p.promotedSha,
    releaseBranch: p.releaseBranch,
    askedTaskId: p.taskId,
    actor: p.actor,
    tags,
    publishedBy: "the repository's release workflow",
    detail: { published: 'changesets' },
  })
  const unclosed = shipped.issueErrors.length
    ? `; issues not closed: ${shipped.issueErrors.join('; ')}`
    : ''
  await deps.db
    .update(publication)
    .set({
      status: 'published',
      tags: tags.map((t) => t.tag),
      publishedAt: new Date(),
      detail: `${merged}published ${tags.map((t) => t.tag).join(', ')}${unclosed}`,
    })
    .where(eq(publication.id, p.id))
  result.published.push(p.id)
}

/**
 * The repositories a back-merge is looked for in: each enabled one that has had a changesets release, with
 * the release branch of its latest publication and its integration branch.
 */
async function releasedRepositories(db: Database) {
  const rows = await db
    .select({
      repo: publication.repository,
      release: publication.releaseBranch,
      baseBranch: repository.baseBranch,
    })
    .from(publication)
    .innerJoin(repository, eq(repository.fullName, publication.repository))
    .where(eq(repository.enabled, true))
    .orderBy(desc(publication.startedAt))
  const latest = new Map<string, { repo: string; release: string; integration: string }>()
  for (const r of rows) {
    if (latest.has(r.repo)) continue
    latest.set(r.repo, { repo: r.repo, release: r.release, integration: integrationBranch(r) })
  }
  return [...latest.values()]
}

/**
 * Merges the back-merge of each released repository once its checks pass; while they fail or run it stays
 * open, and the next pass looks again. The owner's decision to release covers it: the release already put
 * those commits on the release branch, and the integration branch has to hold them for its checks to pass.
 */
async function mergeBackMerges(deps: PublishDeps, result: PublishResult) {
  for (const branches of await releasedRepositories(deps.db)) {
    try {
      const { token } = await deps.github.installationToken(branches.repo)
      const open = await deps.api.openPullRequestsBetween(
        branches.repo,
        token,
        branches.release,
        branches.integration,
      )
      const pr = pickBackMerge(open, branches)
      if (!pr) continue
      const name = `the back-merge #${pr.number} from ${branches.release} into ${branches.integration}`
      const step = await mergeWhenGreen(deps, branches.repo, token, pr, name)
      if ('merged' in step) result.backMerged.push(`${branches.repo}#${step.merged}`)
    } catch (error) {
      result.errors.push(
        `${branches.repo}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * Looks at every publication still waiting. A failure on one is recorded on it and the others go on; the
 * next pass tries it again. Then it merges each released repository's back-merge whose checks pass. Those
 * are the only two pull requests this step merges: a Version Packages one and a back-merge.
 */
export async function pollPublications(deps: PublishDeps): Promise<PublishResult> {
  const result: PublishResult = {
    merged: [],
    published: [],
    waiting: 0,
    backMerged: [],
    errors: [],
  }
  const waiting = await deps.db.select().from(publication).where(eq(publication.status, 'waiting'))
  for (const p of waiting) {
    try {
      await advance(deps, p, result)
    } catch (error) {
      const message = `${p.repository}: ${error instanceof Error ? error.message : String(error)}`
      result.errors.push(message)
      await note(deps.db, p.id, message)
    }
  }
  await mergeBackMerges(deps, result)
  return result
}
