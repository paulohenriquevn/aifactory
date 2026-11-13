import { asc, eq, inArray, sql } from 'drizzle-orm'

import type {
  AgentComparison,
  AgentDeliveryCost,
  BuilderRework,
  ReviewerApproval,
} from '../../shared/panel'
import type { Database } from '../db'
import { agentRun, review, stageEvent } from '../db/schema'

export type ReviewFact = {
  taskId: number
  reviewer: string
  verdict: 'approve' | 'changes' | 'invalid'
  at: Date
}

/**
 * First-review approval for each agent that reviewed. A run starts at each intake of its task, and the first
 * review made while it lasts is the one counted, the same reading `history.ts` gives the factory-wide
 * indicator. A task with no intake on record is one run. Reviewers come ordered by name.
 */
export function approvalByReviewer(
  reviews: ReviewFact[],
  intakes: Map<number, Date[]>,
): ReviewerApproval[] {
  const firsts = new Map<string, ReviewFact>()
  for (const r of reviews) {
    const starts = (intakes.get(r.taskId) ?? []).filter((at) => at <= r.at)
    const run = `${r.taskId} ${starts.length === 0 ? 0 : Math.max(...starts.map((s) => s.getTime()))}`
    const seen = firsts.get(run)
    if (!seen || r.at < seen.at) firsts.set(run, r)
  }
  const totals = new Map<string, { reviews: number; approved: number }>()
  for (const r of firsts.values()) {
    const t = totals.get(r.reviewer) ?? { reviews: 0, approved: 0 }
    t.reviews += 1
    if (r.verdict === 'approve') t.approved += 1
    totals.set(r.reviewer, t)
  }
  return [...totals.entries()]
    .map(([reviewer, t]) => ({ reviewer, ...t, share: t.approved / t.reviews }))
    .sort((a, b) => a.reviewer.localeCompare(b.reviewer))
}

/** What the database says: one series for each reviewer that has reviewed. */
export async function reviewerApproval(db: Database): Promise<ReviewerApproval[]> {
  const [reviews, intakes] = await Promise.all([
    db
      .select({
        taskId: review.taskId,
        reviewer: review.reviewer,
        verdict: review.verdict,
        at: review.at,
      })
      .from(review)
      .orderBy(asc(review.id)),
    db
      .select({ taskId: stageEvent.taskId, at: stageEvent.at })
      .from(stageEvent)
      .where(eq(stageEvent.stage, 'intake')),
  ])
  const byTask = new Map<number, Date[]>()
  for (const i of intakes) byTask.set(i.taskId, [...(byTask.get(i.taskId) ?? []), i.at])
  return approvalByReviewer(reviews, byTask)
}

/** A build event, as the rework count reads it. */
export type BuildFact = { harness: string; detail: Record<string, unknown> | null }

/**
 * Rework rounds for each builder: a build that is a rework is a round, and a build that is none of rework,
 * an answer that resumed a run or a refuted verdict is the start of a run. Builders come ordered by name.
 */
export function reworkByBuilder(builds: BuildFact[]): BuilderRework[] {
  const totals = new Map<string, { runs: number; reworkRounds: number }>()
  for (const b of builds) {
    const t = totals.get(b.harness) ?? { runs: 0, reworkRounds: 0 }
    if (b.detail?.rework === true) t.reworkRounds += 1
    else if (b.detail?.resumed !== true && b.detail?.refuted !== true) t.runs += 1
    totals.set(b.harness, t)
  }
  return [...totals.entries()]
    .filter(([, t]) => t.runs > 0)
    .map(([builder, t]) => ({ builder, ...t, perRun: t.reworkRounds / t.runs }))
    .sort((a, b) => a.builder.localeCompare(b.builder))
}

async function reworkOf(db: Database): Promise<BuilderRework[]> {
  const events = await db
    .select({ detail: stageEvent.detail })
    .from(stageEvent)
    .where(eq(stageEvent.stage, 'build'))
  const builds = events.flatMap((e) => {
    const detail = (e.detail ?? null) as Record<string, unknown> | null
    return typeof detail?.harness === 'string' ? [{ harness: detail.harness, detail }] : []
  })
  return reworkByBuilder(builds)
}

/** The cost of the passes of each agent and model in the tasks that were delivered, per delivered task. */
async function costOf(db: Database): Promise<AgentDeliveryCost[]> {
  const delivered = db
    .select({ id: stageEvent.taskId })
    .from(stageEvent)
    .where(eq(stageEvent.stage, 'done'))
  const rows = await db
    .select({
      agent: agentRun.harness,
      model: agentRun.model,
      deliveredRuns: sql<number>`count(distinct ${agentRun.taskId})`.mapWith(Number),
      costUsd: sql<number>`coalesce(sum(${agentRun.costUsd}), 0)`.mapWith(Number),
    })
    .from(agentRun)
    .where(inArray(agentRun.taskId, delivered))
    .groupBy(agentRun.harness, agentRun.model)
    .orderBy(agentRun.harness, agentRun.model)
  return rows.map((r) => ({ ...r, perDelivery: r.costUsd / r.deliveredRuns }))
}

/** Approval, rework and cost, each split by agent. */
export async function comparisonByAgent(db: Database): Promise<AgentComparison> {
  const [approval, rework, cost] = await Promise.all([
    reviewerApproval(db),
    reworkOf(db),
    costOf(db),
  ])
  return { approval, rework, cost }
}
