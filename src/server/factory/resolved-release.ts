import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm'

import type { Database } from '../db'
import { repository, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import { releaseBranchOf } from './branches'
import { enterStage } from './stages'

/**
 * A task that finished with no change: `done`, resolved at a commit of the integration branch, nothing
 * merged. Its issue was closed when it was resolved, and no tag carries it, so what makes it released is
 * its resolving commit reaching the release branch.
 */
const resolvedNotReleased = and(
  eq(task.stage, 'done'),
  isNotNull(task.resolvedSha),
  isNull(task.mergedSha),
)

type ResolvedTask = Pick<typeof task.$inferSelect, 'id' | 'repository' | 'issueNumber'> & {
  resolvedSha: string | null
}

/** Where to look for the resolving commits of one repository, and what the `released` stage records. */
export type ReleaseBranchView = {
  repository: string
  token: string
  /** What is compared with each resolving commit: the release branch, or a commit on it. */
  releaseRef: string
  releaseBranch: string
  actor: string
  /** The commit a release promoted, when a release is what brought the commit there. */
  mergeSha?: string
}

export type ResolvedReleased = {
  released: number[]
  /** Tasks that could not be checked, as `task <id> (<repo>#<issue>): <why>`. A later pass tries again. */
  errors: string[]
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Releases each of the tasks whose resolving commit `releaseRef` contains. A commit is compared once,
 * however many tasks it resolved. A task GitHub cannot compare is recorded and the others go on.
 */
async function releaseEach(
  deps: { db: Database; api: Pick<GithubApi, 'contains'> },
  view: ReleaseBranchView,
  rows: ResolvedTask[],
): Promise<ResolvedReleased> {
  const result: ResolvedReleased = { released: [], errors: [] }
  const onBranch = new Map<string, Promise<boolean>>()
  for (const row of rows) {
    const sha = row.resolvedSha!
    if (!onBranch.has(sha)) {
      onBranch.set(sha, deps.api.contains(view.repository, view.token, view.releaseRef, sha))
    }
    try {
      if (!(await onBranch.get(sha))) continue
      await enterStage(deps.db, row.id, 'released', {
        actor: view.actor,
        releaseBranch: view.releaseBranch,
        resolvedSha: sha,
        ...(view.mergeSha ? { mergeSha: view.mergeSha } : {}),
      })
      result.released.push(row.id)
    } catch (error) {
      result.errors.push(`task ${row.id} (${row.repository}#${row.issueNumber}): ${message(error)}`)
    }
  }
  return result
}

const columns = {
  id: task.id,
  repository: task.repository,
  issueNumber: task.issueNumber,
  resolvedSha: task.resolvedSha,
}

/**
 * Releases every task of the repository that finished with no change and whose resolving commit is on the
 * release branch, as seen from `releaseRef`. A release calls it once it lands (`shipContained`).
 */
export async function releaseResolved(
  deps: { db: Database; api: Pick<GithubApi, 'contains'> },
  view: ReleaseBranchView,
): Promise<ResolvedReleased> {
  const rows = await deps.db
    .select(columns)
    .from(task)
    .where(and(eq(task.repository, view.repository), resolvedNotReleased))
    .orderBy(asc(task.id))
  return releaseEach(deps, view, rows)
}

export type CatchUpPage = {
  /** The last task id the previous pass looked at; 0 starts from the first. */
  after: number
  limit: number
}

/**
 * Catches up the tasks that finished with no change before a release could move them, `limit` at a time:
 * each is compared with the head of its repository's release branch (the owner's choice, or the default
 * branch). `next` is where the following pass starts, and 0 once a pass reaches the last task, so a task
 * whose commit is not there yet is looked at again later. A released task no longer matches, so running it
 * again changes nothing.
 */
export async function catchUpResolved(
  deps: {
    db: Database
    app: Pick<GithubApp, 'installationToken'>
    api: Pick<GithubApi, 'contains' | 'defaultBranch'>
  },
  page: CatchUpPage,
): Promise<ResolvedReleased & { next: number }> {
  const rows = await deps.db
    .select({ ...columns, releaseBranch: repository.releaseBranch })
    .from(task)
    .leftJoin(repository, eq(repository.fullName, task.repository))
    .where(and(resolvedNotReleased, gt(task.id, page.after)))
    .orderBy(asc(task.id))
    .limit(page.limit)
  const result: ResolvedReleased = { released: [], errors: [] }
  for (const repo of new Set(rows.map((r) => r.repository))) {
    const mine = rows.filter((r) => r.repository === repo)
    try {
      const { token } = await deps.app.installationToken(repo)
      const branch = await releaseBranchOf(deps.api, repo, token, mine[0])
      const view = { repository: repo, token, releaseRef: branch, releaseBranch: branch }
      const done = await releaseEach(deps, { ...view, actor: 'factory' }, mine)
      result.released.push(...done.released)
      result.errors.push(...done.errors)
    } catch (error) {
      result.errors.push(`${repo}: ${message(error)}`)
    }
  }
  const next = rows.length < page.limit ? 0 : rows[rows.length - 1].id
  return { ...result, next }
}

/** Tasks resolved with no change one pass of the `catch-up` cron compares with their release branch. */
export const RESOLVED_PER_PASS = 25

type CatchUpDeps = Parameters<typeof catchUpResolved>[0]

/**
 * The `catch-up` cron's pass over resolved tasks: it keeps where the last pass stopped (a restart begins
 * again from the first task, which is harmless) and logs a pass that released or failed something.
 */
export function resolvedCatchUp(limit = RESOLVED_PER_PASS) {
  let after = 0
  return async (deps: CatchUpDeps): Promise<ResolvedReleased & { next: number }> => {
    const result = await catchUpResolved(deps, { after, limit })
    after = result.next
    if (result.released.length > 0 || result.errors.length > 0) {
      console.log(JSON.stringify({ event: 'catch_up_resolved', ...result }))
    }
    return result
  }
}
