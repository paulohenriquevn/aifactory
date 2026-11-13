import { describe, expect, it } from 'vitest'

import { baselineOf, evaluate, strongest, TAIL, type Point } from './bands'
import { BANDS, type BandConfig } from './config'

const config: BandConfig = { ...BANDS, windowDays: 30, minBaselinePoints: 7 }

/** Days from 2026-10-01 on, one point per day, with the values given. */
function series(values: number[], from = '2026-10-01'): Point[] {
  const start = Date.parse(`${from}T00:00:00Z`)
  return values.map((value, i) => ({
    day: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    value,
    samples: 5,
  }))
}

/** Ten days that alternate 9 and 11: mean 10, standard deviation 1. */
const steady = [9, 11, 9, 11, 9, 11, 9, 11, 9, 11]

/** The steady baseline, then a tail of eight points ending with the values given and padded with the mean. */
const withTail = (...last: number[]) =>
  series([...steady, ...Array<number>(TAIL - last.length).fill(10), ...last])

const rules = (state: ReturnType<typeof evaluate>) =>
  state.kind === 'evaluated' ? state.broken.map((b) => b.rule) : undefined

describe('baselineOf', () => {
  it('takes the mean and the standard deviation of the points it is given', () => {
    expect(baselineOf(series(steady), '2026-10-20', config)).toEqual({
      mean: 10,
      sd: 1,
      points: 10,
    })
  })

  it('keeps a point exactly at the edge of the window and none older', () => {
    const before = series([1000, ...steady])
    // 2026-10-01 is 30 days before 2026-10-31.
    expect(baselineOf(before, '2026-10-31', config)?.points).toBe(11)
    expect(baselineOf(before, '2026-11-01', config)).toEqual({ mean: 10, sd: 1, points: 10 })
  })

  it('has no baseline with fewer points than the configured minimum', () => {
    expect(baselineOf(series([9, 11, 9, 11, 9, 11]), '2026-10-20', config)).toBeNull()
    expect(baselineOf(series([9, 11, 9, 11, 9, 11, 10]), '2026-10-20', config)).not.toBeNull()
  })

  it('has no baseline when every point is the same, since no distance can be measured', () => {
    expect(baselineOf(series([5, 5, 5, 5, 5, 5, 5, 5]), '2026-10-20', config)).toBeNull()
  })
})

