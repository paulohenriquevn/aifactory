import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Baseline, CaseResult } from './compare'
import {
  DEFAULT_START_MARGIN_MS,
  E2B_USD_PER_MS,
  agentSetup,
  checkBeforeDeploy,
  checkFromTestStart,
  fromTestStart,
  runSuite,
  writeRunOutcome,
  spentOn,
  parseMarginMinutes,
  startMarginFor,
  runSuiteFromTestStart,
  SUITE_TIMEOUT_MS,
} from './suite'

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

describe('agentSetup with a planner apart from the builder', () => {
  it('names the planner with its own model and effort', () => {
    const setup = agentSetup(
      {},
      'claude-code',
      'codex',
      (_env, role) => (role === 'planner' ? { model: 'gpt-6.1-terra', effort: 'high' } : {}),
      'codex',
    )

    expect(setup).toMatchObject({
      planner: 'codex',
      plannerModel: 'gpt-6.1-terra',
      plannerEffort: 'high',
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

  it('runs again, once, a case the environment failed, and keeps the second result', async () => {
    const calls: string[] = []
    const ran = await runSuite(
      ['a', 'b'],
      async (id) => {
        calls.push(id)
        const first = calls.filter((c) => c === id).length === 1
        return id === 'a' && first
          ? { ...result(id, 0.2), passed: false, reason: 'fetch failed' }
          : result(id, 0.1)
      },
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0 },
    )

    expect(calls).toEqual(['a', 'a', 'b'])
    expect(ran.results.map((r) => [r.id, r.passed])).toEqual([['a', true], ['b', true]])
  })

  it('does not run again a case the agents failed', async () => {
    const calls: string[] = []
    await runSuite(
      ['a'],
      async (id) => {
        calls.push(id)
        return { ...result(id, 0.1), passed: false, reason: 'the agent made no change' }
      },
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0 },
    )

    expect(calls).toEqual(['a'])
  })

  it('counts what the first, failed run of a case cost against the budget', async () => {
    const ran = await runSuite(
      ['a', 'b'],
      async (id) => ({ ...result(id, 0.6), passed: false, reason: 'ETIMEDOUT' }),
      { budgetUsd: 1, concurrency: 1, sandboxUsdPerMs: 0 },
    )

    expect(ran.skipped).toEqual(['b'])
  })
})

describe('startMarginFor', () => {
  it('keeps the longest case limit and time to write, so a case started at the cutoff ends in time', () => {
    expect(startMarginFor([90 * 60_000, 150 * 60_000])).toBe(160 * 60_000)
    expect(startMarginFor([])).toBe(DEFAULT_START_MARGIN_MS)
    expect(DEFAULT_START_MARGIN_MS).toBeGreaterThan(90 * 60_000)
  })
})

describe('parseMarginMinutes', () => {
  it('reads minutes and refuses what would switch the time limit off', () => {
    expect(parseMarginMinutes('90')).toBe(90 * 60_000)
    expect(parseMarginMinutes('0')).toBe(0)
    for (const bad of ['abc', '', '-5', 'Infinity']) expect(() => parseMarginMinutes(bad)).toThrow()
  })
})

describe('runSuite time limit', () => {
  const MIN = 60_000
  it('starts no case once the time left is below the margin, and names the ones it left', async () => {
    let clock = 0
    const ran = await runSuite(
      ['a', 'b', 'c'],
      async (id) => {
        clock += 50 * MIN
        return result(id, 0)
      },
      {
        budgetUsd: 10,
        concurrency: 1,
        sandboxUsdPerMs: 0,
        deadlineMs: 120 * MIN,
        startMarginMs: 30 * MIN,
        now: () => clock,
      },
    )

    // a starts at 0, b at 50 (70 left), c at 100 (20 left, below 30)
    expect(ran.results.map((r) => r.id)).toEqual(['a', 'b'])
    expect(ran.skipped).toEqual(['c'])
  })

  it('returns when an in-flight case hangs past the abandon time, naming it and the ones never started', async () => {
    const ran = await runSuite(
      ['a', 'b', 'c'],
      async (id) => (id === 'b' ? new Promise<never>(() => {}) : result(id, 0)),
      {
        budgetUsd: 10,
        concurrency: 1,
        sandboxUsdPerMs: 0,
        abandonAtMs: Date.now() + 30,
      },
    )
    expect(ran.results.map((r) => r.id)).toEqual(['a'])
    expect(ran.skipped).toEqual(['b', 'c'])
  })

  it('aborts the signal of the cases in flight when it gives up on them', async () => {
    let aborted = false
    const ran = await runSuite(
      ['a'],
      (_id, signal) =>
        new Promise<never>(() => {
          signal.addEventListener('abort', () => (aborted = true))
        }),
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0, abandonAtMs: Date.now() + 20 },
    )
    expect(aborted).toBe(true)
    expect(ran.skipped).toEqual(['a'])
  })

  it('counts the time the setup took before the first case: a late-starting run starts no case', async () => {
    const MIN = 60_000
    // The test started 4 hours less 20 minutes ago (setup took that long); the margin is 30 minutes.
    const testStartedAt = Date.now() - (SUITE_TIMEOUT_MS - 20 * MIN)
    const started: string[] = []
    const ran = await runSuiteFromTestStart(
      testStartedAt,
      ['a', 'b'],
      async (id) => {
        started.push(id)
        return result(id, 0)
      },
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0, startMarginMs: 30 * MIN },
    )
    expect(started).toEqual([])
    expect(ran.skipped).toEqual(['a', 'b'])
  })

  it('returns, naming every case, when the setup that reads the margin hangs past the abandon time', async () => {
    const testStartedAt = Date.now() - (SUITE_TIMEOUT_MS - 5 * 60_000 - 30)
    const ran = await runSuiteFromTestStart(
      testStartedAt,
      ['a', 'b'],
      async (id) => result(id, 0),
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0, startMarginMs: () => new Promise<never>(() => {}) },
    )
    expect(ran.results).toEqual([])
    expect(ran.skipped).toEqual(['a', 'b'])
  })

  it('abandons the cases in flight before the test time, counted from the test start', async () => {
    const testStartedAt = Date.now() - (SUITE_TIMEOUT_MS - 5 * 60_000 - 30)
    const ran = await runSuiteFromTestStart(
      testStartedAt,
      ['a'],
      () => new Promise<never>(() => {}),
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0, startMarginMs: 0 },
    )
    expect(ran.skipped).toEqual(['a'])
  })

  it('persists the cases left and the baseline refusal when a case hangs', async () => {
    const ids = ['a', 'b', 'c']
    const ran = await runSuite(
      ids,
      async (id) => (id === 'b' ? new Promise<never>(() => {}) : result(id, 0)),
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0, abandonAtMs: Date.now() + 30 },
    )
    const path = join(mkdtempSync(join(tmpdir(), 'suite-')), 'run.selected.json')
    writeRunOutcome(path, { startedAt: 't', baseline: true, selected: ids }, ran)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.selected).toEqual(ids)
    expect(saved.finished).toEqual(['a'])
    expect(saved.skipped).toEqual(['b', 'c'])
    expect(saved.baselineRefused).toContain('baseline.json not written')
    expect(saved.baselineRefused).toContain('b, c')
  })

  it('records no baseline refusal for a run that is not a baseline or left nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'suite-'))
    const full = { results: [result('a', 0)], skipped: [] }
    const base = { startedAt: 't', selected: ['a'] }
    expect(writeRunOutcome(join(dir, '1.json'), { ...base, baseline: true }, full).baselineRefused).toBeUndefined()
    expect(
      writeRunOutcome(join(dir, '2.json'), { ...base, baseline: false }, { results: [], skipped: ['a'] })
        .baselineRefused,
    ).toBeUndefined()
  })

  it('does not run again an environment failure inside the margin', async () => {
    let clock = 0
    const calls: string[] = []
    const ran = await runSuite(
      ['a'],
      async (id) => {
        calls.push(id)
        clock += 100 * MIN
        return { ...result(id, 0), passed: false, reason: 'fetch failed' }
      },
      {
        budgetUsd: 10,
        concurrency: 1,
        sandboxUsdPerMs: 0,
        deadlineMs: 120 * MIN,
        startMarginMs: 30 * MIN,
        now: () => clock,
      },
    )

    expect(calls).toEqual(['a'])
    expect(ran.results.map((r) => r.id)).toEqual(['a'])
  })

  it('has no time limit without a deadline', async () => {
    const ran = await runSuite(['a', 'b'], async (id) => result(id, 0), {
      budgetUsd: 10,
      concurrency: 1,
      sandboxUsdPerMs: 0,
      now: () => Number.MAX_SAFE_INTEGER,
    })

    expect(ran.skipped).toEqual([])
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

  it('refuses a partial quick run, naming the cases left, though the ones that ran are as good', async () => {
    const checked = await checkBeforeDeploy({
      baseline,
      changedPaths: ['src/server/factory/review.ts'],
      setup: baseline.setup,
      runQuick: async () => ({ results: [result('a', 0.5)], skipped: ['b'] }),
    })

    expect(checked.ok).toBe(false)
    expect(checked.reasons).toEqual(['the run left 1 quick case(s) unmeasured: b'])
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
      reasons: [
        'the pass rate fell from 100% to 0%',
        'no case ran to a verdict in both runs, so the cost could not be compared',
      ],
    })
  })
})

