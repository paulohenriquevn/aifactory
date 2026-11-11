import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import { question as questionTable, task } from '../db/schema'
import { fetchIssue as defaultFetchIssue, type Issue } from '../github/issues'
import { BlockedByOpenIssues, declaredBlockers, openBlockers } from './blockers'
import { withRecipe } from './recipe'
import { createGithubApi } from '../github/pulls'

import { Asked, QuotaStop, quotaDetail, type Continuation } from './run-support'
import { loadRepoConfig } from './repo-config'
import { Run, type RunState } from './run'
import type { Parked, RunResult, RunTaskDeps } from './run-types'
import { enterStage } from './stages'

export type { RunResult, RunTaskDeps } from './run-types'
export { mergeEgress } from './run-support'

/**
 * Runs one task: reads the issue, starts an isolated sandbox, has the agent implement it, pushes
 * the result to `factory/<issue>`, runs the checks on the pushed commit and has an independent
 * reviewer read it. Checks that fail or a review that asks for changes send the work back to the
 * same agent session, up to three attempts. A pull request opens only on green evidence for the
 * pushed commit plus an approval; when attempts run out after green checks, a draft pull request
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
   * pushed, with what the person asked for in its prompt.
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
        isNotNull(questionTable.answer),
        isNull(questionTable.resumedAt),
      ),
    )
    .returning()
  if (!claimed) throw new Error(`task ${taskId} has no answered question to resume`)
  return execute(deps, taskId, signal, claimed)
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
  try {
    await enterStage(db, taskId, 'sandbox', { provider: deps.sandbox.name })

    // One token, limited to this task's repository. It is used here and in the firewall rule,
    // and nothing below hands it to the sandbox.
    const { token } = await deps.github.installationToken(row.repository)
    const readIssue = deps.fetchIssue ?? defaultFetchIssue
    const issue = await readIssue(row.repository, row.issueNumber, token)
    await refuseWhileBlocked(deps, row.repository, issue, readIssue)

    const run = await Run.open({
      deps,
      taskId,
      row,
      issue,
      // Read from GitHub before any sandbox exists, so nothing the agent does can change it.
      repo: withRecipe(
        await loadRepoConfig(db, row.repository),
        await deps.fetchRecipe?.(row.repository, token),
      ),
      token,
      api: deps.githubApi ?? createGithubApi(),
      branch: `factory/${row.issueNumber}`,
      state,
      signal,
      resuming,
      continuation,
    })
    const started = await run.start()
    return 'result' in started ? started.result : await run.loop(started.sha)
  } catch (error) {
    return fail(deps, taskId, state, error, signal)
  } finally {
    await state.sandbox?.stop().catch(() => {})
  }
}

/**
 * Throws `BlockedByOpenIssues` when the issue declares a blocker that is still open, before any sandbox
 * exists: the work it waits for has not shipped, and an agent started now finds nothing to build on. Each
 * blocker is read with a token for its own repository. One whose state is unknown counts as open.
 */
async function refuseWhileBlocked(
  deps: RunTaskDeps,
  repository: string,
  issue: Issue,
  readIssue: NonNullable<RunTaskDeps['fetchIssue']>,
): Promise<void> {
  const blockers = declaredBlockers(issue.body, repository)
  if (blockers.length === 0) return
  const open = await openBlockers(blockers, async (ref) => {
    const { token } = await deps.github.installationToken(ref.repository)
    return (await readIssue(ref.repository, ref.number, token)).state !== 'closed'
  })
  if (open.length > 0) throw new BlockedByOpenIssues(open)
}

/** Records how a run ended when it did not finish: parked on a question, or failed at a stage. */
async function fail(
  deps: RunTaskDeps,
  taskId: number,
  state: RunState,
  error: unknown,
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  if (error instanceof Asked) return error.result
  const message = signal?.aborted
    ? 'the job lease expired before the run finished'
    : error instanceof Error
      ? error.message
      : String(error)
  await enterStage(deps.db, taskId, 'failed', {
    failedAt: state.current,
    error: message,
    ...(error instanceof QuotaStop ? quotaDetail(error, new Date()) : {}),
    ...(error instanceof BlockedByOpenIssues ? { blockedBy: error.blockedBy } : {}),
  })
  return { status: 'failed', stage: state.current, error: message }
}