describe('evaluate', () => {
  it('says there is no baseline yet, with how many points come before the tail', () => {
    expect(evaluate([], 'up', config)).toEqual({ kind: 'no_baseline', points: 0 })
    expect(evaluate(series([1, 2, 3]), 'up', config)).toEqual({ kind: 'no_baseline', points: 0 })
    expect(
      evaluate(series([...steady.slice(0, 6), ...Array<number>(TAIL).fill(10)]), 'up', config),
    ).toEqual({
      kind: 'no_baseline',
      points: 6,
    })
  })

  it('stays quiet on a point inside the band and gives its distance in deviations', () => {
    expect(evaluate(withTail(10.5), 'up', config)).toEqual({
      kind: 'evaluated',
      baseline: { mean: 10, sd: 1, points: 10 },
      z: 0.5,
      broken: [],
    })
  })

  it('reads the baseline from before the tail, so recent points do not move it', () => {
    const state = evaluate(withTail(30, 30, 30, 30, 30, 30, 30, 30), 'up', config)
    expect(state).toMatchObject({ baseline: { mean: 10, sd: 1 }, z: 20 })
  })

  it('breaks the 3 sigma rule on a point past three deviations in the worse direction', () => {
    expect(evaluate(withTail(13.5), 'up', config)).toMatchObject({
      broken: [{ rule: 'beyond_3_sigma', tier: 'act' }],
    })
  })

  it('does not break the 3 sigma rule exactly at three deviations', () => {
    expect(rules(evaluate(withTail(13), 'up', config))).toEqual([])
  })

  it('reads a fall as the worse direction for a metric that gets worse going down', () => {
    expect(evaluate(withTail(6), 'down', config)).toMatchObject({
      z: 4,
      broken: [{ rule: 'beyond_3_sigma', tier: 'act' }],
    })
  })

  it('raises nothing for a move in the better direction, however large', () => {
    expect(rules(evaluate(withTail(1, 1, 1, 1, 1, 1, 1, 1), 'up', config))).toEqual([])
    expect(rules(evaluate(withTail(40, 40, 40, 40, 40, 40, 40, 40), 'down', config))).toEqual([])
  })

  it('breaks two of three past 2 sigma when the latest point and one of the two before are past it', () => {
    expect(evaluate(withTail(12.5, 10, 12.5), 'up', config)).toMatchObject({
      broken: [{ rule: 'two_of_three_beyond_2_sigma', tier: 'show' }],
    })
    expect(rules(evaluate(withTail(10, 12.5, 12.5), 'up', config))).toEqual([
      'two_of_three_beyond_2_sigma',
    ])
  })

  it('does not break two of three when the latest point is inside 2 sigma', () => {
    expect(rules(evaluate(withTail(12.5, 12.5, 10), 'up', config))).toEqual([])
  })

  it('does not break two of three with only one point past 2 sigma, nor exactly at 2 sigma', () => {
    expect(rules(evaluate(withTail(10, 10, 12.5), 'up', config))).toEqual([])
    expect(rules(evaluate(withTail(12, 10, 12.5), 'up', config))).toEqual([])
  })

  it('breaks four of five past 1 sigma, which is only logged', () => {
    expect(evaluate(withTail(11.5, 11.5, 10, 11.5, 11.5), 'up', config)).toMatchObject({
      broken: [{ rule: 'four_of_five_beyond_1_sigma', tier: 'log' }],
    })
  })

  it('does not break four of five with three points past 1 sigma, nor with the fourth exactly at it', () => {
    expect(rules(evaluate(withTail(11.5, 10, 10, 11.5, 11.5), 'up', config))).toEqual([])
    expect(rules(evaluate(withTail(11.5, 11, 10, 11.5, 11.5), 'up', config))).toEqual([])
  })

  it('does not break four of five when the latest point is inside 1 sigma', () => {
    expect(rules(evaluate(withTail(11.5, 11.5, 11.5, 11.5, 10), 'up', config))).toEqual([])
  })

  it('breaks eight on one side for a slow drift that crosses no sigma line', () => {
    expect(
      evaluate(withTail(10.3, 10.3, 10.3, 10.3, 10.3, 10.3, 10.3, 10.3), 'up', config),
    ).toMatchObject({
      broken: [{ rule: 'eight_on_one_side', tier: 'show' }],
    })
  })

  it('does not break eight on one side with seven, nor with one point on the mean', () => {
    expect(
      rules(evaluate(withTail(9, 10.3, 10.3, 10.3, 10.3, 10.3, 10.3, 10.3), 'up', config)),
    ).toEqual([])
    expect(
      rules(evaluate(withTail(10.3, 10.3, 10.3, 10, 10.3, 10.3, 10.3, 10.3), 'up', config)),
    ).toEqual([])
  })

  it('reports every rule a point breaks, the strongest first', () => {
    const state = evaluate(withTail(11.5, 11.5, 11.5, 12.5, 14), 'up', config)
    expect(state.kind === 'evaluated' && state.broken.map((b) => b.tier)).toEqual([
      'act',
      'show',
      'log',
    ])
  })

  it('puts a shown rule before a logged one, whatever order the rules are read in', () => {
    // Eight above the mean, the last five past 1 sigma, none past 2: eight on one side and four of five.
    const state = evaluate(withTail(10.5, 10.5, 10.5, 11.5, 11.5, 11.5, 11.5, 11.5), 'up', config)
    expect(state.kind === 'evaluated' && state.broken).toEqual([
      { rule: 'eight_on_one_side', tier: 'show' },
      { rule: 'four_of_five_beyond_1_sigma', tier: 'log' },
    ])
  })

  it('reports only the rules a point breaks', () => {
    expect(evaluate(withTail(13.5), 'up', config)).toEqual(
      expect.objectContaining({ broken: [{ rule: 'beyond_3_sigma', tier: 'act' }] }),
    )
  })

  it('reads two of three on the last three points only', () => {
    // Two points past 2 sigma early in the tail, then the mean, then one past it: one of the last three.
    expect(rules(evaluate(withTail(12.5, 12.5, 10, 10, 10, 10, 10, 12.5), 'up', config))).toEqual(
      [],
    )
  })

  it('does not break two of three when the latest point is exactly at 2 sigma', () => {
    expect(rules(evaluate(withTail(12.5, 12.5, 12), 'up', config))).toEqual([])
  })

  it('measures distance in deviations of the baseline', () => {
    // Alternating 8 and 12: mean 10, standard deviation 2.
    const wide = series([
      8,
      12,
      8,
      12,
      8,
      12,
      8,
      12,
      8,
      12,
      ...Array<number>(TAIL - 1).fill(10),
      15,
    ])
    expect(evaluate(wide, 'up', config)).toMatchObject({ kind: 'evaluated', z: 2.5, broken: [] })
  })

  it('counts, without a baseline, only the earlier points inside the window', () => {
    // Fifty days old, then five recent days, then the tail.
    const old = series([5], '2026-08-01')
    const recent = series([...steady.slice(0, 5), ...Array<number>(TAIL).fill(10)], '2026-10-01')
    expect(evaluate([...old, ...recent], 'up', config)).toEqual({ kind: 'no_baseline', points: 5 })
  })

  it('counts, without a baseline, a point exactly at the edge of the window', () => {
    // The latest day is 2026-10-13; the window reaches back to 2026-09-13.
    const edge = series([5], '2026-09-13')
    const recent = series([...steady.slice(0, 5), ...Array<number>(TAIL).fill(10)], '2026-10-01')
    expect(evaluate([...edge, ...recent], 'up', config)).toEqual({ kind: 'no_baseline', points: 6 })
  })

  it('takes the tier of each rule from the configuration', () => {
    const tiers = { ...config.tiers, beyond_3_sigma: 'log' as const }
    expect(evaluate(withTail(13.5), 'up', { ...config, tiers })).toMatchObject({
      broken: [{ rule: 'beyond_3_sigma', tier: 'log' }],
    })
  })
})

describe('strongest', () => {
  it('names the strongest tier among the broken rules, or none', () => {
    expect(strongest([])).toBeNull()
    expect(strongest([{ rule: 'four_of_five_beyond_1_sigma', tier: 'log' }])).toBe('log')
    expect(
      strongest([
        { rule: 'four_of_five_beyond_1_sigma', tier: 'log' },
        { rule: 'eight_on_one_side', tier: 'show' },
      ]),
    ).toBe('show')
    expect(
      strongest([
        { rule: 'four_of_five_beyond_1_sigma', tier: 'log' },
        { rule: 'beyond_3_sigma', tier: 'act' },
      ]),
    ).toBe('act')
  })
})
