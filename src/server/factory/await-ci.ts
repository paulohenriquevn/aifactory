import { and, desc, eq, isNotNull } from 'drizzle-orm'

import type { Database } from '../db'
import { review, stageEvent, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { CheckReport, GithubApi } from '../github/pulls'
import { automaticRunsSincePerson } from '../panel/queries'

import { integrationBranch } from './branches'
import { attachEvidence, rerunTransient, type EvidenceApi, type RerunMemo } from './check-evidence'
import {
  checksFeedback,
  decideWaitingIntegration,
  evidenceOfNote,
  type FailedReport,
  type WaitingStep,
} from './ci-wait'
import { createPreRelease, type ReleaseMode } from './deliver'
import { counterpart } from './doctor'
import type { CheckSpec } from './evidence'
import {
  advancePreRelease,
  describeDelivery,
  describeIntegration,
  releaseByMode,
  type Handed,
} from './integration'
import { loadRepoConfig } from './repo-config'

export type AwaitCiDeps = {
  db: Database
  github: GithubApp
  api: GithubApi
  /** Reads the log or annotations of a failed check, so the note carries what the sandbox cannot open. */
  checks: EvidenceApi
  /** The factory's release mode, for a repository that sets none. */
  releaseMode: ReleaseMode | undefined
  now?: () => Date
  /** The reruns already asked for, so the next pass waits for them; the process's own by default. */
  reruns?: RerunMemo
  /** Runs the task again on its branch with the note as feedback (the panel's `sendBackAutomatically`). */
  sendBack: (taskId: number, note: string) => Promise<void>
  /** Runs the task again from the new base (the panel's `retryAutomatically`). */
  startOver: (taskId: number) => Promise<void>
}

export type AwaitCiResult = {
  merged: number[]
  sentBack: number[]
  /** Tasks whose failed jobs were rerun once, in case the failure was not of the work. */
  rerun: number[]
  startedOver: number[]
  toPerson: number[]
  waiting: number
  /** What stopped a task on this pass; it is looked at again on the next one. */
  errors: string[]
  /** Failed checks whose evidence GitHub would not give: the work went back with their links only. */
  unreadEvidence: string[]
}

type Waiting = {
  row: typeof task.$inferSelect
  verifiedSha: string
  number: number
  token: string
  /** The detail of the `done` stage the run ended with: what the pre-release needs. */
  done: Record<string, unknown>
}

const pullNumber = (url: string | null): number => {
  const found = /\/pull\/(\d+)$/.exec(url ?? '')
  if (!found) throw new Error(`the task has no pull request to wait on: ${url ?? 'none'}`)
  return Number(found[1])
}

/**
 * GitHub merged the verified commit: the integration finishes as a direct merge does, from the same code.
 * The task is claimed by clearing its wait, so a second pass that sees the same merge does nothing.
 */
async function finish(deps: AwaitCiDeps, w: Waiting, mergedSha: string): Promise<boolean> {
  const { row, verifiedSha, token } = w
  const claimed = await deps.db
    .update(task)
    .set({ mergedSha, awaitingCiSha: null })
    .where(and(eq(task.id, row.id), eq(task.awaitingCiSha, verifiedSha)))
    .returning({ id: task.id })
  if (claimed.length === 0) return false
  await deps.api.deleteBranch(row.repository, token, `factory/${row.issueNumber}`).catch(() => {})
  const repo = await loadRepoConfig(deps.db, row.repository)
  const advanced = await advancePreRelease(deps.api, {
    repository: row.repository,
    token,
    integration: integrationBranch(repo),
    mergedSha,
  })
  let handed: Handed
  try {
    handed = await createPreRelease(
      { db: deps.db, api: deps.api },
      {
        taskId: row.id,
        repository: row.repository,
        token,
        issueNumber: row.issueNumber,
        title: row.issueTitle,
        sha: verifiedSha,
        tagSha: advanced.developSha ?? mergedSha,
        pullRequestUrl: row.pullRequestUrl ?? undefined,
        attempts: Number(w.done.attempts ?? 1),
        costUsd: row.costUsd,
        agentSummary: String(w.done.agentSummary ?? ''),
      },
    )
  } catch (error) {
    handed = { error: error instanceof Error ? error.message : String(error) }
  }
  await deps.db.insert(stageEvent).values({
    taskId: row.id,
    stage: 'done',
    detail: {
      sha: verifiedSha,
      pullRequestUrl: row.pullRequestUrl,
      integratedBy: 'auto-merge',
      ...describeIntegration({ mergedSha, ...advanced }),
      ...describeDelivery(handed),
    },
  })
  // A release follows only a delivery that was made, as after a direct merge.
  if ('tag' in handed) {
    const [reviewed] = await deps.db
      .select({ reviewer: review.reviewer })
      .from(review)
      .where(eq(review.taskId, row.id))
      .orderBy(desc(review.id))
      .limit(1)
    await releaseByMode(
      { db: deps.db, github: deps.github, api: deps.api },
      {
        taskId: row.id,
        sha: verifiedSha,
        mode: repo.releaseMode ?? deps.releaseMode,
        actor: `agent:${reviewed?.reviewer ?? 'reviewer'}`,
      },
    )
  }
  return true
}

/** The work goes to a person: the pull request stays as it is, and the issue says why. */
async function toPerson(
  deps: AwaitCiDeps,
  w: Waiting,
  step: Extract<WaitingStep, { kind: 'person' }>,
): Promise<boolean> {
  const { row, verifiedSha, token, number } = w
  if (step.stopAutoMerge) await deps.api.disableAutoMerge(row.repository, token, number)
  const moved = await deps.db.transaction(async (tx) => {
    const claimed = await tx
      .update(task)
      .set({ stage: 'handoff', awaitingCiSha: null })
      .where(and(eq(task.id, row.id), eq(task.awaitingCiSha, verifiedSha)))
      .returning({ id: task.id })
    if (claimed.length === 0) return false
    await tx.insert(stageEvent).values({
      taskId: row.id,
      stage: 'handoff',
      detail: {
        reason: step.reason,
        sha: verifiedSha,
        pullRequestUrl: row.pullRequestUrl,
        costUsd: row.costUsd,
      },
    })
    return true
  })
  if (!moved) return false
  await deps.api.commentOnIssue(
    row.repository,
    token,
    row.issueNumber,
    `The factory could not integrate this: ${step.reason}.\n\nIts work is in ${row.pullRequestUrl}, which stays open for a person.`,
  )
  return true
}

/**
 * The failed required checks no check of the factory's answers for, marked so the note says it. Only the
 * owner's own checks are known here: a repository that leaves them to its recipe is not claimed about, and the
 * changeset check and the install step are the factory's too.
 */
function aloneAmong(failed: FailedReport[], checks: CheckSpec[] | undefined): FailedReport[] {
  if (!checks) return failed
  const names = [...checks.map((check) => check.name), 'changeset', 'install']
  return failed.map((r) =>
    r.notRequired || names.some((name) => counterpart(r.name, name)) ? r : { ...r, alone: true },
  )
}

/** The reruns this process asked for, which the next pass waits for. */
const requestedReruns: RerunMemo = new Map()

/**
 * What a failed required check says when it is not of the work, or is: nothing when its failed jobs were
 * rerun (the next pass sees the second attempt), otherwise the note with what the log says and the step that
 * exited, and what kept a rerun from being tried.
 */
async function readFailure(
  deps: AwaitCiDeps,
  w: Waiting,
  reports: CheckReport[],
  checks: CheckSpec[] | undefined,
  result: AwaitCiResult,
): Promise<string | undefined> {
  const { row, token, verifiedSha } = w
  const rerun = await rerunTransient(
    deps.checks,
    row.repository,
    token,
    verifiedSha,
    reports,
    deps.reruns ?? requestedReruns,
    deps.now?.(),
  )
  for (const problem of rerun.problems) result.errors.push(`task ${row.id}: ${problem}`)
  if (rerun.started > 0) {
    result.rerun.push(row.id)
    return undefined
  }
  const failed = await attachEvidence(deps.checks, row.repository, token, verifiedSha, reports)
  for (const check of failed) {
    if (check.evidence && 'unreadable' in check.evidence) {
      result.unreadEvidence.push(`task ${row.id}: ${check.name}: ${check.evidence.unreadable}`)
    }
  }
  return checksFeedback(verifiedSha, aloneAmong(failed, checks), rerun.problems.join('; '))
}

async function look(deps: AwaitCiDeps, row: typeof task.$inferSelect, result: AwaitCiResult) {
  const verifiedSha = row.awaitingCiSha!
  const [done] = await deps.db
    .select({ detail: stageEvent.detail, at: stageEvent.at })
    .from(stageEvent)
    .where(and(eq(stageEvent.taskId, row.id), eq(stageEvent.stage, 'done')))
    .orderBy(desc(stageEvent.id))
    .limit(1)
  const [runs] = await deps.db
    .select({ automatic: automaticRunsSincePerson() })
    .from(stageEvent)
    .where(eq(stageEvent.taskId, row.id))
    .groupBy(stageEvent.taskId)
  const number = pullNumber(row.pullRequestUrl)
  const { token } = await deps.github.installationToken(row.repository)
  const repo = await loadRepoConfig(deps.db, row.repository)
  const pull = await deps.api.readPullRequest(row.repository, token, number)
  const step = decideWaitingIntegration({
    verifiedSha,
    pull,
    required: await deps.api.requiredChecks(row.repository, token, integrationBranch(repo)),
    reports: await deps.api.checkReports(row.repository, token, verifiedSha),
    waitedMs:
      (deps.now?.() ?? new Date()).getTime() - new Date(done?.at ?? row.createdAt).getTime(),
    automaticRuns: Number(runs?.automatic ?? 0),
  })
  const w: Waiting = {
    row,
    verifiedSha,
    number,
    token,
    done: (done?.detail ?? {}) as Record<string, unknown>,
  }
  switch (step.kind) {
    case 'wait':
      result.waiting += 1
      return
    case 'finish':
      if (await finish(deps, w, step.mergedSha)) result.merged.push(row.id)
      return
    case 'send_back': {
      const note = await readFailure(deps, w, step.reports, repo.checks, result)
      if (note === undefined) return
      // Off first: the new commit the agent pushes must not merge before the factory verifies it.
      await deps.api.disableAutoMerge(row.repository, token, number)
      await deps.sendBack(row.id, note)
      result.sentBack.push(row.id)
      return
    }
    case 'start_over':
      // Starting over deletes the branch, which closes the pull request and its auto-merge with it.
      await deps.startOver(row.id)
      result.startedOver.push(row.id)
      return
    case 'person': {
      let said = step
      if (step.reports) {
        // Checks that still fail get the same rerun and evidence before a person is told.
        const note = await readFailure(deps, w, step.reports, repo.checks, result)
        if (note === undefined) return
        said = { ...step, reason: `${step.reason}\n\n${evidenceOfNote(note)}`.slice(0, 3_000) }
      }
      if (await toPerson(deps, w, said)) result.toPerson.push(row.id)
    }
  }
}

/**
 * Looks at every task whose pull request waits for the integration branch's required checks, and takes
 * each one step further: see `decideWaitingIntegration`. A task that cannot be looked at (GitHub failed) is
 * recorded and looked at again on the next pass.
 */
export async function pollAwaitingIntegrations(deps: AwaitCiDeps): Promise<AwaitCiResult> {
  const result: AwaitCiResult = {
    merged: [],
    sentBack: [],
    rerun: [],
    startedOver: [],
    toPerson: [],
    waiting: 0,
    errors: [],
    unreadEvidence: [],
  }
  const rows = await deps.db
    .select()
    .from(task)
    .where(and(eq(task.stage, 'done'), isNotNull(task.awaitingCiSha)))
    .orderBy(task.id)
  for (const row of rows) {
    try {
      await look(deps, row, result)
    } catch (error) {
      result.errors.push(
        `task ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return result
}
