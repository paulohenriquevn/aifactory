import { describe, expect, it } from 'vitest'

import { METRICS } from './config'
import type { Observation } from './history'
import { ALL_REPOSITORIES, dailySeries } from './series'

const obs = (repository: string, day: string, value: number, metric = 'first_pass_checks') =>
  ({ metric, repository, at: new Date(`${day}T12:00:00Z`), value }) as Observation

describe('dailySeries', () => {
  it('makes one point per day: the mean of the day and how many observations made it', () => {
    const series = dailySeries(
      [obs('o/a', '2026-11-01', 1), obs('o/a', '2026-11-01', 0), obs('o/a', '2026-11-01', 1)],
      METRICS,
    )
    expect(series).toContainEqual({
      metric: 'first_pass_checks',
      repository: 'o/a',
      points: [{ day: '2026-11-01', value: 2 / 3, samples: 3 }],
    })
  })

  it('keeps a series per repository and one for the whole factory', () => {
    const series = dailySeries(
      [
        obs('o/b', '2026-11-01', 0),
        obs('o/b', '2026-11-01', 0),
        obs('o/b', '2026-11-01', 0),
        obs('o/a', '2026-11-01', 1),
        obs('o/a', '2026-11-01', 1),
        obs('o/a', '2026-11-01', 1),
      ],
      METRICS,
    )
    // Ordered by repository, the whole factory first, whatever order the observations came in.
    expect(series.map((s) => s.repository)).toEqual([ALL_REPOSITORIES, 'o/a', 'o/b'])
    expect(series.find((s) => s.repository === ALL_REPOSITORIES)?.points).toEqual([
      { day: '2026-11-01', value: 0.5, samples: 6 },
    ])
  })

  it('makes no point for a day with fewer observations than the metric needs', () => {
    const series = dailySeries(
      [obs('o/a', '2026-11-01', 1), obs('o/a', '2026-11-01', 1), obs('o/a', '2026-11-02', 1)],
      METRICS,
    )
    expect(series).toEqual([])
  })

  it('orders the points of a series by day and keeps metrics apart', () => {
    const three = (day: string, value: number, metric?: string) =>
      [1, 2, 3].map(() => obs('o/a', day, value, metric))
    const series = dailySeries(
      [
        ...three('2026-11-02', 5, 'rework_rounds'),
        ...three('2026-11-03', 3),
        ...three('2026-11-01', 1),
      ],
      METRICS,
    )
    const own = series.filter((s) => s.repository === 'o/a')
    expect(own).toEqual([
      {
        metric: 'first_pass_checks',
        repository: 'o/a',
        points: [
          { day: '2026-11-01', value: 1, samples: 3 },
          { day: '2026-11-03', value: 3, samples: 3 },
        ],
      },
      {
        metric: 'rework_rounds',
        repository: 'o/a',
        points: [{ day: '2026-11-02', value: 5, samples: 3 }],
      },
    ])
  })

  it('dates an observation by its day in UTC', () => {
    const late = { ...obs('o/a', '2026-11-01', 1), at: new Date('2026-11-01T23:59:59Z') }
    const early = { ...obs('o/a', '2026-11-02', 1), at: new Date('2026-11-02T00:00:00Z') }
    const series = dailySeries([late, early], {
      ...METRICS,
      first_pass_checks: { ...METRICS.first_pass_checks, minSamples: 1 },
    })
    expect(series.find((s) => s.repository === 'o/a')?.points.map((p) => p.day)).toEqual([
      '2026-11-01',
      '2026-11-02',
    ])
  })
})
