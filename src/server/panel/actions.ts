import { and, eq, inArray, isNull } from 'drizzle-orm'

import type { Database } from '../db'
import { decision, finding, question, repository, stageEvent, task, watch } from '../db/schema'
import type { GithubApp } from '../github/app'
import { integrationBranch } from '../factory/branches'
import { release as promote, ReleaseRefused } from '../factory/deliver'
import type { GithubApi } from '../github/pulls'
import type { Bump } from '../factory/release'
import { outcome, stagesWhere, type TransitionEvent } from '../factory/transitions'

/** A person asked for something the task's state does not allow. The panel shows the message. */
export class ActionRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionRefused'
  }
}

export type ActionDeps = {
  db: Database
  github: GithubApp
  api: GithubApi
  /** Queues `resume-task` for a question again, when the first job was lost. */
  enqueueResume: (input: { taskId: number; questionId: number }, key: string) => Promise<void>
  /** Frees a snapshot at the sandbox provider. */
  deleteSnapshot: (snapshotId: string) => Promise<void>
  /** Queues the run in the transaction that records the decision. */
  inTransaction: <T>(
    work: (
      tx: Database,
      enqueueRun: (
        input: { taskId: number; decisionId?: number; feedback?: string },
        key: string,
      ) => Promise<void>,
    ) => Promise<T>,
  ) => Promise<T>
}

const NOTE_MAX = 4_000

/**
 * Moves a task from one of `from` to `intake` and records why, in one transaction with the decision
 * and the queued run. The stage is checked and changed by the same statement, so a double click
 * cannot queue two runs. A task that runs again is not resolved any more: what the new run finds decides.
 */
async function requeue(
  deps: ActionDeps,
  taskId: number,
  from: string[],
  kind: 'request_changes' | 'retry' | 'automatic_retry' | 'automatic_changes',
  note: string,
  sha: string | null,
): Promise<number | null> {
  return deps.inTransaction(async (tx, enqueueRun) => {
    // A new run ends any wait for the repository's checks: its pull request is not the one that merges.
    const moved = await tx
      .update(task)
      .set({ stage: 'intake', awaitingCiSha: null, resolvedSha: null })
      .where(and(eq(task.id, taskId), inArray(task.stage, from as never)))
      .returning({ id: task.id })
    if (moved.length === 0) {
      throw new ActionRefused(
        `this task cannot be ${kind.endsWith('changes') ? 'sent back' : 'retried'} now`,
      )
    }
    if (kind === 'automatic_retry' || kind === 'automatic_changes') {
      // Nobody decided this one, so no decision is recorded in anybody's name: the intake says it was the
      // factory's own, and the count of these is what stops it after a few. Changes carry their note to
      // the run as feedback, on the branch the agent already pushed.
      const changes = kind === 'automatic_changes'
      const [event] = await tx
        .insert(stageEvent)
        .values({
          taskId,
          stage: 'intake',
          detail: { decision: changes ? 'request_changes' : 'retry', note, automatic: true },
        })
        .returning({ id: stageEvent.id })
      await enqueueRun(
        changes ? { taskId, feedback: note } : { taskId },
        `task-${taskId}-auto${event.id}`,
      )
      return null
    }
    const [made] = await tx
      .insert(decision)
      .values({ taskId, kind, sha, note })
      .returning({ id: decision.id })
    await tx
      .insert(stageEvent)
      .values({ taskId, stage: 'intake', detail: { decision: kind, note } })
    await enqueueRun({ taskId, decisionId: made.id }, `task-${taskId}-d${made.id}`)
    return made.id
  })
}

async function load(db: Database, taskId: number) {
  const [row] = await db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new ActionRefused(`task ${taskId} does not exist`)
  return row
}

/** Refuses, with the reason the transition table gives, an event the task's state does not allow. */
function mustAllow(row: typeof task.$inferSelect, event: TransitionEvent) {
  const decided = outcome(row, event)
  if (decided.kind !== 'action') throw new ActionRefused(decided.reason)
}

/**
 * Approves the commit the pull request is at. The approval names that commit: if the branch moves
 * (a rework, a new push), it no longer covers it. Merging is a later step and reads this.
 */
export async function approve(deps: ActionDeps, taskId: number) {
  const row = await load(deps.db, taskId)
  mustAllow(row, 'approve')
  // Only a task with a commit is approved.
  const sha = row.headSha!
  const [made] = await deps.db
    .insert(decision)
    .values({ taskId, kind: 'approve', sha, note: '' })
    .returning({ id: decision.id })
  return { decisionId: made.id, sha }
}

