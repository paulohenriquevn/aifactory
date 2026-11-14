import { describe, expect, it } from 'vitest'

import type { TaskStage } from '../db/schema'

import {
  approvalByReviewer,
  costByAgent,
  reworkByBuilder,
  reworkByReviewer,
  type EventsByTask,
  type PassFact,
  type ReviewFact,
} from './by-agent'

const at = (hour: number) => new Date(Date.UTC(2026, 10, 13, hour))
const fact = (
  taskId: number,
  reviewer: string,
  verdict: ReviewFact['verdict'],
  hour: number,
  round = 1,
  model: string | null = null,
): ReviewFact => ({ taskId, reviewer, model, round, verdict, at: at(hour) })
const event = (stage: TaskStage, hour: number, detail: Record<string, unknown> | null = null) => ({
  stage,
  at: at(hour),
  detail,
})
/** A run from `from` that ends in `stage` an hour and a half later. */
const finished = (from: number, stage: TaskStage = 'done') => [
  event('intake', from),
  event(stage, from + 2),
]
const events = (...tasks: [number, ReturnType<typeof event>[]][]): EventsByTask => new Map(tasks)

describe('approvalByReviewer', () => {
  it('gives one series for each agent that reviewed', () => {
    const result = approvalByReviewer(
      [
        fact(1, 'claude-code', 'approve', 1),
        fact(2, 'claude-code', 'changes', 1),
        fact(3, 'codex', 'approve', 1),
      ],
      events([1, finished(0)], [2, finished(0)], [3, finished(0)]),
    )
    expect(result).toEqual([
      { reviewer: 'claude-code', model: null, reviews: 2, approved: 1, share: 0.5 },
      { reviewer: 'codex', model: null, reviews: 1, approved: 1, share: 1 },
    ])
  })

  it('counts only the first review of a run, and counts a new run of the task again', () => {
    const result = approvalByReviewer(
      [
        fact(1, 'claude-code', 'changes', 1),
        fact(1, 'claude-code', 'approve', 2),
        fact(1, 'codex', 'approve', 11),
        fact(1, 'codex', 'changes', 12),
      ],
      events([1, [...finished(0, 'failed'), ...finished(10)]]),
    )
    expect(result).toEqual([
      { reviewer: 'claude-code', model: null, reviews: 1, approved: 0, share: 0 },
      { reviewer: 'codex', model: null, reviews: 1, approved: 1, share: 1 },
    ])
  })

  it('leaves out a run still going, and one that only waited for another issue', () => {
    const result = approvalByReviewer(
      [
        fact(1, 'codex', 'approve', 1),
        fact(2, 'codex', 'approve', 1),
        fact(3, 'codex', 'changes', 1),
      ],
      events(
        [1, [event('intake', 0), event('review', 1)]],
        [2, [event('intake', 0), event('handoff', 2, { blockedBy: [7] })]],
        [3, [event('intake', 0), event('done', 2, null)]],
      ),
    )
    expect(result).toEqual([{ reviewer: 'codex', model: null, reviews: 1, approved: 0, share: 0 }])
  })

  it('says nothing when nobody reviewed', () => {
    expect(approvalByReviewer([], new Map())).toEqual([])
  })
})

const pass = (
  taskId: number,
  harness: string,
  costUsd: number | null,
  hour: number,
  model: string | null = 'default',
): PassFact => ({ taskId, harness, model, costUsd, at: at(hour) })

describe('costByAgent', () => {
  it('charges a delivered run only with the passes made while it lasted', () => {
    const result = costByAgent(
      [pass(1, 'claude-code', 5, 1), pass(1, 'claude-code', 1, 11), pass(1, 'claude-code', 2, 12)],
      events([1, [...finished(0, 'failed'), ...finished(10)]]),
    )
    expect(result).toEqual([
      {
        agent: 'claude-code',
        model: 'default',
        deliveredRuns: 1,
        reportedRuns: 1,
        costUsd: 3,
        perDelivery: 3,
      },
    ])
  })

  it('keeps a cost nobody reported unknown instead of adding zero', () => {
    const result = costByAgent(
      [pass(1, 'codex', null, 1), pass(2, 'codex', 4, 1), pass(3, 'codex', null, 1, 'gpt-6.1-sol')],
      events([1, finished(0)], [2, finished(0)], [3, finished(0)]),
    )
    expect(result).toEqual([
      {
        agent: 'codex',
        model: 'default',
        deliveredRuns: 2,
        reportedRuns: 1,
        costUsd: 4,
        perDelivery: 4,
      },
      {
        agent: 'codex',
        model: 'gpt-6.1-sol',
        deliveredRuns: 1,
        reportedRuns: 0,
        costUsd: 0,
        perDelivery: null,
      },
    ])
  })

  it('counts no run that did not reach done, or is still going', () => {
    const result = costByAgent(
      [pass(1, 'codex', 1, 1), pass(2, 'codex', 1, 1)],
      events([1, finished(0, 'handoff')], [2, [event('intake', 0)]]),
    )
    expect(result).toEqual([])
  })
})

