import type { Point } from './bands'
import type { MetricName, MetricSpec } from './config'
import type { Observation } from './history'

/** The repository name of the series that covers every repository at once. */
export const ALL_REPOSITORIES = '*'

export type Series = { metric: MetricName; repository: string; points: Point[] }

/**
 * Turns observations into one daily series per metric and repository, plus one per metric for the whole
 * factory. A day becomes a point only with enough observations for its metric. Series without a point are
 * left out; series come ordered by metric then repository, points by day.
 */
export function dailySeries(
  observations: Observation[],
  metrics: Record<MetricName, MetricSpec>,
): Series[] {
  const sums = new Map<string, { sum: number; samples: number }>()
  for (const o of observations) {
    const day = o.at.toISOString().slice(0, 10)
    for (const repository of [o.repository, ALL_REPOSITORIES]) {
      const key = JSON.stringify([o.metric, repository, day])
      const acc = sums.get(key) ?? { sum: 0, samples: 0 }
      acc.sum += o.value
      acc.samples += 1
      sums.set(key, acc)
    }
  }
  const series = new Map<string, Series>()
  for (const [key, { sum, samples }] of sums) {
    const [metric, repository, day] = JSON.parse(key) as [MetricName, string, string]
    if (samples < metrics[metric].minSamples) continue
    const id = JSON.stringify([metric, repository])
    const s = series.get(id) ?? { metric, repository, points: [] }
    s.points.push({ day, value: sum / samples, samples })
    series.set(id, s)
  }
  return [...series.values()]
    .map((s) => ({ ...s, points: s.points.sort((a, b) => a.day.localeCompare(b.day)) }))
    .sort((a, b) => a.metric.localeCompare(b.metric) || a.repository.localeCompare(b.repository))
}
