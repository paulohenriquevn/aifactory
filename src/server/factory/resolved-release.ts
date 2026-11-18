import { and, asc, eq, gt, isNotNull, isNull, or } from 'drizzle-orm'

import type { Database } from '../db'
import { publication, releaseWait, repository, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { Issue } from '../github/issues'
import type { GithubApi } from '../github/pulls'

import { errorMessage } from './error-message'
import { releaseBranchOf } from './branches'
import { enterStage } from './stages'

/**
 * A task that finished with no change: `done`, resolved at a commit of the integration branch, nothing
 * merged. Its issue was closed when it was resolved by the agent, but not when a person resolved it from the
 * panel, and no tag carries it, so what makes it released is its resolving commit reaching the release
 * branch. A release closes the issue that is still open (`afterRelease`).
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
  /**
   * Runs for each task as it is released, with its issue. A release that has a tag uses it to tell the
   * issue where the fix is; a catch-up has none. It runs after the stage changed. It returns what went wrong, never throws.
   */
  afterRelease?: (row: {
    id: number
    repository: string
    issueNumber: number
  }) => Promise<string | undefined>
}

export type ResolvedReleased = {
  released: number[]
  /** What `afterRelease` reported, as `#<issue>: <why>`. The release stands. */
  issueErrors?: string[]
  /** Tasks that could not be checked, as `task <id> (<repo>#<issue>): <why>`. A later pass tries again. */
  errors: string[]
}

const message = errorMessage

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
      // The issue is told only once the task is released: a transition that failed leaves it for a retry.
      const issueError = await view.afterRelease?.(row)
      result.released.push(row.id)
      if (issueError) (result.issueErrors ??= []).push(issueError)
    } catch (error) {
      result.errors.push(`task ${row.id} (${row.repository}#${row.issueNumber}): ${message(error)}`)
    }
  }
  return result
}

/**
 * Tells an issue where the fix is and closes it, only when it is still open: the agent closed the issue it
 * found fixed, a person resolving from the panel did not. A state GitHub does not say is not taken as open.
 * A failure is returned as `#<issue>: <why>`, not thrown: the release already happened.
 */
export async function closeOpenIssue(
  api: Pick<GithubApi, 'commentOnIssue' | 'closeIssue'>,
  readIssue: (issueNumber: number) => Promise<Pick<Issue, 'state'>>,
  repo: string,
  token: string,
  issueNumber: number,
  body: string,
): Promise<string | undefined> {
  try {
    if ((await readIssue(issueNumber)).state !== 'open') return undefined
    await api.commentOnIssue(repo, token, issueNumber, body)
    await api.closeIssue(repo, token, issueNumber)
    return undefined
  } catch (error) {
    return `#${issueNumber}: ${message(error)}`
  }
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

/** How long after a release wait or a publication began or ended a catch-up still leaves its tasks to it. */
export const SHIPMENT_GRACE_MS = 15 * 60 * 1000

/**
 * Whether the repository has a release or publication that ships its resolved tasks itself: one waiting,
 * or one that began or ended inside the grace, when its shipment may be between its merge and its tasks.
 * A changesets publication closes the issues only once the packages are out, so catch-up never gets ahead of it.
 */
async function shipping(db: Database, repo: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - SHIPMENT_GRACE_MS)
  const [wait] = await db
    .select({ id: releaseWait.id })
    .from(releaseWait)
    .where(
      and(
        eq(releaseWait.repository, repo),
        or(eq(releaseWait.status, 'waiting'), gt(releaseWait.endedAt, since)),
      ),
    )
    .limit(1)
  if (wait) return true
  const [publishing] = await db
    .select({ id: publication.id })
    .from(publication)
    .where(
      and(
        eq(publication.repository, repo),
        or(eq(publication.status, 'waiting'), gt(publication.startedAt, since)),
      ),
    )
    .limit(1)
  return publishing !== undefined
}

/**
 * Catches up the tasks that finished with no change before a release could move them, `limit` at a time:
 * each is compared with the head of its repository's release branch (the owner's choice, or the default
 * branch). `next` is where the following pass starts, and 0 once a pass reaches the last task, so a task
 * whose commit is not there yet is looked at again later. A released task no longer matches, so running it
 * again changes nothing. An issue still open is closed with a comment that names the branch, as no tag is known here.
 */
export async function catchUpResolved(
  deps: {
    db: Database
    app: Pick<GithubApp, 'installationToken'>
    api: Pick<GithubApi, 'contains' | 'defaultBranch' | 'commentOnIssue' | 'closeIssue'>
    /** How an issue is read before it is closed; without it a catch-up leaves issues alone. */
    now?: () => Date
    fetchIssue?: (repo: string, issueNumber: number, token: string) => Promise<Pick<Issue, 'state'>>
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
      // Checked here, just before the tasks move, not once per pass: a release may have begun meanwhile.
      if (await shipping(deps.db, repo, deps.now?.() ?? new Date())) continue
      const { token } = await deps.app.installationToken(repo)
      const branch = await releaseBranchOf(deps.api, repo, token, mine[0])
      const view = {
        repository: repo,
        token,
        releaseRef: branch,
        releaseBranch: branch,
      }
      // A release that is landing may not have shipped these tasks yet, and once they are `released` it
      // never will: an issue still open is closed here, so no pass leaves one open.
      const read = deps.fetchIssue
      const afterRelease = read
        ? (row: { issueNumber: number }) =>
            closeOpenIssue(
              deps.api,
              (n) => read(repo, n, token),
              repo,
              token,
              row.issueNumber,
              `Released: the commit this was resolved at is on \`${branch}\`.`,
            )
        : undefined
      const done = await releaseEach(deps, { ...view, actor: 'factory', afterRelease }, mine)
      result.released.push(...done.released)
      if (done.issueErrors) (result.issueErrors ??= []).push(...done.issueErrors)
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
