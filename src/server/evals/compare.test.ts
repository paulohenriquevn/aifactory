import { describe, expect, it } from 'vitest'

import {
  THRESHOLDS,
  failedForEnvironment,
  regressionPValue,
  caseOutcome,
  compareWithBaseline,
  summarize,
  type Baseline,
  type CaseResult,
} from './compare'

const result = (id: string, passed: boolean, costUsd = 0.5, durationMs = 600_000): CaseResult => ({
  id,
  passed,
  reason: passed ? 'approved' : 'checks failed',
  costUsd,
  durationMs,
  attempts: 1,
  reviewRounds: 1,
})

const baseline = (results: CaseResult[]): Baseline => ({
  commit: 'abc1234',
  ranAt: '2026-11-11T20:00:00.000Z',
  setup: { builder: 'claude-code' },
  results,
})

describe('summarize', () => {
  it('counts the cases that passed and averages cost and duration', () => {
    const summary = summarize([result('a', true, 1, 100), result('b', false, 3, 300)])

    expect(summary).toEqual({
      cases: 2,
      passed: 1,
      passRate: 0.5,
      meanCostUsd: 2,
      meanDurationMs: 200,
    })
  })

  it('answers zero for an empty run instead of dividing by zero', () => {
    expect(summarize([])).toEqual({
      cases: 0,
      passed: 0,
      passRate: 0,
      meanCostUsd: 0,
      meanDurationMs: 0,
    })
  })
})

describe('compareWithBaseline', () => {
  const before = baseline([
    result('a', true),
    result('b', true),
    result('c', true),
    result('d', true),
    result('e', false),
  ])

  it('accepts a run that passes the same cases at the same cost', () => {
    const run = before.results.map((r) => ({ ...r }))

    const compared = compareWithBaseline(run, before)

    expect(compared.ok).toBe(true)
    expect(compared.reasons).toEqual([])
    expect(compared.regressions).toEqual([])
  })

  it('accepts one case that stopped passing, which a model can do by chance', () => {
    const run = [
      result('a', false),
      result('b', true),
      result('c', true),
      result('d', true),
      result('e', false),
    ]

    const compared = compareWithBaseline(run, before)

    expect(compared.ok).toBe(true)
    expect(compared.regressions).toEqual(['a'])
  })

  it('refuses a pass rate that dropped by more than the threshold', () => {
    const run = [
      result('a', false),
      result('b', false),
      result('c', true),
      result('d', true),
      result('e', false),
    ]

    const compared = compareWithBaseline(run, before)

    expect(compared.ok).toBe(false)
    expect(compared.regressions).toEqual(['a', 'b'])
    expect(compared.reasons).toEqual(['the pass rate fell from 80% to 40%'])
  })

  it('accepts a mean cost exactly at the threshold and refuses one above it', () => {
    const at = before.results.map((r) => ({ ...r, costUsd: 0.5 * (1 + THRESHOLDS.costRise) }))
    const above = before.results.map((r) => ({
      ...r,
      costUsd: 0.5 * (1 + THRESHOLDS.costRise) + 0.01,
    }))

    expect(compareWithBaseline(at, before).ok).toBe(true)
    const refused = compareWithBaseline(above, before)
    expect(refused.ok).toBe(false)
    expect(refused.reasons).toEqual(['the mean cost per case rose from US$ 0.50 to US$ 1.01'])
  })

  it('accepts a run that costs more for the same pass rate, as the owner prefers cost to slowness', () => {
    // 2026-11-19: the review-convergence change failed the gate at US$ 0.37 -> 0.58 (one case took a second
    // review round, which that case does in about half of its runs) with the same 4 of 5 passing. The owner
    // decided that a higher cost is better than a slower factory; only a cost out of control still refuses.
    const pricier = before.results.map((r) => ({ ...r, costUsd: 0.5 * 1.57 }))

    expect(compareWithBaseline(pricier, before).ok).toBe(true)
  })

  it('still refuses a mean cost more than twice the baseline', () => {
    const runaway = before.results.map((r) => ({ ...r, costUsd: 0.5 * 2 + 0.01 }))

    expect(compareWithBaseline(runaway, before).reasons).toEqual([
      'the mean cost per case rose from US$ 0.50 to US$ 1.01',
    ])
  })

  it('does not judge cost against a baseline that cost nothing', () => {
    const free = baseline([result('a', true, 0)])

    expect(compareWithBaseline([result('a', true, 5)], free).ok).toBe(true)
  })

  it('compares only the cases both runs have', () => {
    const run = [result('a', true), result('z', false), result('y', false)]

    const compared = compareWithBaseline(run, before)

    expect(compared.ok).toBe(true)
    expect(compared.now.cases).toBe(1)
    expect(compared.before.cases).toBe(1)
  })

  it('refuses a run with no case in common with the baseline', () => {
    const compared = compareWithBaseline([result('z', true)], before)

    expect(compared.ok).toBe(false)
    expect(compared.reasons).toEqual(['no case of this run is in the baseline'])
  })

  it('reports both reasons when the pass rate and the cost got worse together', () => {
    const run = before.results.map((r) => ({ ...r, passed: false, costUsd: 2 }))

    expect(compareWithBaseline(run, before).reasons).toHaveLength(2)
  })
})

