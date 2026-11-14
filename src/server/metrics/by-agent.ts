import { asc, eq } from 'drizzle-orm'

import type {
  AgentComparison,
  AgentDeliveryCost,
  BuilderRework,
  ReviewerApproval,
  ReviewerRework,
} from '../../shared/panel'
import type { Database } from '../db'
import { agentRun, review, stageEvent } from '../db/schema'

import { inRun, runsOf, terminalOf, type HistoryEvent } from './history'

export type ReviewFact = {
  taskId: number
  reviewer: string
  verdict: 'approve' | 'changes' | 'invalid'
  at: Date
}

/** The events of each task, in the order they happened. */
export type EventsByTask = Map<number, HistoryEvent[]>

/**
 * First-review approval for each agent that reviewed. It reads what the factory-wide indicator reads
 * (`history.ts`): a run is what starts at an intake, only a finished run counts (one still going, or one
 * that only waited for another issue, does not), and the first review made while it lasted is the one
 * counted. Reviewers come ordered by name.
 */
export function approvalByReviewer(
  reviews: ReviewFact[],
  events: EventsByTask,
): ReviewerApproval[] {
  const totals = new Map<string, { reviews: number; approved: number }>()
  for (const [taskId, taskEvents] of events) {
    const mine = reviews.filter((r) => r.taskId === taskId)
    for (const run of runsOf(taskEvents)) {
      if (!terminalOf(run)) continue
      const first = mine.find((r) => inRun(run, r.at))
      if (!first) continue
      const t = totals.get(first.reviewer) ?? { reviews: 0, approved: 0 }
      t.reviews += 1
      if (first.verdict === 'approve') t.approved += 1
      totals.set(first.reviewer, t)
    }
  }
  return [...totals.entries()]
    .map(([reviewer, t]) => ({ reviewer, ...t, share: t.approved / t.reviews }))
    .sort((a, b) => a.reviewer.localeCompare(b.reviewer))
}

/** One agent pass, as the cost reads it. A null cost is one the agent did not report. */
export type PassFact = {
  taskId: number
  harness: string
  model: string | null
  costUsd: number | null
  at: Date
}

/**
 * What a delivered run cost with each agent and model in it. A delivered run is a finished run that reached
 * `done`, and its passes are the ones made while it lasted, so a failed earlier run of the same task is not
 * charged to it. A run whose agent left any pass without a cost has an unknown cost: it is counted in
 * `deliveredRuns` and left out of `reportedRuns` and `costUsd`, never added as zero. `perDelivery` is null
 * when no run reported.
 */
export function costByAgent(passes: PassFact[], events: EventsByTask): AgentDeliveryCost[] {
  const groups = new Map<string, AgentDeliveryCost>()
  for (const [taskId, taskEvents] of events) {
    const mine = passes.filter((p) => p.taskId === taskId)
    for (const run of runsOf(taskEvents)) {
      if (!terminalOf(run) || !run.events.some((e) => e.stage === 'done')) continue
      const byAgent = new Map<string, PassFact[]>()
      for (const p of mine.filter((p) => inRun(run, p.at))) {
        const key = JSON.stringify([p.harness, p.model])
        byAgent.set(key, [...(byAgent.get(key) ?? []), p])
      }
      for (const [key, made] of byAgent) {
        const [agent, model] = JSON.parse(key) as [string, string | null]
        const g = groups.get(key) ?? {
          agent,
          model,
          deliveredRuns: 0,
          reportedRuns: 0,
          costUsd: 0,
          perDelivery: null,
        }
        g.deliveredRuns += 1
        if (made.every((p) => p.costUsd !== null)) {
          g.reportedRuns += 1
          g.costUsd += made.reduce((sum, p) => sum + (p.costUsd ?? 0), 0)
        }
        groups.set(key, g)
      }
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, perDelivery: g.reportedRuns > 0 ? g.costUsd / g.reportedRuns : null }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || (a.model ?? '').localeCompare(b.model ?? ''))
}

async function eventsOf(db: Database): Promise<EventsByTask> {
  const rows = await db
    .select({
      taskId: stageEvent.taskId,
      stage: stageEvent.stage,
      at: stageEvent.at,
      detail: stageEvent.detail,
    })
    .from(stageEvent)
    .orderBy(asc(stageEvent.id))
  const byTask: EventsByTask = new Map()
  for (const e of rows) {
    const event = {
      stage: e.stage,
      at: e.at,
      detail: (e.detail ?? null) as Record<string, unknown> | null,
    }
    byTask.set(e.taskId, [...(byTask.get(e.taskId) ?? []), event])
  }
  return byTask
}

async function reviewsOf(db: Database): Promise<ReviewFact[]> {
  return db
    .select({
      taskId: review.taskId,
      reviewer: review.reviewer,
      verdict: review.verdict,
      at: review.at,
    })
    .from(review)
    .orderBy(asc(review.id))
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

/** A rework build, as the reviewer's rework count reads it. */
export type ReworkFact = { taskId: number; at: Date }

/**
 * The rework rounds each reviewer's verdicts caused: a rework build is charged to the reviewer of the latest
 * review of the same task made before it, whatever agent builds. A rework with no review before it (a person
 * sent the work back) is charged to nobody. `perReview` is rounds over the reviews that reviewer made.
 * Reviewers come ordered by name.
 */
export function reworkByReviewer(reviews: ReviewFact[], rework: ReworkFact[]): ReviewerRework[] {
  const totals = new Map<string, { reviews: number; reworkRounds: number }>()
  const of = (name: string) => {
    const t = totals.get(name) ?? { reviews: 0, reworkRounds: 0 }
    totals.set(name, t)
    return t
  }
  for (const r of reviews) of(r.reviewer).reviews += 1
  for (const round of rework) {
    const before = reviews
      .filter((r) => r.taskId === round.taskId && r.at.getTime() <= round.at.getTime())
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .at(-1)
    if (before) of(before.reviewer).reworkRounds += 1
  }
  return [...totals.entries()]
    .map(([reviewer, t]) => ({ reviewer, ...t, perReview: t.reworkRounds / t.reviews }))
    .sort((a, b) => a.reviewer.localeCompare(b.reviewer))
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

async function reworkRoundsOf(db: Database): Promise<ReworkFact[]> {
  const events = await db
    .select({ taskId: stageEvent.taskId, at: stageEvent.at, detail: stageEvent.detail })
    .from(stageEvent)
    .where(eq(stageEvent.stage, 'build'))
    .orderBy(asc(stageEvent.id))
  return events
    .filter((e) => (e.detail as Record<string, unknown> | null)?.rework === true)
    .map((e) => ({ taskId: e.taskId, at: e.at }))
}

/** Approval, rework and cost, each split by agent. */
export async function comparisonByAgent(db: Database): Promise<AgentComparison> {
  const [events, reviews, passes, rework, rounds] = await Promise.all([
    eventsOf(db),
    reviewsOf(db),
    db
      .select({
        taskId: agentRun.taskId,
        harness: agentRun.harness,
        model: agentRun.model,
        costUsd: agentRun.costUsd,
        at: agentRun.at,
      })
      .from(agentRun)
      .orderBy(asc(agentRun.id)),
    reworkOf(db),
    reworkRoundsOf(db),
  ])
  return {
    approval: approvalByReviewer(reviews, events),
    rework,
    reviewerRework: reworkByReviewer(reviews, rounds),
    cost: costByAgent(passes, events),
  }
}
