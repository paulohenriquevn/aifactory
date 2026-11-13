import { asc, eq } from 'drizzle-orm'

import type { ReviewerApproval } from '../../shared/panel'
import type { Database } from '../db'
import { review, stageEvent } from '../db/schema'

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
