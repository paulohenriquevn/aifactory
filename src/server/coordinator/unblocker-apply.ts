import { eq } from 'drizzle-orm'

import { repository, task } from '../db/schema'
import { integrationBranch } from '../factory/branches'
import { outcome as transition } from '../factory/transitions'
import type { PollDeps } from '../factory/waiting'
import type { IssuesApi } from '../github/issues-api'
import type { PromotionApi } from '../github/promotion-api'
import {
  ActionRefused,
  answerByCoordinator,
  resolveElsewhere,
  retry,
  sendBackByCoordinator,
  type ActionDeps,
} from '../panel/actions'

import type { CoordinatorActionKind, Decision } from './decide'
import type { ReadIssue } from './draft'
import type { TaskException } from './exceptions'
import { isEvidence, issueRefOf, withBlocker, type UnblockerVerdict } from './unblocker'

/**
 * Carries out the actions only the unblocker decides, each through the panel's own actions, which ask
 * `factory/transitions.ts` first. Its only writes of its own are on GitHub: the `Blocked by` line on an issue and the
 * rerun of failed GitHub Actions jobs, each after the transition table allowed the send-back that follows it. It
 * merges nothing. `send_back`, `merge_base` and `scope` go through `apply.ts` as the coordinator's own do.
 */

export type UnblockerApplyDeps = ActionDeps & {
  issues: Pick<IssuesApi, 'updateIssueBody'>
  readIssue: ReadIssue
  /** Re-runs failed jobs on GitHub Actions; without it a `rerun_checks` is refused. */
  checkReruns?: Pick<PromotionApi, 'failedChecks' | 'jobAttempt' | 'rerunFailedJobs'>
  /** Stores an answer and queues its resume in one transaction; without it an `answer` is refused. */
  answerInTransaction?: PollDeps['inTransaction']
}

/** The actions that only the unblocker decides, which this module carries out. */
export const UNBLOCKER_ONLY: readonly CoordinatorActionKind[] = [
  'answer',
  'rerun_checks',
  'blocked_by',
  'retry',
  'resolve_elsewhere',
]

const short = (sha: string) => sha.slice(0, 7)

/** The task, once the transition table allows the coordinator to send it back. */
async function sendable(deps: UnblockerApplyDeps, taskId: number) {
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new ActionRefused(`task ${taskId} does not exist`)
  const allowed = transition(row, 'coordinator_send_back')
  if (allowed.kind !== 'action') throw new ActionRefused(allowed.reason)
  return row
}

/**
 * Re-runs the failed GitHub Actions jobs of the task's head, once per workflow run, then sends the task back with
 * no note, so its run goes through the checks and the review again and its pull request waits for the new jobs.
 */
async function rerunChecks(deps: UnblockerApplyDeps, taskId: number): Promise<string> {
  const row = await sendable(deps, taskId)
  const reruns = deps.checkReruns
  if (!reruns) throw new ActionRefused('re-running checks on GitHub is not configured')
  const head = row.headSha
  if (!head) throw new ActionRefused('the task has no commit whose checks could run again')
  const { token } = await deps.github.installationToken(row.repository)
  const jobs = (await reruns.failedChecks(row.repository, token, head)).filter((r) => r.actions)
  if (jobs.length === 0) {
    throw new ActionRefused(`no GitHub Actions job failed on ${short(head)}`)
  }
  const runs = new Set<number>()
  for (const job of jobs) {
    runs.add((await reruns.jobAttempt(row.repository, token, job.id)).runId)
  }
  const refusals: string[] = []
  for (const run of runs) {
    const answer = await reruns.rerunFailedJobs(row.repository, token, run)
    if (!answer.started) refusals.push(answer.refusal)
  }
  if (refusals.length === runs.size) throw new ActionRefused(refusals.join('; '))
  await sendBackByCoordinator(deps, taskId, '')
  const started = runs.size - refusals.length
  return `re-ran the failed jobs of ${started} of ${runs.size} workflow runs on ${short(head)}`
}

/**
 * Declares the blocker on the issue, unless it already says so, and sends the task back with no note: its run reads
 * the line before any sandbox exists and waits for the blocker to close (`openBlockersOf`).
 */
