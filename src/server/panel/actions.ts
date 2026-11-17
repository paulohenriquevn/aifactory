import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { decision, finding, question, repository, stageEvent, task, watch } from '../db/schema'
import type { GithubApp } from '../github/app'
import { integrationBranch } from '../factory/branches'
import { release as promote, ReleaseRefused } from '../factory/deliver'
import type { GithubApi } from '../github/pulls'
import type { Bump } from '../factory/release'
import { latestSendBackDecision, pendingSendBack } from '../factory/send-back'
import { outcome, stagesWhere, type Facts, type TransitionEvent } from '../factory/transitions'

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
        input: {
          taskId: number
          decisionId?: number
          feedback?: string
          resume?: boolean
          mergeBase?: boolean
        },
        key: string,
      ) => Promise<void>,
      /** Removes the run queued under `key` if no worker has taken it; answers whether it did. */
      dequeueRun?: (key: string) => Promise<boolean>,
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
  rework?: Rework,
): Promise<number | null> {
  return deps.inTransaction(async (tx, enqueueRun) => {
    // What a person's send-back clears is kept on its intake, so withdrawing it can give it back. It is read
    // under a lock held until the commit, so a cron that changes it meanwhile waits and is never overwritten.
    const [locked] =
      kind === 'request_changes'
        ? await tx.select().from(task).where(eq(task.id, taskId)).for('update')
        : []
    // The integration may have finished between the panel's read and this lock: a merged task is not sent back,
    // so no run starts on work already integrated and the cron's `done` never lands after the intake.
    if (locked) mustAllow(locked, 'request_changes')
    const before = locked
      ? { resolvedSha: locked.resolvedSha, awaitingCiSha: locked.awaitingCiSha }
      : undefined
    // A new run ends any wait for the repository's checks: its pull request is not the one that merges.
    const moved = await tx
      .update(task)
      .set({ stage: 'intake', awaitingCiSha: null, integrationHeld: false, resolvedSha: null })
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
      const changes = kind === 'automatic_changes' || (rework !== undefined && !rework.plain)
      const [event] = await tx
        .insert(stageEvent)
        .values({
          taskId,
          stage: 'intake',
          detail: {
            decision: changes ? 'request_changes' : 'retry',
            note,
            automatic: true,
            ...(rework?.preAgent ? { kept: true } : {}),
            ...(rework?.decisionId ? { decisionId: rework.decisionId } : {}),
          },
        })
        .returning({ id: stageEvent.id })
      await enqueueRun(queuedInput(taskId, note, changes, rework), `task-${taskId}-auto${event.id}`)
      return null
    }
    const [made] = await tx
      .insert(decision)
      .values({ taskId, kind, sha, note })
      .returning({ id: decision.id })
    await tx.insert(stageEvent).values({
      taskId,
      stage: 'intake',
      detail: {
        decision: kind,
        note,
        ...(kind === 'request_changes' ? { decisionId: made.id, restore: before } : {}),
      },
    })
    await enqueueRun({ taskId, decisionId: made.id }, `task-${taskId}-d${made.id}`)
    return made.id
  })
}

/** Work a failed run left on its branch: what to change, and the decision it came from when a person asked. */
type Rework = {
  note: string
  decisionId?: number
  plain?: boolean
  /** The run merges the integration branch into the work branch itself, and no agent is given the note. */
  mergeBase?: boolean
  /** The run that failed never started an agent (its sandbox failed), so it was no attempt of the work. */
  preAgent: boolean
}

/** What an automatic run is queued with: the job reads it to know how the run starts (`runContinuation`). */
function queuedInput(taskId: number, note: string, changes: boolean, rework?: Rework) {
  if (rework?.mergeBase) return { taskId, mergeBase: true }
  if (rework?.plain) return { taskId, resume: true }
  if (!changes) return { taskId }
  return rework?.decisionId ? { taskId, decisionId: rework.decisionId } : { taskId, feedback: note }
}

/**
 * The work an automatic retry must keep. A run that was a rework (the latest intake was a request for
 * changes) keeps its note and, for a person's request, its decision, so the prompt is the one the person
 * caused. A run that pushed a branch keeps it too, even a first run, as a plain continuation: nothing was asked for, so no feedback is made up.
 */
