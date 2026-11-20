import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm'

import { question as questionTable, task } from '../db/schema'
import { fetchIssue as defaultFetchIssue, type Issue } from '../github/issues'
import { openBlockersOf } from './blocker-check'
import { BlockedByOpenIssues } from './blockers'
import { errorMessage } from './error-message'
import type { Clarification } from './harness'
import { withRecipe } from './recipe'
import { createGithubApi } from '../github/pulls'

import {
  Asked,
  BaseConflict,
  BaseRed,
  QuotaStop,
  quotaDetail,
  type Continuation,
} from './run-support'
import { endPause, pauseOnRefusal } from './provider-pause-store'
import { loadRepoConfig } from './repo-config'
import { untilSlotFree } from './sandbox-slot'
import { DEFAULT_TIMEOUTS, Run, type RunState } from './run'
import { resolveTimeouts } from './run-limit'
import { parkedOf, type Parked, type RunResult, type RunTaskDeps } from './run-types'
import { Preparation } from './sandbox-prepared'
import { enterRunStage, TaskCancelled } from './stages'

export type { RunResult, RunTaskDeps } from './run-types'
export { mergeEgress } from './run-support'

/**
 * Runs one task: reads the issue, starts an isolated sandbox, has the agent implement it, pushes
 * the result to `factory/<issue>`, runs the checks on the pushed commit and has an independent
 * reviewer read it. Checks that fail or a review that asks for changes send the work back to the
 * same agent session, up to three attempts. Green evidence for the pushed commit plus an approval
 * moves the task to `merge`, where the `merge-task` job opens the pull request; when attempts run out after green checks, a draft pull request
 * and a comment on the issue hand the work to a person. Each stage is recorded as the run enters
 * it, the sandbox is always stopped, and a failure is recorded as `failed` with its reason.
 */
export function runTask(
  deps: RunTaskDeps,
  taskId: number,
  /** Aborts when the job's lease expires: the sandbox is stopped so the run does not outlive it. */
  signal?: AbortSignal,
  /**
   * Set when a person sent the pull request back: the run starts from the branch the agent already
   * pushed, with what the person asked for in its prompt. When GitHub does not have that branch, it
   * starts from the integration branch as a first run does, with the same words in its prompt.
   */
  continuation?: Continuation,
): Promise<RunResult> {
  return execute(deps, taskId, signal, undefined, continuation)
}

/**
 * Continues a task that was waiting for an answer: a new sandbox from the snapshot taken when the
 * question was asked, the agent's own session resumed with the answer, and then the same checks,
 * review and attempts as any run. It takes the answer exactly once, so two workers cannot both
 * resume one question.
 */
export async function resumeTask(
  deps: RunTaskDeps,
  taskId: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  const [claimed] = await deps.db
    .update(questionTable)
    .set({ resumedAt: new Date() })
    .where(
      and(
        eq(questionTable.taskId, taskId),
        eq(questionTable.origin, 'agent'),
        isNotNull(questionTable.answer),
        isNull(questionTable.resumedAt),
      ),
    )
    .returning()
  if (!claimed) throw new Error(`task ${taskId} has no answered question to resume`)
  return execute(deps, taskId, signal, parkedOf(claimed))
}

async function execute(
  deps: RunTaskDeps,
  taskId: number,
  signal: AbortSignal | undefined,
  resuming?: Parked,
  continuation?: Continuation,
): Promise<RunResult> {
  const { db } = deps
  const [row] = await db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new Error(`task ${taskId} does not exist`)

  const state: RunState = { current: 'sandbox', sandbox: undefined }
  let preparation: Preparation | undefined
  try {
    // In the queue, before any stage: a run that waits here for a slot is not one stuck in `sandbox`.
    await waitForSlot(deps, taskId, signal)
    // A job a worker took just before its task was cancelled ends here, before any sandbox exists.
    await enterRunStage(db, taskId, 'sandbox', { provider: deps.sandbox.name })
    const prep = (preparation = new Preparation(taskId))

    const read = await prep.step('inputs', async () => {
      // One token, limited to this task's repository. It is used here and in the firewall rule,
      // and nothing below hands it to the sandbox.
      const { token } = await deps.github.installationToken(row.repository)
      const readIssue = deps.fetchIssue ?? defaultFetchIssue
      const issue = await readIssue(row.repository, row.issueNumber, token)
      await refuseWhileBlocked(deps, row.repository, issue, readIssue)
      const saved = await loadRepoConfig(db, row.repository)
      return {
        token,
        issue,
        saved,
        // Read from GitHub before any sandbox exists, so nothing the agent does can change it.
        recipe: await deps.fetchRecipe?.(row.repository, token),
        clarifications: await clarificationsOf(deps, taskId),
      }
    })
    const { token, issue, saved } = read
    const timeouts = resolveTimeouts(deps.timeouts ?? DEFAULT_TIMEOUTS, saved.runLimitMs)
    const run = await Run.open({
      deps: { ...deps, timeouts },
      taskId,
      row,
      issue,
      repo: withRecipe(saved, read.recipe),
      token,
      api: deps.githubApi ?? createGithubApi(),
      branch: `factory/${row.issueNumber}`,
      state,
      signal,
      resuming,
      continuation,
      clarifications: read.clarifications,
      preparation: prep,
    })
    // A sandbox started: the provider accepts again, so a pause it caused ends for every process.
    await endPause(db)
    // `start` logs the preparation once the install before the builder ends.
    const started = await run.start()
    return 'result' in started ? started.result : await run.loop(started.sha)
  } catch (error) {
    // A preparation that failed is logged with its step; one that ended was logged already.
    preparation?.log()
    return fail(deps, taskId, state, error, signal)
  } finally {
    await state.sandbox?.stop().catch(() => {})
  }
}

