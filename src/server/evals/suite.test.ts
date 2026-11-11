import { describe, expect, it } from 'vitest'

import type { Baseline, CaseResult } from './compare'
import { E2B_USD_PER_MS, agentSetup, checkBeforeDeploy, runSuite, spentOn } from './suite'

describe('agentSetup', () => {
  it('names each agent with its model and effort, and default where nothing is set', () => {
    const setup = agentSetup({}, 'claude-code', 'codex', (_env, role) =>
      role === 'builder' ? { model: 'opus', effort: 'high' } : {},
    )

    expect(setup).toEqual({
      builder: 'claude-code',
      builderModel: 'opus',
      builderEffort: 'high',
      reviewer: 'codex',
      reviewerModel: 'default',
      reviewerEffort: 'default',
    })
  })
})

const result = (id: string, costUsd: number, durationMs = 0, passed = true): CaseResult => ({
  id,
  passed,
  reason: passed ? 'approved' : 'checks failed',
  costUsd,
  durationMs,
  attempts: 1,
  reviewRounds: 1,
})

describe('E2B_USD_PER_MS', () => {
  it('prices an hour of the factory sandbox at about 33 cents', () => {
    expect(E2B_USD_PER_MS * 3_600_000).toBeCloseTo(0.3312, 4)
  })
})

describe('spentOn', () => {
  it('adds the agents cost to the sandbox time at its price', () => {
    expect(spentOn([result('a', 1, 10_000), result('b', 0.5, 20_000)], 0.001)).toBeCloseTo(1.5 + 30)
  })
})

describe('runSuite', () => {
  it('runs every case, a few at a time, and answers the results in the order of the cases', async () => {
    let running = 0
    let most = 0
    const ran = await runSuite(
      ['a', 'b', 'c', 'd'],
      async (id) => {
        running++
        most = Math.max(most, running)
        await new Promise((r) => setTimeout(r, id === 'a' ? 20 : 1))
        running--
        return result(id, 0.1)
      },
      { budgetUsd: 10, concurrency: 2, sandboxUsdPerMs: 0 },
    )

    expect(ran.results.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(most).toBe(2)
    expect(ran.skipped).toEqual([])
  })

  it('starts no case once what was spent reaches the budget, and names the ones it left', async () => {
    const ran = await runSuite(['a', 'b', 'c'], async (id) => result(id, 1), {
      budgetUsd: 1,
      concurrency: 1,
      sandboxUsdPerMs: 0,
    })

    expect(ran.results.map((r) => r.id)).toEqual(['a'])
    expect(ran.skipped).toEqual(['b', 'c'])
  })
})

const baseline: Baseline = {
  commit: 'abc1234',
  ranAt: '2026-11-11T20:00:00.000Z',
  setup: { builder: 'claude-code', model: 'opus' },
  results: [result('a', 0.5), result('b', 0.5)],
}

describe('checkBeforeDeploy', () => {
  it('runs nothing when no file of the agent configuration changed and the setup is the same', async () => {
    let ran = false
    const checked = await checkBeforeDeploy({
      baseline,
      changedPaths: ['src/app/page.tsx'],
      setup: { builder: 'claude-code', model: 'opus' },
      runQuick: async () => {
        ran = true
        return []
      },
    })

    expect(checked).toEqual({ ran: false, ok: true, reasons: [], changed: [] })
    expect(ran).toBe(false)
  })

  it('runs the quick set when a prompt changed, and passes a run as good as the baseline', async () => {
    const checked = await checkBeforeDeploy({
      baseline,
      changedPaths: ['src/server/factory/review.ts'],
      setup: baseline.setup,
      runQuick: async () => [result('a', 0.5), result('b', 0.5)],
    })

    expect(checked).toMatchObject({
      ran: true,
      ok: true,
      changed: ['src/server/factory/review.ts'],
    })
  })

  it('counts a different model as a change, though no file changed', async () => {
    const checked = await checkBeforeDeploy({
      baseline,
      changedPaths: [],
      setup: { builder: 'claude-code', model: 'sonnet' },
      runQuick: async () => [result('a', 0.5), result('b', 0.5)],
    })

    expect(checked).toMatchObject({ ran: true, changed: ['model: opus -> sonnet'] })
  })

  it('names every setting that changed, in the order of their names', async () => {
    const checked = await checkBeforeDeploy({
      baseline: { ...baseline, setup: { reviewer: 'codex', builder: 'claude-code' } },
      changedPaths: [],
      setup: { reviewer: 'claude-code', builder: 'codex' },
      runQuick: async () => [result('a', 0.5), result('b', 0.5)],
    })

    expect(checked.changed).toEqual([
      'builder: claude-code -> codex',
      'reviewer: codex -> claude-code',
    ])
  })

  it('refuses a run worse than the baseline, with the reason', async () => {
    const checked = await checkBeforeDeploy({
      baseline,
      changedPaths: ['src/server/factory/harness.ts'],
      setup: baseline.setup,
      runQuick: async () => [result('a', 0.5, 0, false), result('b', 0.5, 0, false)],
    })

    expect(checked).toMatchObject({
      ran: true,
      ok: false,
      reasons: ['the pass rate fell from 100% to 0%'],
    })
  })
})