describe('checkFromTestStart', () => {
  it('fails, naming the read, before the test times out when reading the agent setup hangs', async () => {
    // Abandon time is 30 ms away.
    const testStartedAt = Date.now() - (SUITE_TIMEOUT_MS - 5 * 60_000 - 30)
    let ran = false

    const checking = checkFromTestStart(testStartedAt, {
      baseline,
      changedPaths: ['src/server/factory/harness.ts'],
      readSetup: () => new Promise<never>(() => {}),
      runQuick: async () => {
        ran = true
        return { results: [], skipped: [] }
      },
    })

    await expect(checking).rejects.toThrow(/agent setup/)
    expect(ran).toBe(false)
  })

  it('runs the quick set against the time the test started, setup read included', async () => {
    const testStartedAt = Date.now() - 60_000
    const given: number[] = []

    const checked = await checkFromTestStart(testStartedAt, {
      baseline,
      changedPaths: ['src/server/factory/harness.ts'],
      readSetup: async () => baseline.setup,
      runQuick: async (startedAt) => {
        given.push(startedAt)
        return { results: baseline.results, skipped: [] }
      },
    })

    expect(given).toEqual([testStartedAt])
    expect(checked).toMatchObject({ ran: true, ok: true })
  })
})

describe('fromTestStart', () => {
  it('takes the start before the steps run, so choosing the cases counts against the deadline', async () => {
    let clock = 1_000

    const startedAt = await fromTestStart(
      async (testStartedAt) => {
        clock = 9_000 // choosing the cases took 8 seconds
        return testStartedAt
      },
      () => clock,
    )

    expect(startedAt).toBe(1_000)
  })
})