async function workToKeep(
  deps: ActionDeps,
  row: typeof task.$inferSelect,
  token: string,
): Promise<Rework | undefined> {
  const [failed, before] = await deps.db
    .select({ stage: stageEvent.stage })
    .from(stageEvent)
    .where(
      and(
        eq(stageEvent.taskId, row.id),
        // A withdrawn send-back, and the copy of the stage it went back to, are not part of the run's story.
        sql`(${stageEvent.detail}->>'withdrawn') is distinct from 'true'`,
        sql`(${stageEvent.detail}->>'withdrawnDecisionId') is null`,
      ),
    )
    .orderBy(desc(stageEvent.id))
    .limit(2)
  const preAgent = failed?.stage === 'failed' && before?.stage === 'sandbox'
  const events = await deps.db
    .select({ stage: stageEvent.stage, detail: stageEvent.detail })
    .from(stageEvent)
    .where(
      and(
        eq(stageEvent.taskId, row.id),
        eq(stageEvent.stage, 'intake'),
        sql`(${stageEvent.detail}->>'withdrawn') is distinct from 'true'`,
      ),
    )
    .orderBy(desc(stageEvent.id))
    .limit(1)
  const detail = (events[0]?.detail ?? {}) as Record<string, unknown>
  if (detail.decision === 'request_changes' && typeof detail.note === 'string') {
    let decisionId = typeof detail.decisionId === 'number' ? detail.decisionId : undefined
    if (decisionId === undefined && detail.automatic !== true) {
      // An intake written before it named its decision: the person's latest request is the one.
      decisionId = await latestSendBackDecision(deps.db, row.id)
    }
    return { note: detail.note, decisionId, preAgent }
  }
  const head = await deps.api.branchHead(row.repository, token, `factory/${row.issueNumber}`)
  return head ? { note: '', plain: true, preAgent } : undefined
}

async function load(db: Database, taskId: number) {
  const [row] = await db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new ActionRefused(`task ${taskId} does not exist`)
  return row
}

