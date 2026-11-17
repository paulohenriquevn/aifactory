import { inArray } from 'drizzle-orm'

import type { Database } from '../db'
import { task } from '../db/schema'

import { applyDecision, type ApplyDeps } from './apply'
import { decide, seen, type CoordinatorOutcome } from './decide'
import { draftScope, type DraftDeps } from './draft'
import { readExceptionFacts, readRecordedActions } from './exception-facts'
import { readCurrentReasons, readQueueFacts } from './queue-facts'
import { isHeld, recogniseQueue, testOf } from './queue-order'
import { maintainHolds } from './queue-hold'
import { recognise, type TaskException } from './exceptions'
import type { CoordinatorMode } from './mode'
import { readReleaseFacts, type ReleaseFactsDeps } from './release-facts'
import { recogniseRelease } from './release-train'

export type PassResult = Record<CoordinatorOutcome, number>

/** What a pass needs: the panel's actions, the two GitHub writes of a scope, the drafter and the release mode. */
export type CoordinatorDeps = ApplyDeps & DraftDeps & Pick<ReleaseFactsDeps, 'releaseMode'>

/** The exceptions of the tasks, then the release of each repository the train does not hold. */
async function exceptionsOf(deps: CoordinatorDeps): Promise<TaskException[]> {
  const ofTasks = (await readExceptionFacts(deps)).flatMap(recognise)
  const ofReleases = (await readReleaseFacts(deps)).map(recogniseRelease)
  const ofQueues = (await readQueueFacts(deps)).map(recogniseQueue)
  // The queue first: a task that failed on the test must find its fix already moved when its turn comes.
  return [
    ...ofQueues.filter((e): e is TaskException => e !== undefined),
    ...ofTasks,
    ...ofReleases.filter((e): e is TaskException => e !== undefined),
  ]
}

/** The repository of each task an exception names. */
async function repositoriesOf(db: Database, exceptions: TaskException[]) {
  const ids = [...new Set(exceptions.map((e) => e.taskId))]
  if (ids.length === 0) return new Map<number, string>()
  const rows = await db
    .select({ id: task.id, repository: task.repository })
    .from(task)
    .where(inArray(task.id, ids))
  return new Map(rows.map((r) => [r.id, r.repository]))
}

/**
 * One pass of the coordinator: it reads the facts, recognises the exceptions (a repository's release
 * included), decides one action for each one not yet decided on its head, has a model draft the text of a
 * `scope` (`draft.ts`, in `trial` too), and applies it (`apply.ts`). A repository whose release mode is
 * `trial` gets its release decided and recorded as in `trial`, whatever the coordinator's mode. An action
 * decided in this pass counts for the next exception of the same task, so the limit of applied actions holds
 * within a pass too.
 */
export async function coordinate(
  deps: CoordinatorDeps,
  mode: CoordinatorMode,
): Promise<PassResult> {
  const result: PassResult = { applied: 0, trial: 0, refused: 0, failed: 0, escalated: 0 }
  // A hold made in `auto` lasts until its fix ends, whatever the mode is now.
  if (mode === 'off') {
    await maintainHolds(deps.db)
    return result
  }
  const exceptions = await exceptionsOf(deps)
  const repositories = await repositoriesOf(deps.db, exceptions)
  const held = await maintainHolds(deps.db)
  const reasons = await readCurrentReasons(deps.db, [...new Set(exceptions.map((e) => e.taskId))])
  const recorded = await readRecordedActions(deps.db, [...new Set(exceptions.map((e) => e.taskId))])
  for (const exception of exceptions) {
    // The fix of this failure is on its way: the task waits for it, not sent back to fail the same way.
    const repository = repositories.get(exception.taskId)
    const reason = reasons.get(exception.taskId)
    if (isHeld(exception, repository, held, reason === undefined ? [] : [reason])) continue
    const forTask = recorded.get(exception.taskId)!
    const applying = exception.trialOnly ? 'trial' : mode
    if (seen(exception, forTask, applying)) continue
    const decision = await draftScope(deps, exception, decide(exception, forTask))
    const outcome = await applyDecision(deps, exception, decision, applying)
    forTask.push({
      exceptionKind: exception.kind,
      headSha: exception.head,
      action: decision.action,
      outcome,
    })
    result[outcome] += 1
    if (decision.action === 'prioritise' && outcome === 'applied') {
      held.push({ repository: repositories.get(exception.taskId)!, test: testOf(exception.head) })
    }
  }
  return result
}
