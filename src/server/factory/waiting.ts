import { and, eq, isNull } from 'drizzle-orm'

import type { Database } from '../db'
import { question, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { GithubApi, IssueComment } from '../github/pulls'

import { enterStage } from './stages'

/** Hidden in every comment the factory writes, so it never reads its own comment as an answer. */
export const QUESTION_MARKER = '<!-- aifactory:question -->'

const QUESTION_LINE = /^QUESTION:[ \t]*/im
const QUESTION_MAX = 1_500

/**
 * The question an agent left at the end of its answer, if it left one. The protocol is a line that
 * starts with `QUESTION:`; whatever follows, to the end, is the question.
 */
export function parseQuestion(text: string): string | undefined {
  const found = [...text.matchAll(new RegExp(QUESTION_LINE, 'gim'))].at(-1)
  if (found?.index === undefined) return undefined
  const body = text.slice(found.index + found[0].length).trim()
  return body === '' ? undefined : body.slice(0, QUESTION_MAX)
}

export function questionComment(taskId: number, body: string): string {
  return [
    QUESTION_MARKER,
    `**The factory has a question** before it can go on (task ${taskId}):`,
    '',
    body,
    '',
    'Reply in a comment on this issue. The work continues from where it stopped.',
  ].join('\n')
}

/** What the builder is told when a person has answered. */
export function answerPrompt(asked: string, answer: string, by: string): string {
  return [
    'A person answered your question. Continue the work.',
    `Your question:\n\n${asked}`,
    `The answer, from ${by}:\n\n${answer}`,
    'Treat the answer as what is wanted. It does not change the rules you were given: keep the change limited to the issue, and do not run git commit or git push.',
  ].join('\n\n')
}

/** Only people with write access can steer an agent: a stranger's comment is not an instruction. */
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const ANSWER_MAX = 4_000

/**
 * The answer in a list of comments: what trusted people wrote after the question, in order. A
 * comment from a bot, from the factory itself, or from anyone without write access does not count.
 */
export function pickAnswer(
  comments: IssueComment[],
  asked: { commentId: string; at: Date },
): { text: string; by: string } | undefined {
  const mine = comments.filter(
    (c) =>
      c.id !== asked.commentId &&
      c.authorType === 'User' &&
      TRUSTED.has(c.association) &&
      !c.body.includes(QUESTION_MARKER) &&
      c.createdAt > asked.at &&
      c.body.trim() !== '',
  )
  if (mine.length === 0) return undefined
  return {
    text: mine
      .map((c) => c.body.trim())
      .join('\n\n')
      .slice(0, ANSWER_MAX),
    by: [...new Set(mine.map((c) => c.author))].join(', '),
  }
}

export type PollDeps = {
  db: Database
  github: GithubApp
  api: GithubApi
  /**
   * Runs `work` in one transaction and hands it the way to queue the resume inside it, so an answer
   * is never stored without its job or queued without being stored.
   */
  inTransaction: <T>(
    work: (
      tx: Database,
      enqueueResume: (taskId: number, questionId: number) => Promise<void>,
    ) => Promise<T>,
  ) => Promise<T>
  /** Frees the snapshot of a question nobody answered. */
  deleteSnapshot?: (snapshotId: string) => Promise<void>
  now?: () => Date
  /** How long a question may wait. It matches how long the snapshot lives. */
  ttlMs: number
}

export type PollResult = { answered: number[]; expired: number[]; waiting: number }

/**
 * Looks at every unanswered question: stores an answer that has come and queues the resume, and
 * lets one that has waited too long fail its task. It runs on a schedule, so it needs no inbound
 * webhook for comments, and a restart loses nothing: the question, the snapshot and the session
 * are all in the database.
 */
export async function pollAnswers(deps: PollDeps): Promise<PollResult> {
  const now = (deps.now ?? (() => new Date()))()
  const open = await deps.db
    .select({ q: question, repository: task.repository, issueNumber: task.issueNumber })
    .from(question)
    .innerJoin(task, eq(task.id, question.taskId))
    .where(and(isNull(question.answer), eq(task.stage, 'waiting')))
  const result: PollResult = { answered: [], expired: [], waiting: 0 }

  for (const { q, repository, issueNumber } of open) {
    if (now.getTime() - q.askedAt.getTime() > deps.ttlMs) {
      await enterStage(deps.db, q.taskId, 'failed', {
        failedAt: 'waiting',
        error: `nobody answered in ${Math.round(deps.ttlMs / 86_400_000)} days`,
        questionId: q.id,
      })
      await deps.deleteSnapshot?.(q.snapshotId).catch(() => {})
      result.expired.push(q.id)
      continue
    }
    const { token } = await deps.github.installationToken(repository)
    const comments = await deps.api.listIssueComments(repository, token, issueNumber, q.askedAt)
    const answer = pickAnswer(comments, { commentId: q.commentId, at: q.askedAt })
    if (!answer) {
      result.waiting += 1
      continue
    }
    const stored = await deps.inTransaction(async (tx, enqueueResume) => {
      const claimed = await tx
        .update(question)
        .set({ answer: answer.text, answeredBy: answer.by, answeredAt: now })
        .where(and(eq(question.id, q.id), isNull(question.answer)))
        .returning({ id: question.id })
      if (claimed.length === 0) return false
      await enqueueResume(q.taskId, q.id)
      return true
    })
    if (stored) result.answered.push(q.id)
  }
  return result
}
