import { and, eq, isNotNull, or } from 'drizzle-orm'

import type { Database } from '../db'
import { delivery, publication, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { GithubApi, PublishedRelease } from '../github/pulls'

import { isPackageTag, versionBranchFor } from './changesets'
import { enterStage } from './stages'
import { classify } from './watch'

export type PublishDeps = { db: Database; github: GithubApp; api: GithubApi }

export type PublishResult = {
  /** Publications whose Version Packages pull request was merged, by the factory or seen merged. */
  merged: number[]
  /** Publications whose packages are out, with their tasks released. */
  published: number[]
  waiting: number
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
  if (pr.draft) return { wait: `${name} is a draft` }
  const seen = classify(await deps.api.commitChecks(p.repository, token, pr.headSha))
  if (seen.state === 'red') {
    return { wait: `checks failed on ${name}: ${seen.failing.join(', ')}` }
  }
  if (seen.state !== 'green') return { wait: `the checks on ${name} are not green yet` }
  await deps.api.mergePullRequest(p.repository, token, pr.number, pr.headSha, { method: 'merge' })
  return { merged: pr.number }
}

const availableIn = (tags: PublishedRelease[], p: Publication) =>
  [
    `Available in ${tags.map((t) => `\`${t.tag}\` (${t.url})`).join(', ')}.`,
    '',
    `Released by ${p.actor}: the promotion \`${p.promotedSha.slice(0, 7)}\` to \`${p.releaseBranch}\`, published by the repository's release workflow.`,
    '',
  ].join('\n')

/**
 * Releases every task whose work is in the promoted commit: the one that asked for the release, and each
 * finished task integrated before it. A task already holding a delivery of these tags is left alone, so a
 * pass that runs again does not comment twice.
 */
async function shipTasks(
  deps: PublishDeps,
  p: Publication,
  token: string,
  tags: PublishedRelease[],
) {
  const candidates = await deps.db
    .select()
    .from(task)
    .where(
      and(
        eq(task.repository, p.repository),
        isNotNull(task.mergedSha),
        or(eq(task.stage, 'done'), eq(task.id, p.taskId)),
      ),
    )
  for (const t of candidates) {
    const known = await deps.db
      .select({ id: delivery.id })
      .from(delivery)
      .where(and(eq(delivery.taskId, t.id), eq(delivery.tag, tags[0].tag)))
    if (known.length > 0) continue
    const shipped =
      t.id === p.taskId ||
      (await deps.api.contains(p.repository, token, p.promotedSha, t.mergedSha!))
    if (!shipped) continue
    await deps.db.insert(delivery).values(
      tags.map((tag) => ({
        taskId: t.id,
        kind: 'release' as const,
        tag: tag.tag,
        url: tag.url,
        sha: p.promotedSha,
        actor: p.actor,
      })),
    )
    await enterStage(deps.db, t.id, 'released', {
      actor: p.actor,
      tag: tags.map((tag) => tag.tag).join(', '),
      url: tags[0].url,
      mergeSha: p.promotedSha,
      published: 'changesets',
    })
    await deps.api.commentOnIssue(p.repository, token, t.issueNumber, availableIn(tags, p))
    await deps.api.closeIssue(p.repository, token, t.issueNumber)
  }
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
  await shipTasks(deps, p, token, tags)
  await deps.db
    .update(publication)
    .set({
      status: 'published',
      tags: tags.map((t) => t.tag),
      publishedAt: new Date(),
      detail: `${merged}published ${tags.map((t) => t.tag).join(', ')}`,
    })
    .where(eq(publication.id, p.id))
  result.published.push(p.id)
}

/**
 * Looks at every publication still waiting. A failure on one is recorded on it and the others go on; the
 * next pass tries it again. Nothing here merges anything but a Version Packages pull request.
 */
export async function pollPublications(deps: PublishDeps): Promise<PublishResult> {
  const result: PublishResult = { merged: [], published: [], waiting: 0, errors: [] }
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
  return result
}
