import { and, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { evidence, metricPoint, metricSignal, review, stageEvent, task, watch } from '../db/schema'

import { evaluate, TAIL, type Baseline, type Broken, type Point } from './bands'
import { BANDS, METRICS, type BandConfig, type MetricName, type MetricSpec } from './config'
import { observe, type TaskHistory } from './history'
import { ALL_REPOSITORIES, dailySeries, type Series } from './series'

const DAY_MS = 86_400_000

export type MeasureDeps = {
  db: Database
  now?: () => Date
  config?: BandConfig
  metrics?: Record<MetricName, MetricSpec>
  /** Opens an issue in a repository and answers its URL. Without it an `act` signal is only recorded. */
  openIssue?: (repository: string, title: string, body: string) => Promise<string>
}

export type Signal = { metric: MetricName; repository: string; day: string } & Broken

export type MeasureResult = {
  points: number
  /** The signals recorded on this pass. One already recorded for the same day and rule is not here. */
  signals: Signal[]
  issues: string[]
}

/** The first day the indicators cover: the band's window and the tail it reads, ending today. */
export function firstDay(now: Date, config: BandConfig): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return new Date(today - (config.windowDays + TAIL) * DAY_MS)
}

/** The history of every task that did something since `since`, as the indicators read it. */
export async function loadHistories(db: Database, since: Date): Promise<TaskHistory[]> {
  const active = await db
    .selectDistinct({ id: stageEvent.taskId })
    .from(stageEvent)
    .where(gte(stageEvent.at, since))
  const ids = active.map((r) => r.id)
  if (ids.length === 0) return []
  const [tasks, events, reviews, checks, red] = await Promise.all([
    db
      .select({ id: task.id, repository: task.repository, createdAt: task.createdAt })
      .from(task)
      .where(inArray(task.id, ids)),
    db
      .select({
        taskId: stageEvent.taskId,
        stage: stageEvent.stage,
        at: stageEvent.at,
        detail: stageEvent.detail,
      })
      .from(stageEvent)
      .where(inArray(stageEvent.taskId, ids))
      .orderBy(stageEvent.id),
    db
      .select({ taskId: review.taskId, verdict: review.verdict, at: review.at })
      .from(review)
      .where(inArray(review.taskId, ids))
      .orderBy(review.id),
    db
      .select({
        taskId: evidence.taskId,
        sha: evidence.sha,
        passed: evidence.passed,
        at: evidence.at,
      })
      .from(evidence)
      .where(inArray(evidence.taskId, ids)),
    db
      .selectDistinct({ taskId: watch.taskId })
      .from(watch)
      .where(and(inArray(watch.taskId, ids), eq(watch.status, 'red'))),
  ])
  const redIds = new Set(red.map((r) => r.taskId))
  return tasks.map((t) => ({
    repository: t.repository,
    createdAt: t.createdAt,
    events: events
      .filter((e) => e.taskId === t.id)
      .map((e) => ({
        stage: e.stage,
        at: e.at,
        detail: (e.detail ?? null) as Record<string, unknown> | null,
      })),
    reviews: reviews.filter((r) => r.taskId === t.id),
    evidence: checks.filter((c) => c.taskId === t.id),
    releaseWentRed: redIds.has(t.id),
  }))
}

async function savePoints(db: Database, series: Series[]): Promise<number> {
  const rows = series.flatMap((s) =>
    s.points.map((p) => ({
      metric: s.metric,
      repository: s.repository,
      day: p.day,
      value: p.value,
      samples: p.samples,
    })),
  )
  if (rows.length === 0) return 0
  await db
    .insert(metricPoint)
    .values(rows)
    .onConflictDoUpdate({
      target: [metricPoint.metric, metricPoint.repository, metricPoint.day],
      set: { value: sql`excluded.value`, samples: sql`excluded.samples`, updatedAt: sql`now()` },
    })
  return rows.length
}

const where = (repository: string) =>
  repository === ALL_REPOSITORIES ? 'all repositories' : repository

function format(value: number, unit: MetricSpec['unit']): string {
  if (unit === 'share') return `${(value * 100).toFixed(1)}%`
  if (unit === 'usd') return `US$ ${value.toFixed(2)}`
  return `${value.toFixed(1)} ${unit}`
}

/** The issue an `act` signal opens: what broke, against which baseline, and the points behind it. */
export function issueFor(
  s: Signal,
  spec: MetricSpec,
  baseline: Baseline,
  points: Point[],
  config: BandConfig,
): { title: string; body: string } {
  const latest = points[points.length - 1]
  const rows = points
    .slice(-(TAIL + 7))
    .map((p) => `| ${p.day} | ${format(p.value, spec.unit)} | ${p.samples} |`)
    .join('\n')
  return {
    title: `metrics: ${spec.label.toLowerCase()} left its control band in ${where(s.repository)} on ${s.day}`,
    body: [
      `**Area:** supervision / metrics`,
      '',
      `\`${s.metric}\` in ${where(s.repository)} broke \`${s.rule}\` on ${s.day}: ${format(latest.value, spec.unit)} from ${latest.samples} observations, against a baseline of ${format(baseline.mean, spec.unit)} ± ${format(baseline.sd, spec.unit)} over ${baseline.points} days (window of ${config.windowDays} days before the last ${TAIL}). The metric gets worse going ${spec.worse}.`,
      '',
      '| Day | Value | Observations |',
      '| --- | --- | --- |',
      rows,
      '',
      'Detection is deterministic (`src/server/metrics/bands.ts`, bands in `src/server/metrics/config.ts`). The `measure` cron opened this issue and opens no other for the same metric and repository within the window.',
    ].join('\n'),
  }
}

