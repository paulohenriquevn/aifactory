import { and, asc, count, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { coordinatorAction, publication, releaseWait, repository, task, watch } from '../db/schema'
import { PRE_RELEASE_BRANCH, releaseBranchOf } from '../factory/branches'
import type { ReleaseMode } from '../factory/deliver'
import { readOf, unread, type Read } from '../factory/doctor'
import { WORKING } from '../factory/transitions'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import type { ReadIssue } from './draft'
import type { ReleasedIssue } from './exceptions'
import {
  attemptDue,
  trainHolds,
  type ReleaseBranchState,
  type RepositoryReleaseFacts,
} from './release-train'

/**
 * What the release train reads of each enabled repository, and nothing else: its release mode, its tasks
 * with integrated work, the ones still working, a release or a publication in flight, the last watch of its
 * release branch, then, only when the train does not hold it, the head of the pre-release branch, the
 * decisions already recorded on that head, the release that waited on it and the labels of the issues. It
 * decides nothing (`release-train.ts` does). A read of GitHub that fails is handed over as not read and
 * becomes an `unknown` exception.
 */

export type ReleaseFactsDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  api: Pick<GithubApi, 'branchAhead' | 'defaultBranch' | 'contains'>
  readIssue: ReadIssue
  /** The release mode of a repository that has none of its own (`FACTORY_RELEASE_MODE`). */
  releaseMode: ReleaseMode
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A task queued, running, or waiting for the integration branch's checks: its work would join the release. */
const WORKING_STAGES = ['intake', ...WORKING] as const

async function releasable(db: Database, repo: string) {
  const rows = await db
    .select({
      taskId: task.id,
      issueNumber: task.issueNumber,
      mergedSha: task.mergedSha,
      resolvedSha: task.resolvedSha,
    })
    .from(task)
    .where(
      and(
        eq(task.repository, repo),
        eq(task.stage, 'done'),
        or(isNotNull(task.mergedSha), isNotNull(task.resolvedSha)),
      ),
    )
    // Integrated work first: it is the anchor a release needs, and a resolved task can only anchor one
    // once the pre-release branch holds its commit.
    .orderBy(sql`${task.mergedSha} is null`, asc(task.id))
  return rows.map((r) => ({
    taskId: r.taskId,
    issueNumber: r.issueNumber,
    ...(r.mergedSha || !r.resolvedSha ? {} : { resolvedSha: r.resolvedSha }),
  }))
}

/**
 * The candidates the release at `head` carries: integrated work, and resolved work only when `head` holds its
 * resolving commit, so a task `develop` lacks is neither the anchor nor counted in the bump.
 */
async function carried(
  deps: ReleaseFactsDeps,
  f: RepositoryReleaseFacts,
  token: string,
  head: string,
): Promise<RepositoryReleaseFacts['releasable']> {
  const kept: RepositoryReleaseFacts['releasable'] = []
  const held = new Map<string, boolean>()
  for (const t of f.releasable) {
    if (t.resolvedSha) {
      if (!held.has(t.resolvedSha))
        held.set(t.resolvedSha, await deps.api.contains(f.repository, token, head, t.resolvedSha))
      if (!held.get(t.resolvedSha)) continue
    }
    kept.push(t)
  }
  return kept
}

async function working(db: Database, repo: string) {
  const [row] = await db
    .select({ n: count() })
    .from(task)
    .where(
      and(
        eq(task.repository, repo),
        or(inArray(task.stage, [...WORKING_STAGES]), isNotNull(task.awaitingCiSha)),
      ),
    )
  return Number(row.n)
}

async function inFlight(db: Database, repo: string): Promise<string | undefined> {
  const [waiting] = await db
    .select({ url: releaseWait.pullRequestUrl })
    .from(releaseWait)
    .where(and(eq(releaseWait.repository, repo), eq(releaseWait.status, 'waiting')))
  if (waiting) return `a release waits for the checks of ${waiting.url}`
  const [publishing] = await db
    .select({ id: publication.id })
    .from(publication)
    .where(and(eq(publication.repository, repo), eq(publication.status, 'waiting')))
  return publishing ? `publication ${publishing.id} has not finished` : undefined
}

/**
 * The release branch as `watch-main` last saw it: still watching the last release, red until a person says
 * they dealt with it, or green (a green or silent watch, or no release yet).
 */
async function branchState(db: Database, repo: string) {
  const [last] = await db
    .select({ status: watch.status, detail: watch.detail, acknowledgedAt: watch.acknowledgedAt })
    .from(watch)
    .where(eq(watch.repository, repo))
    .orderBy(desc(watch.id))
    .limit(1)
  const red = (last?.status === 'red' || last?.status === 'reverting') && !last.acknowledgedAt
  const state: ReleaseBranchState = last?.status === 'watching' ? 'watching' : red ? 'red' : 'green'
  return { state, detail: last?.detail ?? `the last release of ${repo} is ${last?.status}` }
}

const RELEASE_ATTEMPTS = ['release_ready', 'release_retry'] as const

/** The release decisions of the repository on this head, on whichever of its tasks they were recorded. */
async function attempts(db: Database, repo: string, head: string) {
  return db
    .select({
      kind: coordinatorAction.exceptionKind,
      outcome: coordinatorAction.outcome,
      reason: coordinatorAction.reason,
    })
    .from(coordinatorAction)
    .innerJoin(task, eq(task.id, coordinatorAction.taskId))
    .where(
      and(
        eq(task.repository, repo),
        eq(coordinatorAction.headSha, head),
        inArray(coordinatorAction.exceptionKind, [...RELEASE_ATTEMPTS]),
        ne(coordinatorAction.outcome, 'trial'),
      ),
    )
    .orderBy(asc(coordinatorAction.id))
}

/** Why the release that waited for the release branch's checks on this head was refused, if it was. */
async function waitRefusal(db: Database, repo: string, head: string) {
  const [refused] = await db
    .select({ detail: releaseWait.detail })
    .from(releaseWait)
    .where(
      and(
        eq(releaseWait.repository, repo),
        eq(releaseWait.sha, head),
        eq(releaseWait.status, 'refused'),
      ),
    )
    .orderBy(desc(releaseWait.id))
    .limit(1)
  return refused?.detail ?? undefined
}

/** The head of the pre-release branch and how many commits it holds that the release branch lacks. */
async function readHead(
  deps: ReleaseFactsDeps,
  repo: { fullName: string; releaseBranch: string | null },
  token: string,
): Promise<{ head: Read<string>; ahead?: number }> {
  const tried = `the head of ${PRE_RELEASE_BRANCH} of ${repo.fullName}`
  try {
    const base = await releaseBranchOf(deps.api, repo.fullName, token, repo)
    const branch = await deps.api.branchAhead(repo.fullName, token, base, PRE_RELEASE_BRANCH)
    if (!branch)
      return { head: unread(tried, `${repo.fullName} has no ${PRE_RELEASE_BRANCH} branch`) }
    return { head: readOf(branch.sha), ahead: branch.aheadBy }
  } catch (error) {
    return { head: unread(tried, message(error)) }
  }
}

async function readLabels(
  deps: ReleaseFactsDeps,
  f: RepositoryReleaseFacts,
  token: string,
): Promise<Read<ReleasedIssue[]>> {
  try {
    const issues = await Promise.all(
      f.releasable.map((t) => deps.readIssue(f.repository, t.issueNumber, token)),
    )
    return readOf(issues.map((issue) => ({ issue: issue.number, labels: issue.labels })))
  } catch (error) {
    return unread(`the issues ${f.repository} would release`, message(error))
  }
}

/** What GitHub and the record say of a repository the train does not hold. */
async function lookFurther(
  deps: ReleaseFactsDeps,
  f: RepositoryReleaseFacts,
  releaseBranch: string | null,
): Promise<RepositoryReleaseFacts> {
  let token: string
  try {
    token = (await deps.github.installationToken(f.repository)).token
  } catch (error) {
    return { ...f, head: unread(`a token for ${f.repository}`, message(error)) }
  }
  const { head, ahead } = await readHead(deps, { fullName: f.repository, releaseBranch }, token)
  if (!head.read) return { ...f, head }
  let held: RepositoryReleaseFacts['releasable']
  try {
    held = await carried(deps, f, token, head.value)
  } catch (error) {
    return {
      ...f,
      head: unread(
        `whether ${PRE_RELEASE_BRANCH} of ${f.repository} holds resolved work`,
        message(error),
      ),
    }
  }
  const seen: RepositoryReleaseFacts = {
    ...f,
    releasable: held,
    head,
    ahead,
    attempts: await attempts(deps.db, f.repository, head.value),
    waitRefusal: await waitRefusal(deps.db, f.repository, head.value),
  }
  return attemptDue(seen) ? { ...seen, labels: await readLabels(deps, seen, token) } : seen
}

/** The release facts of every enabled repository whose release mode is not `manual`. */
export async function readReleaseFacts(deps: ReleaseFactsDeps): Promise<RepositoryReleaseFacts[]> {
  const repos = await deps.db
    .select({
      fullName: repository.fullName,
      releaseMode: repository.releaseMode,
      releaseBranch: repository.releaseBranch,
    })
    .from(repository)
    .where(eq(repository.enabled, true))
    .orderBy(asc(repository.id))
  const out: RepositoryReleaseFacts[] = []
  for (const repo of repos) {
    const mode = repo.releaseMode ?? deps.releaseMode
    if (mode === 'manual') continue
    const f: RepositoryReleaseFacts = {
      repository: repo.fullName,
      mode,
      releasable: await releasable(deps.db, repo.fullName),
      working: await working(deps.db, repo.fullName),
      inFlight: await inFlight(deps.db, repo.fullName),
      branch: await branchState(deps.db, repo.fullName),
    }
    out.push(trainHolds(f) ? f : await lookFurther(deps, f, repo.releaseBranch))
  }
  return out
}