/**
 * Sends a pull request back with a note. A new run starts from the branch the agent already pushed,
 * with the note in its prompt, and goes through the checks and the review again. A task with no branch
 * on GitHub (resolved with no change, or its branch deleted by a retry) starts from the integration
 * branch instead, as a first run does, with the same note.
 */
export async function requestChanges(deps: ActionDeps, taskId: number, note: string) {
  const text = note.trim()
  if (text === '') throw new ActionRefused('say what should change')
  const row = await load(deps.db, taskId)
  mustAllow(row, 'request_changes')
  const decisionId = await requeue(
    deps,
    taskId,
    stagesWhere('request_changes', row),
    'request_changes',
    text.slice(0, NOTE_MAX),
    row.headSha,
  )
  return { decisionId }
}

/**
 * Starts a failed or handed-over task again from the beginning. Its branch is deleted first (which
 * also closes its pull request), so the new run does not collide with the old one. A done task whose
 * pull request was never merged (GitHub refused it, as for a conflict with the base) is not delivered
 * either, so it may start again too.
 */
export async function retry(
  deps: ActionDeps,
  taskId: number,
  options: { fromFinding?: boolean } = {},
) {
  const row = await load(deps.db, taskId)
  // A run the supervisor found stalled or lost is in a working stage, which retry otherwise refuses.
  const event = options.fromFinding ? 'retry_from_finding' : 'retry'
  mustAllow(row, event)
  // What makes a done task one to retry was read with its stage, so only a task read as done may be done.
  const allowed = stagesWhere(event, row).filter(
    (stage) => stage !== 'done' || row.stage === 'done',
  )
  const { token } = await deps.github.installationToken(row.repository)
  await deps.api.deleteBranch(row.repository, token, `factory/${row.issueNumber}`)
  const decisionId = await requeue(deps, taskId, allowed, 'retry', '', row.headSha)
  return { decisionId }
}

/**
 * Delivers a failed or handed-over task that a person resolved another way: by hand, because the
 * factory may not touch the file, or by splitting the issue into items that were delivered. The note
 * says where, and the task is marked resolved at the integration branch's head, which holds that work.
 */
export async function resolveElsewhere(deps: ActionDeps, taskId: number, note: string) {
  const text = note.trim()
  if (text === '') throw new ActionRefused('say where the issue was resolved')
  const row = await load(deps.db, taskId)
  mustAllow(row, 'resolve')
  const [config] = await deps.db
    .select({ baseBranch: repository.baseBranch })
    .from(repository)
    .where(eq(repository.fullName, row.repository))
  const branch = integrationBranch(config ?? {})
  const { token } = await deps.github.installationToken(row.repository)
  const sha = await deps.api.branchHead(row.repository, token, branch)
  if (!sha) throw new ActionRefused(`${row.repository} has no ${branch} branch to resolve this at`)
  return deps.inTransaction(async (tx) => {
    const moved = await tx
      .update(task)
      .set({ stage: 'done', resolvedSha: sha })
      .where(and(eq(task.id, taskId), inArray(task.stage, stagesWhere('resolve', row))))
      .returning({ id: task.id })
    if (moved.length === 0)
      throw new ActionRefused('this task moved on before it could be resolved')
    const [made] = await tx
      .insert(decision)
      .values({ taskId, kind: 'resolve', sha, note: text.slice(0, NOTE_MAX) })
      .returning({ id: decision.id })
    await tx
      .insert(stageEvent)
      .values({ taskId, stage: 'done', detail: { decision: 'resolve', note: text } })
    return { decisionId: made.id, sha }
  })
}

/**
 * Starts a failed task again because its failure passed by itself (a quota came back, an outage
 * ended), with no person asking. The same as `retry` but for the record: nothing is decided in
 * anybody's name.
 */
export async function retryAutomatically(deps: ActionDeps, taskId: number) {
  const row = await load(deps.db, taskId)
  // A done task whose pull request GitHub refused to merge is not delivered, so it may run again too.
  mustAllow(row, row.stage === 'failed' ? 'retry_due' : 'conflict_rerun')
  const { token } = await deps.github.installationToken(row.repository)
  await deps.api.deleteBranch(row.repository, token, `factory/${row.issueNumber}`)
  await requeue(deps, taskId, [row.stage], 'automatic_retry', '', row.headSha)
}

