import { and, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { coordinatorAction, repository, task } from '../db/schema'
import { release, ReleaseRefused } from '../factory/deliver'
import { outcome as transition } from '../factory/transitions'
import type { IssuesApi } from '../github/issues-api'
import {
  ActionRefused,
  mergeBaseByCoordinator,
  resolveFinding,
  sendBackByCoordinator,
  type ActionDeps,
} from '../panel/actions'
import { FACTORY_LABEL_SPEC } from '../panel/work'

import { baseFixIssue, baseSignature } from './base-fix'
import type { CoordinatorOutcome, Decision } from './decide'
import type { ReadIssue } from './draft'
import type { RedBase, TaskException } from './exceptions'
import { fileOnce } from './file-once'
import type { CoordinatorMode } from './mode'
import { HOLD_LOCK, moveAhead } from './queue-apply'
import { readHeldTests } from './queue-facts'
import { COORDINATOR_ACTOR } from './release-train'
import { followUpIssue, qualityConfigurationNamed, scopeSection, type ScopeDraft } from './scope'
import { applyUnblocker, UNBLOCKER_ONLY, type UnblockerApplyDeps } from './unblocker-apply'

/**
 * The only module of the coordinator with side effects. It applies a decision through the panel's own
 * actions, each of which asks `factory/transitions.ts` first, and records it in `coordinator_action`,
 * applied or not. Its only writes of its own are on GitHub: the issue body and the follow-up issue a `scope`
 * needs, and the issue a `fix_base` files on a repository whose integration branch is red, which changes no
 * task. It merges nothing itself: a release goes through `release()` and every refusal of it.
 */

export type ApplyDeps = ActionDeps &
  Pick<UnblockerApplyDeps, 'checkReruns' | 'answerInTransaction'> & {
    issues: Pick<IssuesApi, 'createIssue' | 'updateIssueBody' | 'ensureLabel'>
    readIssue: ReadIssue
    /** The clock a decision is recorded at, which is what the age of a `wait` is measured against. */
    now?: () => Date
  }

/** The labels of the fix of a red base: the factory builds it, and its queue takes it first. */
const BASE_FIX_LABELS = [
  FACTORY_LABEL_SPEC,
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'priority:1', color: 'b60205', description: 'The factory takes this issue first' },
]

/** Whether the owner enabled the repository, which is what lets the `factory` label make a task of an issue. */
async function enabled(deps: ApplyDeps, fullName: string): Promise<boolean> {
  const [repo] = await deps.db
    .select({ enabled: repository.enabled })
    .from(repository)
    .where(eq(repository.fullName, fullName))
  return repo?.enabled ?? false
}

type TaskRow = typeof task.$inferSelect

/** The follow-up the draft files, labelled for the factory only in a repository the owner enabled. */
async function fileFollowUp(deps: ApplyDeps, row: TaskRow, token: string, draft: ScopeDraft) {
  const issue = followUpIssue(draft, row.repository, row.issueNumber)
  if (!issue) return null
  const labels = (await enabled(deps, row.repository)) ? ['factory'] : []
  return (await deps.issues.createIssue(row.repository, token, { ...issue, labels })).number
}

/**
 * Scopes the task: asks the transition table before anything reaches GitHub, files the follow-up, appends
 * the decision to the issue body and sends the task back on its branch with the note. Returns the number
 * of the follow-up, or null when the draft filed none.
 */
async function scope(deps: ApplyDeps, taskId: number, draft: ScopeDraft): Promise<number | null> {
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new ActionRefused(`task ${taskId} does not exist`)
  const allowed = transition(row, 'coordinator_send_back')
  if (allowed.kind !== 'action') throw new ActionRefused(allowed.reason)
  const { token } = await deps.github.installationToken(row.repository)
  const followUp = await fileFollowUp(deps, row, token, draft)
  const { body } = await deps.readIssue(row.repository, row.issueNumber, token)
  const section = scopeSection(draft, new Date().toISOString().slice(0, 10), followUp ?? undefined)
  const updated = [body.trimEnd(), section].filter((part) => part !== '').join('\n\n')
  await deps.issues.updateIssueBody(row.repository, token, row.issueNumber, updated)
  await sendBackByCoordinator(deps, taskId, draft.note)
  return followUp
}

/**
 * Files the fix of a red integration branch, once per repository, branch and set of checks (`fileOnce`): an
 * issue whose earlier one was closed is filed again. Answers what became of it, for the record.
 */
