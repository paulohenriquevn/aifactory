import { and, asc, desc, eq } from 'drizzle-orm'

import { SCOPE_INSTRUCTIONS } from '../agents/prompts/scope'
import type { Database } from '../db'
import { changePlan, review, stageEvent, task } from '../db/schema'
import { oneShotAssistant, type AssistantSpec } from '../factory/assistant'
import { renderChangePlan, type ChangePlan } from '../factory/change-plan'
import { coordinatorModel } from '../factory/models'
import { roundsNote, type Finding } from '../factory/review'
import type { GithubApp } from '../github/app'
import type { Issue } from '../github/issues'

import type { Decision } from './decide'
import type { TaskException } from './exceptions'
import { parseScopeDraft, roundsOfRun, scopeMessage, type ReviewRound } from './scope'

/**
 * The step between `decide` and `apply` for a `scope`: it reads what the drafter needs, asks the model and
 * reads its answer. The model drafts text only; the action was already decided, and an answer that does not
 * parse makes the decision an `escalate`.
 */

/** Reads an issue with a token for its repository, as `fetchIssue` does. */
export type ReadIssue = (repo: string, number: number, token: string) => Promise<Issue>

/** A model that answers one message, with what the answer cost. */
export type ScopeDrafter = (message: string) => Promise<{ response: string; cost: number }>

export type DraftDeps = {
  db: Database
  github: GithubApp
  readIssue: ReadIssue
  drafter: ScopeDrafter
}

/** The drafter as an assistant: no tools of its own, so only the knowledge base's two read tools. */
export const SCOPE_DRAFTER_SPEC: AssistantSpec = {
  system: SCOPE_INSTRUCTIONS,
  tools: {},
  asks: {},
}

/** The most one draft may spend. */
const DRAFT_BUDGET_USD = 1

/**
 * The drafter on a model, built by `buildAssistant` and run once per call. The key comes from the model's
 * provider, as TheoKit resolves it for the panel's assistants. `FACTORY_COORDINATOR_MODEL` changes the model.
 */
export function modelScopeDrafter(model: string = coordinatorModel()): ScopeDrafter {
  return oneShotAssistant('scope-drafter', model, SCOPE_DRAFTER_SPEC, DRAFT_BUDGET_USD)
}

async function lastHandoff(db: Database, taskId: number) {
  const [row] = await db
    .select({ detail: stageEvent.detail })
    .from(stageEvent)
    .where(and(eq(stageEvent.taskId, taskId), eq(stageEvent.stage, 'handoff')))
    .orderBy(desc(stageEvent.id))
    .limit(1)
  const detail = (row?.detail ?? {}) as { findings?: Finding[]; attempts?: number }
  return { findings: detail.findings ?? [], attempts: detail.attempts ?? 0 }
}

async function latestPlan(db: Database, taskId: number) {
  const [row] = await db
    .select({ plan: changePlan.plan })
    .from(changePlan)
    .where(eq(changePlan.taskId, taskId))
    .orderBy(desc(changePlan.id))
    .limit(1)
  return row ? renderChangePlan(row.plan as ChangePlan) : undefined
}

/** The review rounds of a task, oldest first. */
export async function reviewsOf(db: Database, taskId: number): Promise<ReviewRound[]> {
  const rows = await db
    .select({
      round: review.round,
      sha: review.sha,
      verdict: review.verdict,
      summary: review.summary,
      findings: review.findings,
    })
    .from(review)
    .where(eq(review.taskId, taskId))
    .orderBy(asc(review.id))
  return rows.map((r) => ({ ...r, findings: r.findings as Finding[] }))
}

/** The message for the drafter: the issue as GitHub holds it now, the plan and the review rounds. */
async function scopeMessageFor(deps: DraftDeps, taskId: number): Promise<string> {
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new Error(`task ${taskId} does not exist`)
  const { token } = await deps.github.installationToken(row.repository)
  const issue = await deps.readIssue(row.repository, row.issueNumber, token)
  const handoff = await lastHandoff(deps.db, taskId)
  const rounds = roundsOfRun(await reviewsOf(deps.db, taskId), handoff.attempts)
  return scopeMessage({
    repo: row.repository,
    issueNumber: row.issueNumber,
    title: issue.title,
    body: issue.body,
    plan: await latestPlan(deps.db, taskId),
    reviews: rounds.reviews,
    findings: handoff.findings,
    roundsNote: roundsNote(handoff.attempts, rounds.counts),
  })
}

/** How much of an answer that did not parse is kept for a person. */
const ANSWER_MAX = 4_000

/**
 * Fills a `scope` decision with its draft. An answer that does not parse is an `escalate` with the parse
 * error; a read or a model call that throws is kept as the decision's `failure`, so the pass goes on and the
 * row says what happened. Any other decision passes through unchanged.
 */
export async function draftScope(
  deps: DraftDeps,
  exception: TaskException,
  decision: Decision,
): Promise<Decision> {
  if (decision.action !== 'scope') return decision
  let answer: { response: string; cost: number }
  try {
    answer = await deps.drafter(await scopeMessageFor(deps, exception.taskId))
  } catch (error) {
    return { ...decision, failure: error instanceof Error ? error.message : String(error) }
  }
  const parsed = parseScopeDraft(answer.response)
  if (parsed.ok) return { ...decision, draft: parsed.draft, costUsd: answer.cost }
  return {
    action: 'escalate',
    reason: `${decision.reason}, but the drafter's answer could not be used: ${parsed.error}`,
    answer: answer.response.slice(0, ANSWER_MAX),
    costUsd: answer.cost,
  }
}