async function blockedBy(deps: UnblockerApplyDeps, taskId: number, issue: string) {
  const row = await sendable(deps, taskId)
  const ref = issueRefOf(issue, row.repository)
  if (!ref) throw new ActionRefused(`${issue} is not an issue reference`)
  const { token } = await deps.github.installationToken(row.repository)
  const { body } = await deps.readIssue(row.repository, row.issueNumber, token)
  const updated = withBlocker(body, ref, row.repository)
  if (updated !== undefined) {
    await deps.issues.updateIssueBody(row.repository, token, row.issueNumber, updated)
  }
  await sendBackByCoordinator(deps, taskId, '')
  return updated === undefined ? 'the issue already declared the blocker' : 'the blocker was added'
}

/**
 * Starts the task over only when it pushed nothing: starting over deletes its branch, and work that a run pushed is
 * sent back on its branch instead, so a model's choice never throws it away.
 */
async function startOver(deps: UnblockerApplyDeps, taskId: number): Promise<string> {
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new ActionRefused(`task ${taskId} does not exist`)
  if (row.headSha || row.pullRequestUrl) {
    const at = row.headSha ? ` at ${short(row.headSha)}` : ''
    throw new ActionRefused(
      `the task has pushed work${at}; starting over would delete its branch, so send it back on it instead`,
    )
  }
  await retry(deps, taskId, { automatic: true })
  return 'started over from the integration branch'
}

/**
 * Resolves the task elsewhere only when the commit the unblocker names is in the integration branch's history: a
 * resolution marks the task delivered and a release then closes its issue, so a commit a model made up, or a run
 * that shows no change in that branch, is refused. A commit GitHub does not know fails the read, and nothing changes.
 */
async function resolvedIn(
  deps: UnblockerApplyDeps,
  taskId: number,
  evidence: string,
  note: string,
) {
  const sha = evidence.trim()
  if (!isEvidence(sha)) {
    throw new ActionRefused(
      `a resolution elsewhere names the full commit that holds the work, and ${sha || 'none'} is not one`,
    )
  }
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new ActionRefused(`task ${taskId} does not exist`)
  const [config] = await deps.db
    .select({ baseBranch: repository.baseBranch })
    .from(repository)
    .where(eq(repository.fullName, row.repository))
  const branch = integrationBranch(config ?? {})
  const { token } = await deps.github.installationToken(row.repository)
  const head = await deps.api.branchHead(row.repository, token, branch)
  if (!head || !(await deps.api.contains(row.repository, token, head, sha))) {
    throw new ActionRefused(`${branch} of ${row.repository} does not hold ${short(sha)}`)
  }
  await resolveElsewhere(deps, taskId, note)
  return `resolved elsewhere, in ${short(sha)} on ${branch}`
}

async function answer(
  deps: UnblockerApplyDeps,
  exception: TaskException,
  text: string,
): Promise<string> {
  if (!deps.answerInTransaction) throw new ActionRefused('answering questions is not configured')
  if (exception.questionId === undefined) throw new ActionRefused('no question was named')
  const done = await answerByCoordinator(
    { ...deps, answerInTransaction: deps.answerInTransaction },
    exception.taskId,
    exception.questionId,
    text,
  )
  return done.commented
    ? 'answered on the issue'
    : `answered, but its comment on the issue failed: ${done.error}`
}

/** Carries out an action only the unblocker decides, and answers what it did, for the record. */
export async function applyUnblocker(
  deps: UnblockerApplyDeps,
  exception: TaskException,
  decision: Decision,
): Promise<string> {
  const verdict: UnblockerVerdict | undefined = decision.unblocker
  if (!verdict) throw new Error(`${decision.action} is decided only by the unblocker`)
  const { taskId } = exception
  switch (verdict.action) {
    case 'answer':
      return answer(deps, exception, verdict.text)
    case 'rerun_checks':
      return rerunChecks(deps, taskId)
    case 'blocked_by':
      return blockedBy(deps, taskId, verdict.issue)
    case 'retry':
      return startOver(deps, taskId)
    case 'resolve_elsewhere':
      return resolvedIn(deps, taskId, verdict.evidence ?? '', decision.note ?? verdict.reason)
    default:
      throw new Error(`the unblocker has no way to apply ${verdict.action} here`)
  }
}