/** Refuses, with the reason the transition table gives, an event the task's state does not allow. */
function mustAllow(row: Facts, event: TransitionEvent) {
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
 * Withdraws a send-back that has not started: the queued run goes, the task returns to the stage it was
 * in before the person sent it back, and the decision is recorded as withdrawn. Only a person's own
 * request for changes can be withdrawn, and only while its run waits in the queue.
 */
export async function withdrawSendBack(deps: ActionDeps, taskId: number) {
  const row = await load(deps.db, taskId)
  const pending = await pendingSendBack(deps.db, taskId)
  const facts: Facts = { ...row, sendBackPending: pending !== undefined }
  mustAllow(facts, 'withdraw_send_back')
  const { decisionId, back, restore, previous } = pending!
  return deps.inTransaction(async (tx, _enqueueRun, dequeueRun) => {
    const moved = await tx
      .update(task)
      .set({ stage: back, ...restore })
      .where(and(eq(task.id, taskId), eq(task.stage, 'intake')))
      .returning({ id: task.id })
    // The run goes only while no worker holds its job, and only the job of this very decision: a run
    // already taken is not withdrawn, and the transaction ends here changing nothing.
    if (moved.length === 0 || !dequeueRun || !(await dequeueRun(`task-${taskId}-d${decisionId}`))) {
      throw new ActionRefused(
        'the run of this send-back already started, so it cannot be withdrawn',
      )
    }
    const [made] = await tx
      .insert(decision)
      .values({ taskId, kind: 'withdrawn', sha: row.headSha, note: '' })
      .returning({ id: decision.id })
    // The intake stays in the history, marked, so nothing rebuilds work from a note nobody wants.
    await tx
      .update(stageEvent)
      .set({ detail: sql`${stageEvent.detail} || '{"withdrawn": true}'::jsonb` })
      .where(
        and(
          eq(stageEvent.taskId, taskId),
          eq(stageEvent.stage, 'intake'),
          eq(stageEvent.id, sql`(select max(e.id) from stage_event e where e.task_id = ${taskId})`),
        ),
      )
    // The stage's own event is written again as it was, with its time, because what reads the latest
    // failed or done event (the reason, the retry schedule, the integration error) must still find it.
    const kept = (previous.detail ?? {}) as Record<string, unknown>
    await tx.insert(stageEvent).values({
      taskId,
      stage: back,
      detail: { ...kept, withdrawnDecisionId: decisionId },
      at: previous.at,
    })
    return { decisionId: made.id, stage: back }
  })
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
  options: { fromFinding?: boolean; automatic?: boolean } = {},
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
  // The coordinator's retry is the factory's own: no decision in anybody's name, and it counts as automatic.
  const kind = options.automatic ? 'automatic_retry' : 'retry'
  const decisionId = await requeue(deps, taskId, allowed, kind, '', row.headSha)
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
  // A rework, or a run that pushed, repeats on its branch with its note; only a run that never pushed starts over.
  const { token } = await deps.github.installationToken(row.repository)
  if (row.stage === 'done' && (await mergesTheBase(deps, row, token))) return
  const rework = row.stage === 'failed' ? await workToKeep(deps, row, token) : undefined
  if (!rework) {
    await deps.api.deleteBranch(row.repository, token, `factory/${row.issueNumber}`)
  }
  await requeue(
    deps,
    taskId,
    [row.stage],
    'automatic_retry',
    rework?.note ?? '',
    row.headSha,
    rework,
  )
}

/**
 * What a run is told when its finished work conflicts with the integration branch, which moved after the
 * work was approved (another task merged first). Tasks of one repository often regenerate the same files,
 * so most of these conflicts are in generated files, which only their generator writes right.
 */
export function conflictNote(base: string): string {
  return [
    `The pull request conflicts with ${base}, which moved after this work was approved.`,
    `Merge it into this branch: git fetch origin ${base} && git merge origin/${base}.`,
    'Resolve each conflict keeping what both sides changed. A generated file (a reference, a map or docs a script writes) is regenerated with the script that writes it, never edited by hand; a budget or a version takes the value the merged code needs.',
    'Commit the merge and change nothing else.',
  ].join(' ')
}

/**
 * Sends a done task whose pull request conflicts with its base back to its own branch, to merge the base,
 * and answers whether it did. Approved work is kept: starting over would delete the branch and pay for the
 * whole run again (paulohenriquevn/aifactory#122). Without the branch there is nothing to keep.
 */
async function mergesTheBase(
  deps: ActionDeps,
  row: typeof task.$inferSelect,
  token: string,
): Promise<boolean> {
  const head = await deps.api.branchHead(row.repository, token, `factory/${row.issueNumber}`)
  if (!head) return false
  const [config] = await deps.db
    .select({ baseBranch: repository.baseBranch })
    .from(repository)
    .where(eq(repository.fullName, row.repository))
  const base = integrationBranch(config ?? {})
  await requeue(deps, row.id, ['done'], 'automatic_changes', conflictNote(base), row.headSha)
  return true
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
 * Sends a task whose pull request waits for checks, and conflicts with its base, back to its own branch to
 * merge `base` (`send_back_conflict` in `factory/ci-wait.ts`). Without the branch there is nothing to keep,
 * and the task starts over from the base.
 */
export async function sendBackConflictAutomatically(
  deps: ActionDeps,
  taskId: number,
  base: string,
) {
  const row = await load(deps.db, taskId)
  mustAllow(row, 'send_back_after_ci')
  const { token } = await deps.github.installationToken(row.repository)
  const head = await deps.api.branchHead(row.repository, token, `factory/${row.issueNumber}`)
  if (!head) {
    await requeue(deps, taskId, ['done'], 'automatic_retry', '', row.headSha)
    return
  }
  await requeue(deps, taskId, ['done'], 'automatic_changes', conflictNote(base), row.headSha)
}

/**
 * Runs a task again whose required checks failed only because the integration branch failed them too, now
 * that it passes them (`merge_base` in `factory/ci-wait.ts`), with no person asking. The run merges that
 * branch into the work branch itself, with no agent, and the merge goes through the checks and the review
 * like any work. The note is the record of why; no agent is given it. Only a task whose pull request waits
 * for those checks qualifies, as for a send-back after them.
 */
export async function mergeFixedBase(deps: ActionDeps, taskId: number, note: string) {
  const row = await load(deps.db, taskId)
  mustAllow(row, 'send_back_after_ci')
  const text = note.slice(0, NOTE_MAX)
  await requeue(deps, taskId, ['done'], 'automatic_changes', text, row.headSha, {
    note: text,
    mergeBase: true,
    preAgent: false,
  })
}

/**
 * Sends a handed-over task back to its agent because the coordinator decided so, with no person asking:
 * on its branch with the note as feedback, or, when `note` is empty, as a plain continuation of the branch
 * that goes through the checks and the review again. Like an automatic send-back, nothing is decided in
 * anybody's name; the coordinator's own record says why (`coordinator/apply.ts`).
 */
export async function sendBackByCoordinator(deps: ActionDeps, taskId: number, note: string) {
  const row = await load(deps.db, taskId)
  mustAllow(row, 'coordinator_send_back')
  const from = stagesWhere('coordinator_send_back', row)
  const text = note.slice(0, NOTE_MAX)
  if (text === '') {
    await requeue(deps, taskId, from, 'automatic_retry', '', row.headSha, {
      note: '',
      plain: true,
      preAgent: false,
    })
    return
  }
  await requeue(deps, taskId, from, 'automatic_changes', text, row.headSha)
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
 * `automatic` is the coordinator resolving it: a retry then records no decision in anybody's name.
 */
export async function resolveFinding(
  deps: ActionDeps,
  findingId: number,
  action: FindingAction,
  options: { automatic?: boolean } = {},
) {
  const [found] = await deps.db.select().from(finding).where(eq(finding.id, findingId))
  if (!found || found.resolvedAt) throw new ActionRefused('this finding is not open')
  if (!ALLOWED[action].includes(found.subject)) {
    throw new ActionRefused(`${action} is not something to do about a ${found.subject} finding`)
  }

  if (action === 'retry') {
    if (found.taskId === null) throw new ActionRefused('this finding has no task')
    await retry(deps, found.taskId, { fromFinding: true, automatic: options.automatic })
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