describe('caseOutcome', () => {
  it('passes a case whose checks passed and whose review approved', () => {
    expect(caseOutcome({ checksPassed: true, verdict: 'approve', blockingGuards: [] })).toEqual({
      passed: true,
      reason: 'approved',
    })
  })

  it('fails a case whose checks failed, whatever the review said', () => {
    expect(
      caseOutcome({
        checksPassed: false,
        verdict: 'approve',
        blockingGuards: [],
        failedChecks: ['tests'],
      }),
    ).toEqual({ passed: false, reason: 'checks failed: tests' })
  })

  it('fails a case whose reviewer gave no verdict it could read', () => {
    expect(caseOutcome({ checksPassed: true, verdict: 'invalid', blockingGuards: [] })).toEqual({
      passed: false,
      reason: 'the reviewer gave no verdict',
    })
  })

  it('fails a case the reviewer did not approve', () => {
    expect(caseOutcome({ checksPassed: true, verdict: 'changes', blockingGuards: [] })).toEqual({
      passed: false,
      reason: 'the reviewer asked for changes',
    })
  })

  it('fails a case whose diff broke a rule the factory checks without a model, even when approved', () => {
    expect(
      caseOutcome({
        checksPassed: true,
        verdict: 'approve',
        blockingGuards: ['the test command changed'],
      }),
    ).toEqual({ passed: false, reason: 'outside the rules: the test command changed' })
  })

  it('fails a case that ended before a verdict, with what stopped it', () => {
    expect(caseOutcome({ stopped: 'the agent asked a question' })).toEqual({
      passed: false,
      reason: 'the agent asked a question',
    })
  })
})

describe('environment failures and paired cases', () => {
  const failedFor = (id: string, reason: string): CaseResult => ({ ...result(id, false), reason })
  const many = (prefix: string, count: number, passed: boolean) =>
    Array.from({ length: count }, (_, i) => result(`${prefix}${i}`, passed))

  it('tells a case the environment failed from one the agents failed', () => {
    expect(failedForEnvironment(failedFor('a', '403: team is blocked: spend_limit'))).toBe(true)
    expect(failedForEnvironment(failedFor('a', 'the agent made no change'))).toBe(false)
    expect(failedForEnvironment(result('a', true))).toBe(false)
  })

  it('leaves out of the comparison a case the environment failed, and names it', () => {
    const before = baseline([result('a', true), result('b', true), ...many('x', 8, true)])
    const run = [result('a', true), failedFor('b', 'fetch failed'), ...many('x', 8, true)]

    const compared = compareWithBaseline(run, before)

    expect(compared.unmeasured).toEqual(['b'])
    expect(compared.regressions).toEqual([])
    expect(compared.now.cases).toBe(9)
    expect(compared.ok).toBe(true)
  })

  it('refuses a run where the environment failed more than one case in five, since it measured too little', () => {
    const before = baseline([...many('x', 4, true), result('a', true), result('b', true)])
    const run = [...many('x', 4, true), failedFor('a', 'fetch failed'), failedFor('b', 'ETIMEDOUT')]

    const compared = compareWithBaseline(run, before)

    expect(compared.ok).toBe(false)
    expect(compared.reasons).toContain(
      'the environment failed 2 of 6 cases (a, b), so the run measured too little',
    )
  })

  it('counts the cases that got better as well as the ones that got worse', () => {
    const before = baseline([result('a', true), result('b', false), result('c', false)])
    const run = [result('a', false), result('b', true), result('c', true)]

    const compared = compareWithBaseline(run, before)

    expect(compared.regressions).toEqual(['a'])
    expect(compared.improvements).toEqual(['b', 'c'])
  })

  it('refuses regressions that outnumber improvements past chance, under the pass-rate threshold too', () => {
    // 30 cases, 6 regressions and none better: a 20% drop, at the threshold, but p = 1/64.
    const before = baseline([...many('r', 6, true), ...many('x', 24, true)])
    const run = [...many('r', 6, false), ...many('x', 24, true)]

    const compared = compareWithBaseline(run, before)

    expect(compared.pValue).toBeCloseTo(1 / 64, 6)
    expect(compared.ok).toBe(false)
    expect(compared.reasons).toContain(
      '6 cases got worse and 0 got better, more than chance explains (p = 0.016)',
    )
  })

  it('does not call two regressions against one improvement a change', () => {
    const before = baseline([result('a', true), result('b', true), result('c', false), ...many('x', 7, true)])
    const run = [result('a', false), result('b', false), result('c', true), ...many('x', 7, true)]

    const compared = compareWithBaseline(run, before)

    expect(compared.pValue).toBeCloseTo(0.5, 6)
    expect(compared.ok).toBe(true)
  })
})

describe('regressionPValue', () => {
  it('is the chance of at least that many regressions among the changed cases, if a change were a coin', () => {
    expect(regressionPValue(0, 0)).toBe(1)
    expect(regressionPValue(1, 0)).toBeCloseTo(0.5, 9)
    expect(regressionPValue(3, 1)).toBeCloseTo(5 / 16, 9)
    expect(regressionPValue(0, 4)).toBe(1)
  })
})