describe('reworkByBuilder', () => {
  it('counts the rework rounds of each builder against its runs, not an answer that resumed a run', () => {
    const build = (harness: string, detail: Record<string, unknown> | null = null) => ({
      harness,
      detail,
    })
    expect(
      reworkByBuilder([
        build('claude-code'),
        build('claude-code', { rework: true }),
        build('claude-code', { rework: true }),
        build('claude-code', { resumed: true }),
        build('codex'),
        build('codex', { refuted: true }),
      ]),
    ).toEqual([
      { builder: 'claude-code', runs: 1, reworkRounds: 2, perRun: 2 },
      { builder: 'codex', runs: 1, reworkRounds: 0, perRun: 0 },
    ])
  })
})

describe('approval by reviewer and model', () => {
  it('gives a series for each model of the same agent', () => {
    const result = approvalByReviewer(
      [
        fact(1, 'codex', 'changes', 1, 1, 'gpt-6.1-sol'),
        fact(2, 'codex', 'approve', 1, 1, 'gpt-6.1-terra'),
      ],
      events([1, finished(0)], [2, finished(0)]),
    )
    expect(result).toEqual([
      { reviewer: 'codex', model: 'gpt-6.1-sol', reviews: 1, approved: 0, share: 0 },
      { reviewer: 'codex', model: 'gpt-6.1-terra', reviews: 1, approved: 1, share: 1 },
    ])
  })
})

describe('reworkByReviewer', () => {
  const rework = (taskId: number, attempt: number, hour: number) => ({
    taskId,
    attempt,
    at: at(hour),
  })

  it('charges a rework to the reviewer whose changes it answered, whoever builds', () => {
    const reviews = [
      fact(1, 'claude-code', 'changes', 1),
      fact(1, 'claude-code', 'approve', 3, 2),
      fact(2, 'codex', 'changes', 1),
      fact(2, 'codex', 'changes', 3, 2),
      fact(2, 'codex', 'approve', 5, 3),
    ]
    const rounds = [rework(1, 2, 2), rework(2, 2, 2), rework(2, 3, 4)]
    expect(reworkByReviewer(reviews, rounds, events([1, finished(0)], [2, finished(0)]))).toEqual([
      { reviewer: 'claude-code', model: null, reviews: 2, reworkRounds: 1, perReview: 0.5 },
      { reviewer: 'codex', model: null, reviews: 3, reworkRounds: 2, perReview: 2 / 3 },
    ])
  })

  it('charges nobody for a rework that failing checks started, or an approved review', () => {
    // Attempt 1 was approved and its pull request later failed; attempt 2 is a check-driven rework with no review.
    const reviews = [fact(1, 'codex', 'approve', 1), fact(2, 'codex', 'changes', 1)]
    const rounds = [rework(1, 2, 2), rework(2, 3, 2)]
    expect(reworkByReviewer(reviews, rounds, events([1, finished(0)], [2, finished(0)]))).toEqual([
      { reviewer: 'codex', model: null, reviews: 2, reworkRounds: 0, perReview: 0 },
    ])
  })

  it('does not charge a rework of a later run to a review of an earlier run', () => {
    const reviews = [fact(1, 'codex', 'changes', 1)]
    const run = events([1, [...finished(0, 'failed'), ...finished(10)]])
    expect(reworkByReviewer(reviews, [rework(1, 2, 11)], run)[0].reworkRounds).toBe(0)
  })

  it('splits the rounds by model of the same agent', () => {
    const reviews = [
      fact(1, 'codex', 'changes', 1, 1, 'gpt-6.1-sol'),
      fact(2, 'codex', 'approve', 1, 1, 'gpt-6.1-terra'),
    ]
    expect(
      reworkByReviewer(reviews, [rework(1, 2, 2)], events([1, finished(0)], [2, finished(0)])),
    ).toEqual([
      { reviewer: 'codex', model: 'gpt-6.1-sol', reviews: 1, reworkRounds: 1, perReview: 1 },
      { reviewer: 'codex', model: 'gpt-6.1-terra', reviews: 1, reworkRounds: 0, perReview: 0 },
    ])
  })
})
