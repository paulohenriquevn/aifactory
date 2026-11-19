import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { coordinatorAction, evidence, finding, repository, stageEvent, task } from '../db/schema'
import { integrationBranch } from '../factory/branches'
import { baseHoldOf, type BaseHold } from '../factory/await-ci'
import { readEvidence } from '../factory/check-evidence'
import { readOf, unread, type Read } from '../factory/doctor'
import type { GithubApp } from '../github/app'
import type { PromotionApi } from '../github/promotion-api'
import type { GithubApi } from '../github/pulls'
import { automaticRunsSincePerson } from '../panel/queries'

import type { RecordedAction } from './decide'
import {
  causeOf,
  readsChecks,
  readsCiOutput,
  type CheckRun,
  type CiFailure,
  type LastEvent,
  type OpenFinding,
  type PullRequestFacts,
  type TaskFacts,
} from './exceptions'

/** What the facts are read from: the database, and GitHub for the pull request of a handoff on failed checks. */
export type FactsDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  api: Pick<GithubApi, 'readPullRequest'>
  /**
   * The failed checks of a pull request's head and their logs, read for failed checks nothing else quoted.
   * Without it they are not read, and such a handoff is escalated as before.
   */
  ciChecks?: Pick<PromotionApi, 'failedChecks' | 'jobLog' | 'annotations'>
  /** The clock the age of a hold is measured against. */
  now?: () => Date
}

/**
 * What the coordinator reads before it decides anything, and nothing else: the tasks with an exception to
 * look at, their last events, their automatic runs, the supervisor's open findings about their runs and the
 * decisions already recorded for them, and, for a handoff on failed checks, whether its pull request conflicts
 * with its base and, when nothing else quoted the checks, what the failed GitHub Actions jobs of its head logged.
 * It decides nothing (`exceptions.ts` does). A read of the tasks, the
 * findings or the record that fails is thrown, because without them there is nothing to decide over; a read
 * of what each task says that fails is handed over as not read, and becomes an `unknown` exception.
 */

/** The findings about a run of a task: the ones the panel retries from. */
const RUN_SUBJECTS = ['run', 'queued_run'] as const

async function openFindings(db: Database) {
  return db
    .select({ id: finding.id, kind: finding.kind, taskId: finding.taskId, detail: finding.detail })
    .from(finding)
    .where(
      and(
        isNull(finding.resolvedAt),
        isNotNull(finding.taskId),
        inArray(finding.subject, [...RUN_SUBJECTS]),
      ),
    )
    .orderBy(finding.id)
}

/** A read of one fact for every task, or the reason it could not be read, for each of them. */
async function readEach<T>(tried: string, read: () => Promise<Map<number, T>>) {
  try {
    const values = await read()
    return (taskId: number, absent: T): Read<T> => readOf(values.get(taskId) ?? absent)
  } catch (error) {
    const failed = unread(tried, error instanceof Error ? error.message : String(error))
    return (): Read<T> => failed
  }
}

async function lastEvents(db: Database, ids: number[]) {
  const rows = await db
    .selectDistinctOn([stageEvent.taskId], {
      id: stageEvent.id,
      taskId: stageEvent.taskId,
      stage: stageEvent.stage,
      detail: stageEvent.detail,
    })
    .from(stageEvent)
    .where(inArray(stageEvent.taskId, ids))
    .orderBy(stageEvent.taskId, desc(stageEvent.id))
  return new Map<number, LastEvent | null>(
    rows.map((r) => [
      r.taskId,
      { id: r.id, stage: r.stage, detail: (r.detail ?? null) as Record<string, unknown> | null },
    ]),
  )
}

/** The checks the factory ran on each of these tasks, oldest first. */
async function checkRuns(db: Database, ids: number[]) {
  const byTask = new Map<number, CheckRun[]>(ids.map((id) => [id, []]))
  if (ids.length === 0) return byTask
  const rows = await db
    .select({
      taskId: evidence.taskId,
      name: evidence.name,
      command: evidence.command,
      sha: evidence.sha,
      passed: evidence.passed,
      output: evidence.output,
    })
    .from(evidence)
    .where(inArray(evidence.taskId, ids))
    .orderBy(evidence.id)
  for (const { taskId, ...run } of rows) byTask.get(taskId)?.push(run)
  return byTask
}