/**
 * Whether an issue already covers this signal: one for the same metric and repository within the window, or,
 * for the series of all repositories, one a repository opened for the same metric that day.
 */
async function alreadyFiled(db: Database, s: Signal, config: BandConfig): Promise<boolean> {
  const from = new Date(Date.parse(`${s.day}T00:00:00Z`) - config.windowDays * DAY_MS)
    .toISOString()
    .slice(0, 10)
  const sameSeries = and(eq(metricSignal.repository, s.repository), gte(metricSignal.day, from))
  const covered =
    s.repository === ALL_REPOSITORIES ? or(sameSeries, eq(metricSignal.day, s.day)) : sameSeries
  const [row] = await db
    .select({ id: metricSignal.id })
    .from(metricSignal)
    .where(and(eq(metricSignal.metric, s.metric), isNotNull(metricSignal.issueUrl), covered))
    .limit(1)
  return row !== undefined
}

async function act(
  deps: MeasureDeps,
  id: number,
  s: Signal,
  issue: { title: string; body: string },
  config: BandConfig,
): Promise<string | undefined> {
  if (!deps.openIssue || (await alreadyFiled(deps.db, s, config))) return undefined
  try {
    const url = await deps.openIssue(config.issueRepository, issue.title, issue.body)
    await deps.db.update(metricSignal).set({ issueUrl: url }).where(eq(metricSignal.id, id))
    return url
  } catch (error) {
    // Recorded, so the next pass tries again: the row has no issue yet.
    await deps.db
      .update(metricSignal)
      .set({ error: String(error) })
      .where(eq(metricSignal.id, id))
    console.error(
      JSON.stringify({ event: 'metric_issue_failed', metric: s.metric, error: String(error) }),
    )
    return undefined
  }
}

/** A signal recorded on an earlier pass whose issue could not be opened, so this pass tries again. */
async function failedEarlier(db: Database, sig: Signal) {
  const [row] = await db
    .select({ id: metricSignal.id })
    .from(metricSignal)
    .where(
      and(
        eq(metricSignal.metric, sig.metric),
        eq(metricSignal.repository, sig.repository),
        eq(metricSignal.day, sig.day),
        eq(metricSignal.rule, sig.rule),
        isNotNull(metricSignal.error),
      ),
    )
  return row
}

/** Records the rules a series breaks on its latest day, and opens an issue for each new `act`. */
async function signal(deps: MeasureDeps, s: Series, config: BandConfig, spec: MetricSpec) {
  const out = { signals: [] as Signal[], issues: [] as string[] }
  const state = evaluate(s.points, spec.worse, config)
  if (state.kind !== 'evaluated') return out
  const latest = s.points[s.points.length - 1]
  for (const broken of state.broken) {
    const sig: Signal = { metric: s.metric, repository: s.repository, day: latest.day, ...broken }
    const [row] = await deps.db
      .insert(metricSignal)
      .values({ ...sig, value: latest.value, mean: state.baseline.mean, sd: state.baseline.sd })
      .onConflictDoNothing()
      .returning({ id: metricSignal.id })
    if (row) out.signals.push(sig)
    const pending = row ?? (await failedEarlier(deps.db, sig))
    if (!pending || broken.tier !== 'act') continue
    const issue = issueFor(sig, spec, state.baseline, s.points, config)
    const url = await act(deps, pending.id, sig, issue, config)
    if (url) out.issues.push(url)
  }
  return out
}

/**
 * One pass of the factory measuring itself: the indicators of every task active in the window, saved as daily
 * points, and the control bands read on each series. Detection involves no model.
 */
export async function measure(deps: MeasureDeps): Promise<MeasureResult> {
  const config = deps.config ?? BANDS
  const metrics = deps.metrics ?? METRICS
  const now = (deps.now ?? (() => new Date()))()
  const since = firstDay(now, config)
  const observations = (await loadHistories(deps.db, since))
    .flatMap(observe)
    .filter((o) => o.at >= since && o.at <= now)
  const series = dailySeries(observations, metrics)
  const result: MeasureResult = {
    points: await savePoints(deps.db, series),
    signals: [],
    issues: [],
  }
  // Each repository first, so the series of all of them knows whether a repository already filed the day.
  const ordered = [
    ...series.filter((s) => s.repository !== ALL_REPOSITORIES),
    ...series.filter((s) => s.repository === ALL_REPOSITORIES),
  ]
  for (const s of ordered) {
    const out = await signal(deps, s, config, metrics[s.metric])
    result.signals.push(...out.signals)
    result.issues.push(...out.issues)
  }
  return result
}