/** Waits while every sandbox the account allows is up, and says in the log how long it waited. */
async function waitForSlot(deps: RunTaskDeps, taskId: number, signal: AbortSignal | undefined) {
  const waited = await untilSlotFree(deps.sandbox, { ...deps.slotWait, signal })
  if (waited.waitedMs > 0 || waited.unread) {
    console.log(JSON.stringify({ event: 'sandbox_slot_waited', taskId, ...waited }))
  }
}

/**
 * Throws `BlockedByOpenIssues` when the issue declares a blocker that is still open (`openBlockersOf`),
 * before any sandbox exists: the work it waits for has not shipped, and an agent started now finds nothing
 * to build on.
 */
async function refuseWhileBlocked(
  deps: RunTaskDeps,
  repository: string,
  issue: Issue,
  readIssue: NonNullable<RunTaskDeps['fetchIssue']>,
): Promise<void> {
  const open = await openBlockersOf({ ...deps, fetchIssue: readIssue }, repository, issue.body)
  if (open.length > 0) throw new BlockedByOpenIssues(open)
}

/** The answers the owner gave to the scheduler's readiness questions on this task, oldest first. */
async function clarificationsOf(deps: RunTaskDeps, taskId: number): Promise<Clarification[]> {
  const rows = await deps.db
    .select({
      question: questionTable.body,
      answer: questionTable.answer,
      by: questionTable.answeredBy,
    })
    .from(questionTable)
    .where(
      and(
        eq(questionTable.taskId, taskId),
        eq(questionTable.origin, 'readiness'),
        isNotNull(questionTable.answer),
      ),
    )
    .orderBy(asc(questionTable.id))
  return rows.map((r) => ({ question: r.question, answer: r.answer ?? '', by: r.by ?? 'a person' }))
}

/**
 * Records how a run ended when it did not finish: parked on a question, or failed at a stage. A run whose task
 * was cancelled records nothing: the task stays cancelled and the job ends without a retry.
 */
async function fail(
  deps: RunTaskDeps,
  taskId: number,
  state: RunState,
  error: unknown,
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  if (error instanceof Asked) return error.result
  if (error instanceof TaskCancelled) return cancelled(taskId, state, error)
  const message = signal?.aborted
    ? 'the job lease expired before the run finished'
    : errorMessage(error)
  try {
    await recordFailure(deps, taskId, state, error, message)
    // A refusal for credit or spending pauses every run's sandbox, so the queue waits instead of failing.
    await pauseOnRefusal(deps.db, message)
  } catch (refused) {
    if (refused instanceof TaskCancelled) return cancelled(taskId, state, refused)
    throw refused
  }
  return { status: 'failed', stage: state.current, error: message }
}

/** The end of a run whose task was cancelled, said in the log since nothing more is recorded. */
function cancelled(taskId: number, state: RunState, error: TaskCancelled): RunResult {
  console.log(
    JSON.stringify({ event: 'run_cancelled', taskId, stage: state.current, why: error.reason }),
  )
  return { status: 'cancelled', stage: state.current, reason: error.reason }
}

/** The `failed` stage with the reason and what the error carries, unless the task was cancelled first. */
async function recordFailure(
  deps: RunTaskDeps,
  taskId: number,
  state: RunState,
  error: unknown,
  message: string,
): Promise<void> {
  await enterRunStage(deps.db, taskId, 'failed', {
    failedAt: state.current,
    error: message,
    ...(error instanceof QuotaStop ? quotaDetail(error, new Date()) : {}),
    ...(error instanceof BlockedByOpenIssues ? { blockedBy: error.blockedBy } : {}),
    ...(error instanceof BaseRed ? { baseRed: { sha: error.baseSha, checks: error.checks } } : {}),
    ...(error instanceof BaseConflict
      ? { baseConflict: { branch: error.branch, files: error.files } }
      : {}),
  })
}
