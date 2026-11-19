import { and, asc, eq, isNull } from 'drizzle-orm'

import type { Database } from '../db'
import { coordinatorAction, question, stageEvent, task } from '../db/schema'
import { readOf, unread, type Read } from '../factory/doctor'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import type { Decision } from './decide'
import { reviewsOf, type ReadIssue } from './draft'
import { ciFailuresOf, type FactsDeps } from './exception-facts'
import type { TaskException } from './exceptions'
import type {
  HistoryEvent,
  OpenQuestion,
  PastAction,
  PullView,
  ReadComment,
  UnblockerFacts,
} from './unblocker'

/**
 * What the unblocker reads before it is asked, and nothing else: the issue and its comments, the task's history,
 * its reviews, its pull request and the failed checks of its head with their logs, and what the coordinator
 * already decided on it. It decides nothing (`unblocker.ts` does). The task itself must be read; any other read
 * that fails is handed over as not read, and the unblocker decides on what it has.
 */

export type UnblockerFactsDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  api: Pick<GithubApi, 'readPullRequest' | 'listIssueComments'>
  readIssue: ReadIssue
  ciChecks?: FactsDeps['ciChecks']
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function attempt<T>(tried: string, read: () => Promise<T>): Promise<Read<T>> {
  try {
    return readOf(await read())
  } catch (error) {
    return unread(tried, message(error))
  }
}

/** The questions builders asked that nobody answered, on tasks that wait for them. */
export async function readOpenQuestions(db: Database): Promise<OpenQuestion[]> {
  const rows = await db
    .select({ q: question })
    .from(question)
    .innerJoin(task, eq(task.id, question.taskId))
    .where(and(isNull(question.answer), eq(question.origin, 'agent'), eq(task.stage, 'waiting')))
    .orderBy(asc(question.id))
  return rows.map(({ q }) => ({
    taskId: q.taskId,
    questionId: q.id,
    body: q.body,
    askedAt: q.askedAt,
  }))
}

const SAID = ['reason', 'error', 'note', 'decision', 'cause'] as const

/** What an event's detail says, from the fields a person reads. */
function saidOf(detail: unknown): string {
  const fields = (detail ?? {}) as Record<string, unknown>
  return SAID.map((key) => fields[key])
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' | ')
}

async function historyOf(db: Database, taskId: number): Promise<HistoryEvent[]> {
  const rows = await db
    .select({ stage: stageEvent.stage, at: stageEvent.at, detail: stageEvent.detail })
    .from(stageEvent)
    .where(eq(stageEvent.taskId, taskId))
    .orderBy(asc(stageEvent.id))
  return rows.map((r) => ({ stage: r.stage, at: r.at, said: saidOf(r.detail) }))
}

async function pastOf(db: Database, taskId: number): Promise<PastAction[]> {
  return db
    .select({
      exceptionKind: coordinatorAction.exceptionKind,
      action: coordinatorAction.action,
      outcome: coordinatorAction.outcome,
      reason: coordinatorAction.reason,
    })
    .from(coordinatorAction)
    .where(eq(coordinatorAction.taskId, taskId))
    .orderBy(asc(coordinatorAction.id))
}

type TaskRow = typeof task.$inferSelect

async function pullOf(
  deps: UnblockerFactsDeps,
  row: TaskRow,
  token: string,
): Promise<PullView | null> {
  if (!row.pullRequestUrl) return null
  const number = Number(/\/pull\/(\d+)$/.exec(row.pullRequestUrl)?.[1])
  if (!number) throw new Error(`${row.pullRequestUrl} names no pull request number`)
  const pull = await deps.api.readPullRequest(row.repository, token, number)
  return {
    url: pull.url,
    state: pull.merged ? 'merged' : pull.state,
    mergeableState: pull.mergeableState,
    headSha: pull.headSha,
  }
}

/** What GitHub holds of the task: its issue, the comments on it and its pull request. */
async function githubFacts(deps: UnblockerFactsDeps, row: TaskRow) {
  const { repository: repo, issueNumber } = row
  let token: string
  try {
    token = (await deps.github.installationToken(repo)).token
  } catch (error) {
    const failed = unread(`a token for ${repo}`, message(error))
    return { issue: failed, comments: failed, pullRequest: failed }
  }
  const issue = await attempt(`issue ${repo}#${issueNumber}`, () =>
    deps.readIssue(repo, issueNumber, token),
  )
  const comments = await attempt(`the comments of ${repo}#${issueNumber}`, async () =>
    (await deps.api.listIssueComments(repo, token, issueNumber, new Date(0))).map(
      (c): ReadComment => ({
        author: c.author,
        association: c.association,
        body: c.body,
        at: c.createdAt,
      }),
    ),
  )
  const pullRequest = await attempt(`the pull request of task ${row.id}`, () =>
    pullOf(deps, row, token),
  )
  return { issue, comments, pullRequest }
}

/** The failed checks of the pull request's head, read only when there is a head and a way to read them. */
function ciOf(deps: UnblockerFactsDeps, row: TaskRow, pullRequest: Read<PullView | null>) {
  const head = pullRequest.read ? pullRequest.value?.headSha : undefined
  if (!deps.ciChecks || !head) return undefined
  return ciFailuresOf(deps, deps.ciChecks, row.repository, head)
}

/** Everything the unblocker reads about the task of an exception the coordinator would escalate. */
export async function readUnblockerFacts(
  deps: UnblockerFactsDeps,
  exception: TaskException,
  escalation: Decision,
): Promise<UnblockerFacts> {
  const [row] = await deps.db.select().from(task).where(eq(task.id, exception.taskId))
  if (!row) throw new Error(`task ${exception.taskId} does not exist`)
  const { issue, comments, pullRequest } = await githubFacts(deps, row)
  const id = row.id
  return {
    exception,
    escalation: escalation.reason,
    repository: row.repository,
    issueNumber: row.issueNumber,
    stage: row.stage,
    title: issue.read ? issue.value.title : row.issueTitle,
    body: issue.read ? readOf(issue.value.body) : issue,
    comments,
    history: await attempt(`the history of task ${id}`, () => historyOf(deps.db, id)),
    reviews: await attempt(`the reviews of task ${id}`, () => reviewsOf(deps.db, id)),
    pullRequest,
    ciFailures: await ciOf(deps, row, pullRequest),
    past: await attempt(`the coordinator's record of task ${id}`, () => pastOf(deps.db, id)),
  }
}