/**
 * Sends work back to its agent because the repository's required checks failed on it, with no person
 * asking. Like a request for changes, the run continues on the branch the agent pushed with the note as
 * feedback; like an automatic retry, nothing is decided in anybody's name. Only a task whose pull request
 * waits for those checks qualifies.
 */
export async function sendBackAutomatically(deps: ActionDeps, taskId: number, note: string) {
  const row = await load(deps.db, taskId)
  mustAllow(row, 'send_back_after_ci')
  await requeue(deps, taskId, ['done'], 'automatic_changes', note.slice(0, NOTE_MAX), row.headSha)
}

/**
 * Releases a task from the panel: its pull request is merged and a full release is published. The
 * click is the approval, so it is recorded as one. Everything the commit must satisfy is checked in
 * `release`, and a refusal is shown as it is.
 */
export async function releaseTask(deps: ActionDeps, taskId: number, bump: Bump) {
  await load(deps.db, taskId)
  try {
    return await promote(deps, taskId, { bump, actor: 'human' })
  } catch (error) {
    if (error instanceof ReleaseRefused) throw new ActionRefused(error.message)
    throw error
  }
}

/**
 * Says a person dealt with a red default branch (merged the revert, fixed it another way), so it
 * leaves the inbox. It changes nothing on GitHub.
 */
export async function acknowledgeWatch(deps: ActionDeps, watchId: number) {
  const done = await deps.db
    .update(watch)
    .set({ acknowledgedAt: new Date() })
    .where(and(eq(watch.id, watchId), eq(watch.status, 'red'), isNull(watch.acknowledgedAt)))
    .returning({ id: watch.id })
  if (done.length === 0)
    throw new ActionRefused('there is no red default branch waiting for you here')
  return { watchId }
}

/** What a person can do about a supervisor finding, and which findings each one is for. */
export type FindingAction = 'retry' | 'resume' | 'delete_snapshot' | 'mark_revert_unknown'

const ALLOWED: Record<FindingAction, string[]> = {
  retry: ['run', 'queued_run'],
  resume: ['answer_resume'],
  delete_snapshot: ['snapshot'],
  mark_revert_unknown: ['revert'],
}

/**
 * Resolves a finding the supervisor opened. The action must be one the finding's subject allows, and
 * the finding must still be open, so a stale page cannot, say, delete a snapshot nobody flagged. The
 * supervisor closes the finding on its next pass; it is closed here too so the panel is not stale.
 */
export async function resolveFinding(deps: ActionDeps, findingId: number, action: FindingAction) {
  const [found] = await deps.db.select().from(finding).where(eq(finding.id, findingId))
  if (!found || found.resolvedAt) throw new ActionRefused('this finding is not open')
  if (!ALLOWED[action].includes(found.subject)) {
    throw new ActionRefused(`${action} is not something to do about a ${found.subject} finding`)
  }

  if (action === 'retry') {
    if (found.taskId === null) throw new ActionRefused('this finding has no task')
    await retry(deps, found.taskId, { fromFinding: true })
  } else if (action === 'resume') {
    const [asked] = await deps.db
      .select()
      .from(question)
      .where(eq(question.id, Number(found.ref)))
    if (!asked?.answer || asked.resumedAt)
      throw new ActionRefused('this question has nothing to resume')
    await deps.enqueueResume(
      { taskId: asked.taskId, questionId: asked.id },
      `resume-${asked.id}-again-${Date.now()}`,
    )
  } else if (action === 'delete_snapshot') {
    if (!found.ref) throw new ActionRefused('this finding names no snapshot')
    await deps.deleteSnapshot(found.ref)
  } else {
    // The revert may or may not have been opened. Say so, in the place a person reads it.
    const done = await deps.db
      .update(watch)
      .set({
        status: 'red',
        endedAt: new Date(),
        detail:
          'the revert was not confirmed opened: check the repository for a revert pull request',
      })
      .where(and(eq(watch.id, Number(found.ref)), eq(watch.status, 'reverting')))
      .returning({ id: watch.id })
    if (done.length === 0) throw new ActionRefused('this revert is no longer stuck')
  }
  await deps.db.update(finding).set({ resolvedAt: new Date() }).where(eq(finding.id, findingId))
  return { findingId }
}
