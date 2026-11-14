import { and, desc, gte, inArray } from 'drizzle-orm'

import type { Database } from '../db'
import { metricPoint, metricSignal } from '../db/schema'
import { evaluate, strongest, type Point } from '../metrics/bands'
import { BANDS, METRIC_NAMES, METRICS, type BandConfig, type MetricName } from '../metrics/config'
import { comparisonByAgent } from '../metrics/by-agent'
import { firstDay } from '../metrics/measure'
import { ALL_REPOSITORIES } from '../metrics/series'
import type { MetricBand, MetricRow, MetricsReport, MetricSignalView } from '../../shared/panel'

/** Days of signals the panel lists. */
const SIGNAL_DAYS = 14

const isMetric = (name: string): name is MetricName =>
  (METRIC_NAMES as readonly string[]).includes(name)

function bandOf(points: Point[], metric: MetricName, config: BandConfig) {
  const state = evaluate(points, METRICS[metric].worse, config)
  if (state.kind === 'no_baseline')
    return { band: 'no_baseline' as MetricBand, mean: null, sd: null, rules: [] }
  return {
    band: (strongest(state.broken) ?? 'in_band') as MetricBand,
    mean: state.baseline.mean,
    sd: state.baseline.sd,
    rules: state.broken.map((b) => b.rule),
  }
}

/**
 * What the panel shows about the factory's own indicators: the latest day of each, the factory's first and
 * then each repository's, against its band, and the signals of the last two weeks worth a look.
 */
export async function metricsReport(
  db: Database,
  now = new Date(),
  config: BandConfig = BANDS,
): Promise<MetricsReport> {
  const from = firstDay(now, config).toISOString().slice(0, 10)
  const points = await db
    .select()
    .from(metricPoint)
    .where(gte(metricPoint.day, from))
    .orderBy(metricPoint.day)
  const series = new Map<string, { metric: MetricName; repository: string; points: Point[] }>()
  for (const p of points) {
    if (!isMetric(p.metric)) continue
    const key = `${p.metric} ${p.repository}`
    const s = series.get(key) ?? { metric: p.metric, repository: p.repository, points: [] }
    s.points.push({ day: p.day, value: p.value, samples: p.samples })
    series.set(key, s)
  }
  const rows: MetricRow[] = [...series.values()].map((s) => {
    const spec = METRICS[s.metric]
    const latest = s.points[s.points.length - 1]
    return {
      metric: s.metric,
      label: spec.label,
      unit: spec.unit,
      worse: spec.worse,
      repository: s.repository,
      day: latest.day,
      value: latest.value,
      samples: latest.samples,
      ...bandOf(s.points, s.metric, config),
    }
  })
  rows.sort(
    (a, b) =>
      METRIC_NAMES.indexOf(a.metric as MetricName) - METRIC_NAMES.indexOf(b.metric as MetricName) ||
      Number(b.repository === ALL_REPOSITORIES) - Number(a.repository === ALL_REPOSITORIES) ||
      a.repository.localeCompare(b.repository),
  )
  const since = new Date(now.getTime() - SIGNAL_DAYS * 86_400_000).toISOString().slice(0, 10)
  const recent = await db
    .select()
    .from(metricSignal)
    .where(and(gte(metricSignal.day, since), inArray(metricSignal.tier, ['show', 'act'])))
    .orderBy(desc(metricSignal.day), desc(metricSignal.id))
  const signals: MetricSignalView[] = recent.map((s) => ({
    metric: s.metric,
    label: isMetric(s.metric) ? METRICS[s.metric].label : s.metric,
    repository: s.repository,
    day: s.day,
    rule: s.rule,
    tier: s.tier as 'show' | 'act',
    value: s.value,
    mean: s.mean,
    sd: s.sd,
    issueUrl: s.issueUrl,
    error: s.error,
  }))
  return { rows, signals, byAgent: await comparisonByAgent(db) }
}
