import { describe, expect, it } from 'vitest'

import { approvalByReviewer, reworkByBuilder, type ReviewFact } from './by-agent'

const at = (hour: number) => new Date(Date.UTC(2026, 10, 13, hour))
const fact = (
  taskId: number,
  reviewer: string,
  verdict: ReviewFact['verdict'],
  hour: number,
): ReviewFact => ({ taskId, reviewer, verdict, at: at(hour) })

describe('approvalByReviewer', () => {
  it('gives one series for each agent that reviewed', () => {
    const result = approvalByReviewer(
      [
        fact(1, 'claude-code', 'approve', 1),
        fact(2, 'claude-code', 'changes', 2),
        fact(3, 'codex', 'approve', 3),
      ],
      new Map(),
    )
    expect(result).toEqual([
      { reviewer: 'claude-code', reviews: 2, approved: 1, share: 0.5 },
      { reviewer: 'codex', reviews: 1, approved: 1, share: 1 },
    ])
  })

  it('counts only the first review of a run, and counts a new run of the task again', () => {
    const intakes = new Map([[1, [at(0), at(10)]]])
    const result = approvalByReviewer(
      [
        fact(1, 'claude-code', 'changes', 1),
        fact(1, 'claude-code', 'approve', 2),
        fact(1, 'codex', 'approve', 11),
        fact(1, 'codex', 'changes', 12),
      ],
      intakes,
    )
    expect(result).toEqual([
      { reviewer: 'claude-code', reviews: 1, approved: 0, share: 0 },
      { reviewer: 'codex', reviews: 1, approved: 1, share: 1 },
    ])
  })

  it('says nothing when nobody reviewed', () => {
    expect(approvalByReviewer([], new Map())).toEqual([])
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
