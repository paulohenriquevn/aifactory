import { and, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { decision, releaseWait, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import { completeRelease, latestPreRelease } from './deliver'
import { decideWaitingRelease, type ReleaseStep } from './release-wait'

export type AwaitReleaseDeps = {
  db: Database
  github: GithubApp
  api: GithubApi
  now?: () => Date
}

export type AwaitReleaseResult = {
  released: number[]
  refused: number[]
  waiting: number
  /** What stopped a release on this pass; it is looked at again on the next one. */
  errors: string[]
}

type Waiting = typeof releaseWait.$inferSelect

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * GitHub merged the release pull request at the pinned head: the release finishes as a direct merge does,
 * from the same code. The wait is claimed first, so a second pass that sees the same merge does nothing.
 */
async function finish(
  deps: AwaitReleaseDeps,
  wait: Waiting,
  token: string,
  mergeSha: string,
): Promise<boolean> {
  const claimed = await deps.db
    .update(releaseWait)
    .set({ status: 'merged', endedAt: deps.now?.() ?? new Date() })
    .where(and(eq(releaseWait.id, wait.id), eq(releaseWait.status, 'waiting')))
    .returning({ id: releaseWait.id })
  if (claimed.length === 0) return false
  try {
    const [row] = await deps.db.select().from(task).where(eq(task.id, wait.taskId))
    const pre = await latestPreRelease(deps.db, wait.taskId)
    if (!pre) throw new Error('there is no pre-release for this work')
    await completeRelease(deps, {
      row,
      pre,
      pull: { number: wait.pullRequestNumber, url: wait.pullRequestUrl },
      token,
      target: wait.releaseBranch,
      sha: wait.sha,
      mergeSha,
      changesets: wait.changesets,
      bump: wait.bump,
      actor: wait.actor,
    })
  } catch (error) {
    // The promotion is on the release branch either way: what failed after it stays on the wait, for a person.
    await deps.db
      .update(releaseWait)
      .set({ detail: `merged at ${mergeSha}, but finishing the release failed: ${message(error)}` })
      .where(eq(releaseWait.id, wait.id))
    throw error
  }
  return true
}

/**
 * The release does not happen, and the reason stays on the wait for the panel to show. It is not tried
 * again: a person looks at the release pull request and asks for the release again.
 */
async function refuse(
  deps: AwaitReleaseDeps,
  wait: Waiting,
  token: string,
  step: Extract<ReleaseStep, { kind: 'refuse' }>,
): Promise<boolean> {
  let reason = step.reason
  if (step.stopAutoMerge) {
    // Off first, so a later push to the pre-release branch cannot merge unseen. Failing to is said, not hidden.
    try {
      await deps.api.disableAutoMerge(wait.repository, token, wait.pullRequestNumber)
    } catch (error) {
      reason = `${reason}; turning auto-merge off failed: ${message(error)}`
    }
  }
  const moved = await deps.db
    .update(releaseWait)
    .set({ status: 'refused', detail: reason, endedAt: deps.now?.() ?? new Date() })
    .where(and(eq(releaseWait.id, wait.id), eq(releaseWait.status, 'waiting')))
    .returning({ id: releaseWait.id })
  if (moved.length === 0) return false
  if (wait.actor.startsWith('agent:')) {
    await deps.db.insert(decision).values({
      taskId: wait.taskId,
      kind: 'would_release',
      sha: wait.sha,
      note: `an automatic release was refused: ${reason}`,
    })
  }
  return true
}

async function look(deps: AwaitReleaseDeps, wait: Waiting, result: AwaitReleaseResult) {
  const { token } = await deps.github.installationToken(wait.repository)
  const step = decideWaitingRelease({
    pinnedSha: wait.sha,
    releaseBranch: wait.releaseBranch,
    pull: await deps.api.readPullRequest(wait.repository, token, wait.pullRequestNumber),
    required: await deps.api.requiredChecks(wait.repository, token, wait.releaseBranch),
    reports: await deps.api.checkReports(wait.repository, token, wait.sha),
    waitedMs: (deps.now?.() ?? new Date()).getTime() - wait.startedAt.getTime(),
  })
  switch (step.kind) {
    case 'wait':
      result.waiting += 1
      return
    case 'finish':
      if (await finish(deps, wait, token, step.mergeSha)) result.released.push(wait.taskId)
      return
    case 'refuse':
      if (await refuse(deps, wait, token, step)) result.refused.push(wait.taskId)
  }
}

/**
 * Looks at every release whose pull request waits for the release branch's required checks, and takes each
 * one step further: see `decideWaitingRelease`. A release that cannot be looked at (GitHub failed) is
 * recorded and looked at again on the next pass.
 */
export async function pollAwaitingReleases(deps: AwaitReleaseDeps): Promise<AwaitReleaseResult> {
  const result: AwaitReleaseResult = { released: [], refused: [], waiting: 0, errors: [] }
  const waits = await deps.db
    .select()
    .from(releaseWait)
    .where(eq(releaseWait.status, 'waiting'))
    .orderBy(releaseWait.id)
  for (const wait of waits) {
    try {
      await look(deps, wait, result)
    } catch (error) {
      result.errors.push(`task ${wait.taskId}: ${message(error)}`)
    }
  }
  return result
}