async function automaticRuns(db: Database, ids: number[]) {
  const rows = await db
    .select({ taskId: stageEvent.taskId, automatic: automaticRunsSincePerson() })
    .from(stageEvent)
    .where(inArray(stageEvent.taskId, ids))
    .groupBy(stageEvent.taskId)
  return new Map(rows.map((r) => [r.taskId, Number(r.automatic)]))
}

/** The hold each task has on its latest `done` event, for the commit it waits on. */
async function baseHolds(db: Database, rows: { id: number; awaitingCiSha: string | null }[]) {
  const ids = rows.map((r) => r.id)
  const events = await db
    .selectDistinctOn([stageEvent.taskId], { taskId: stageEvent.taskId, detail: stageEvent.detail })
    .from(stageEvent)
    .where(and(inArray(stageEvent.taskId, ids), eq(stageEvent.stage, 'done')))
    .orderBy(stageEvent.taskId, desc(stageEvent.id))
  const detail = new Map(events.map((e) => [e.taskId, e.detail]))
  return new Map<number, BaseHold | null>(
    rows.map((r) => [r.id, baseHoldOf(detail.get(r.id), r.awaitingCiSha)]),
  )
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type PulledTask = { id: number; repository: string; pullRequestUrl: string | null }

/** GitHub's word on whether the pull request of the task can merge into its base, or why it was not read. */
async function pullRequestOf(
  deps: FactsDeps,
  row: PulledTask,
): Promise<Read<PullRequestFacts | null>> {
  if (!row.pullRequestUrl) return readOf(null)
  const tried = `the pull request of task ${row.id} (${row.pullRequestUrl})`
  try {
    const number = Number(/\/pull\/(\d+)$/.exec(row.pullRequestUrl)?.[1])
    if (!number) throw new Error('its URL names no pull request number')
    const [config] = await deps.db
      .select({ baseBranch: repository.baseBranch })
      .from(repository)
      .where(eq(repository.fullName, row.repository))
    const { token } = await deps.github.installationToken(row.repository)
    const pull = await deps.api.readPullRequest(row.repository, token, number)
    // GitHub does not move the head of a closed pull request: its merge state is of a commit the branch left.
    if (pull.state === 'closed' && !pull.merged) {
      return unread(tried, 'the pull request is closed, so its merge state is stale')
    }
    return readOf({
      conflicting: pull.mergeableState === 'dirty',
      base: integrationBranch(config ?? {}),
      head: pull.headSha,
    })
  } catch (error) {
    return unread(tried, message(error))
  }
}

/** The most failed checks of one commit whose logs are read: each log is a download. */
const CI_LOGS_MAX = 5

/**
 * The checks that failed on GitHub for `sha`, each with the lines its log (or its annotations) gives, or why
 * they could not be read. The text is CI output: data for an agent to read, never a command to run.
 */
export async function ciFailuresOf(
  deps: FactsDeps,
  ci: NonNullable<FactsDeps['ciChecks']>,
  repo: string,
  sha: string,
): Promise<Read<CiFailure[]>> {
  try {
    const { token } = await deps.github.installationToken(repo)
    const runs = (await ci.failedChecks(repo, token, sha)).slice(0, CI_LOGS_MAX)
    const failures: CiFailure[] = []
    for (const run of runs) {
      const lines = await readEvidence(ci, repo, token, run)
      failures.push({ name: run.name, url: run.url, lines })
    }
    return readOf(failures)
  } catch (error) {
    return unread(`the failed checks of ${sha.slice(0, 7)} on GitHub in ${repo}`, message(error))
  }
}

const reasonOf = (event: Read<LastEvent | null>) =>
  event.read && typeof event.value?.detail?.reason === 'string' ? event.value.detail.reason : ''

/** The pull request of a handoff on failed checks and, when nothing else quoted them, their GitHub logs. */
async function withPullRequest(
  deps: FactsDeps,
  row: PulledTask,
  facts: TaskFacts,
): Promise<TaskFacts> {
  const pullRequest = await pullRequestOf(deps, row)
  const pull = pullRequest.read ? pullRequest.value : null
  const read = { ...facts, pullRequest }
  const quiet = readsCiOutput(reasonOf(facts.last), facts)
  if (!deps.ciChecks || !pull?.head || pull.conflicting || !quiet) return read
  return { ...read, ciFailures: await ciFailuresOf(deps, deps.ciChecks, row.repository, pull.head) }
}

/** The facts of every task in `handoff` or `failed`, and of every task with an open finding about its run. */
export async function readExceptionFacts(deps: FactsDeps): Promise<TaskFacts[]> {
  const { db } = deps
  const found = await openFindings(db)
  const flagged = found.map((f) => f.taskId!)
  const rows = await db
    .select({
      id: task.id,
      stage: task.stage,
      headSha: task.headSha,
      repository: task.repository,
      pullRequestUrl: task.pullRequestUrl,
      awaitingCiSha: task.awaitingCiSha,
      baseBranch: repository.baseBranch,
    })
    .from(task)
    .leftJoin(repository, eq(repository.fullName, task.repository))
    .where(
      or(
        inArray(task.stage, ['handoff', 'failed']),
        inArray(task.id, flagged),
        and(eq(task.stage, 'done'), isNotNull(task.awaitingCiSha)),
      ),
    )
    .orderBy(task.id)
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const last = await readEach('the last events of the tasks', () => lastEvents(db, ids))
  const runs = await readEach('the automatic runs of the tasks', () => automaticRuns(db, ids))
  const waiting = rows.filter((r) => r.stage === 'done' && r.awaitingCiSha !== null)
  const holds = await readEach('the holds of the integration branch on the tasks', () =>
    baseHolds(db, waiting),
  )
  // Only the tasks whose exception quotes or names their checks: a failure on them, or a red base.
  const checked = rows
    .filter((r) => {
      const event = last(r.id, null)
      return event.read && readsChecks(r.stage, event.value?.detail ?? null)
    })
    .map((r) => r.id)
  const checks = await readEach('the checks of the tasks', () => checkRuns(db, checked))
  const at = deps.now?.() ?? new Date()
  return Promise.all(
    rows.map(async (r): Promise<TaskFacts> => {
      const lastEvent = last(r.id, null)
      const facts: TaskFacts = {
        taskId: r.id,
        stage: r.stage,
        headSha: r.headSha,
        last: lastEvent,
        automaticRuns: runs(r.id, 0),
        findings: found
          .filter((f) => f.taskId === r.id)
          .map((f): OpenFinding => ({ id: f.id, kind: f.kind, detail: f.detail })),
        repository: { fullName: r.repository, integrationBranch: integrationBranch(r) },
        ...(checked.includes(r.id) ? { checks: checks(r.id, []) } : {}),
      }
      if (r.stage === 'done' && r.awaitingCiSha !== null) {
        return { ...facts, baseHold: holds(r.id, null), at }
      }
      const onFailedChecks =
        r.stage === 'handoff' &&
        lastEvent.read &&
        causeOf(lastEvent.value?.detail ?? null) === 'checks_unchanged'
      return onFailedChecks ? withPullRequest(deps, r, facts) : facts
    }),
  )
}

/** The decisions the coordinator recorded for these tasks, by task. */
export async function readRecordedActions(
  db: Database,
  taskIds: number[],
): Promise<Map<number, RecordedAction[]>> {
  const byTask = new Map<number, RecordedAction[]>(taskIds.map((id) => [id, []]))
  if (taskIds.length === 0) return byTask
  const rows = await db
    .select({
      taskId: coordinatorAction.taskId,
      exceptionKind: coordinatorAction.exceptionKind,
      headSha: coordinatorAction.headSha,
      action: coordinatorAction.action,
      outcome: coordinatorAction.outcome,
      at: coordinatorAction.at,
      // The unblocker marks what it decided (`recordedDraft` in apply.ts), which its own limit counts.
      unblocker: sql<boolean>`coalesce(${coordinatorAction.draft} ->> 'by' = 'unblocker', false)`,
    })
    .from(coordinatorAction)
    .where(inArray(coordinatorAction.taskId, taskIds))
    .orderBy(coordinatorAction.id)
  for (const { taskId, ...row } of rows) byTask.get(taskId)?.push(row)
  return byTask
}