async function fixBase(deps: ApplyDeps, base: RedBase): Promise<string> {
  const repo = base.repository
  const { token } = await deps.github.installationToken(repo)
  const labels = (await enabled(deps, repo)) ? BASE_FIX_LABELS : BASE_FIX_LABELS.slice(1)
  const claim = { signature: baseSignature(base), repository: repo, now: new Date() }
  const done = await fileOnce(
    deps.db,
    claim,
    async (previous) => {
      for (const label of labels) await deps.issues.ensureLabel(repo, token, label)
      const issue = baseFixIssue(base, previous)
      return deps.issues.createIssue(repo, token, { ...issue, labels: labels.map((l) => l.name) })
    },
    async (number) => (await deps.readIssue(repo, number, token)).state === 'closed',
  )
  if ('filed' in done) return `filed as ${repo}#${done.filed.number}`
  return done.already === null
    ? 'another pass is filing it'
    : `already filed as ${repo}#${done.already}, still open`
}

/** What carrying out a decision left: the follow-up a scope filed (null for none), or what a fix became. */
type Performed = { followUpIssue?: number | null; done?: string }

/** Carries out a decision that changes something. Escalating and waiting change nothing, so they never come here. */
async function perform(
  deps: ApplyDeps,
  exception: TaskException,
  decision: Decision,
): Promise<Performed> {
  if (decision.action === 'send_back') {
    await sendBackByCoordinator(deps, exception.taskId, decision.note ?? '')
  } else if (decision.action === 'merge_base') {
    await mergeBaseByCoordinator(deps, exception.taskId, decision.note ?? '')
  } else if (decision.action === 'review_again') {
    await sendBackByCoordinator(deps, exception.taskId, '')
  } else if (decision.action === 'retry_from_finding') {
    await resolveFinding(deps, decision.findingId!, 'retry', { automatic: true })
  } else if (decision.action === 'scope' && decision.draft) {
    return { followUpIssue: await scope(deps, exception.taskId, decision.draft) }
  } else if (decision.action === 'release' && decision.bump) {
    await release(deps, exception.taskId, {
      bump: decision.bump,
      actor: COORDINATOR_ACTOR,
      expectedHead: exception.verifiedHead,
    })
  } else if (decision.action === 'fix_base' && decision.base) {
    return { done: await fixBase(deps, decision.base) }
  } else if (UNBLOCKER_ONLY.includes(decision.action)) {
    return { done: await applyUnblocker(deps, exception, decision) }
  } else {
    throw new Error(`the coordinator has no way to apply ${decision.action}`)
  }
  return {}
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Carried = {
  outcome: CoordinatorOutcome
  reason: string
  /** The follow-up a scope filed (null for none); absent when nothing was applied. */
  followUpIssue?: number | null
}

/** A decision that was refused or failed, logged with its context, so a person sees it as well as the next pass. */
function notCarried(
  exception: TaskException,
  decision: Decision,
  outcome: 'refused' | 'failed',
  why: string,
): Carried {
  console.error(
    JSON.stringify({
      event: `coordinator_${outcome}`,
      taskId: exception.taskId,
      exception: exception.kind,
      head: exception.head,
      action: decision.action,
      error: why,
    }),
  )
  return { outcome, reason: `${decision.reason}. It was ${outcome}: ${why}` }
}

/** Why a decision may not be applied at all, whatever the mode, or nothing. */
function forbidden(decision: Decision): string | undefined {
  const named = decision.draft && qualityConfigurationNamed(decision.draft)
  return named
    ? `the draft names ${named}, and no quality gate is loosened to make a review converge`
    : undefined
}

/** A decision only recorded; the issue a `fix_base` would file is logged too, so its text can be read first. */
function inTrial(exception: TaskException, decision: Decision): Carried {
  if (decision.action === 'fix_base' && decision.base) {
    const { title } = baseFixIssue(decision.base)
    console.log(
      JSON.stringify({
        event: 'coordinator_fix_base_trial',
        taskId: exception.taskId,
        repository: decision.base.repository,
        signature: baseSignature(decision.base),
        title,
      }),
    )
  }
  return { outcome: 'trial', reason: decision.reason }
}

/** What became of the decision, and the reason to record with it. */
async function carryOut(
  deps: ApplyDeps,
  exception: TaskException,
  decision: Decision,
  mode: CoordinatorMode,
): Promise<Carried> {
  if (decision.failure !== undefined) {
    return notCarried(exception, decision, 'failed', decision.failure)
  }
  if (decision.refusal !== undefined) {
    return notCarried(exception, decision, 'refused', decision.refusal)
  }
  if (decision.action === 'escalate') return { outcome: 'escalated', reason: decision.reason }
  if (decision.action === 'wait') return { outcome: 'deferred', reason: decision.reason }
  const refusal = forbidden(decision)
  if (refusal) return notCarried(exception, decision, 'refused', refusal)
  if (mode !== 'auto') return inTrial(exception, decision)
  try {
    const { followUpIssue, done } = await perform(deps, exception, decision)
    const reason = done ? `${decision.reason}: ${done}` : decision.reason
    return { outcome: 'applied', reason, followUpIssue }
  } catch (error) {
    const refused = error instanceof ActionRefused || error instanceof ReleaseRefused
    const outcome = refused ? 'refused' : 'failed'
    return notCarried(exception, decision, outcome, message(error))
  }
}

/**
 * What the row keeps of the model's work: the draft with the follow-up it filed, or the unread answer, and what the
 * unblocker picked, marked so its own limit counts the row (`readRecordedActions`).
 */
function recordedDraft(decision: Decision, carried: Carried) {
  const drafted = draftedText(decision, carried)
  if (!decision.unblocker) return drafted
  return { ...(drafted ?? {}), by: UNBLOCKER_MARK, unblocker: decision.unblocker }
}

/** How a row says the unblocker decided it. */
export const UNBLOCKER_MARK = 'unblocker'

function draftedText(decision: Decision, carried: Carried) {
  if (decision.draft) {
    return carried.followUpIssue === undefined
      ? decision.draft
      : { ...decision.draft, followUpIssue: carried.followUpIssue }
  }
  return decision.answer === undefined ? null : { answer: decision.answer }
}

/**
 * Applies the decision (or, in `trial`, only records it) and records it once for the exception on its head,
 * with what a model drafted for it and what that cost. A pass that raced another one to the same exception
 * records nothing more.
 */
export async function applyDecision(
  deps: ApplyDeps,
  exception: TaskException,
  decision: Decision,
  mode: CoordinatorMode,
): Promise<CoordinatorOutcome> {
  if (decision.action === 'prioritise' && mode === 'auto' && decision.failure === undefined) {
    return prioritiseAtomically(deps, exception, decision)
  }
  // The first wait says since when the fact is unreadable; the ones after it add nothing to that.
  if (decision.quiet) return 'deferred'
  const carried = await carryOut(deps, exception, decision, mode)
  await record(deps, exception, decision, carried)
  return carried.outcome
}

/**
 * The hold and its record commit together, one pass at a time per repository: another pass never sees the
 * delayed jobs without the applied action (and releases them), nor applies the same decision a second time.
 */
async function prioritiseAtomically(
  deps: ApplyDeps,
  exception: TaskException,
  decision: Decision,
): Promise<CoordinatorOutcome> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(HOLD_LOCK)
    const [done] = await tx
      .select()
      .from(coordinatorAction)
      .where(
        and(
          eq(coordinatorAction.taskId, exception.taskId),
          eq(coordinatorAction.exceptionKind, exception.kind),
          eq(coordinatorAction.headSha, exception.head),
          eq(coordinatorAction.outcome, 'applied'),
        ),
      )
    if (done) return 'applied'
    // One fix at a time per repository: a second one waits for its turn, and is decided again then.
    const [own] = await tx
      .select({ repository: task.repository })
      .from(task)
      .where(eq(task.id, exception.taskId))
    const active = (await readHeldTests(tx)).find(
      (h) => h.repository === own?.repository && h.taskId !== exception.taskId,
    )
    if (active) return 'refused'
    const moved = await moveAhead(tx, exception.taskId)
    const carried: Carried = moved
      ? { outcome: 'applied', reason: decision.reason }
      : notCarried(exception, decision, 'refused', 'its job is no longer waiting in the queue')
    await record({ ...deps, db: tx }, exception, decision, carried)
    return carried.outcome
  })
}

async function record(
  { db, now }: { db: Pick<Database, 'insert'>; now?: () => Date },
  exception: TaskException,
  decision: Decision,
  carried: Carried,
) {
  await db
    .insert(coordinatorAction)
    .values({
      taskId: exception.taskId,
      exceptionKind: exception.kind,
      headSha: exception.head,
      action: decision.action,
      reason: carried.reason,
      outcome: carried.outcome,
      draft: recordedDraft(decision, carried),
      costUsd: decision.costUsd ?? 0,
      at: now?.() ?? new Date(),
    })
    .onConflictDoNothing()
}
