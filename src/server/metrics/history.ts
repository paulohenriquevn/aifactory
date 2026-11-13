import type { TaskStage } from '../db/schema'

import type { MetricName } from './config'

export type HistoryEvent = { stage: TaskStage; at: Date; detail: Record<string, unknown> | null }

/** Everything the factory wrote about one task, as the indicators read it. Events in the order they happened. */
export type TaskHistory = {
  repository: string
  createdAt: Date
  events: HistoryEvent[]
  reviews: { verdict: 'approve' | 'changes' | 'invalid'; at: Date }[]
  evidence: { sha: string; passed: boolean; at: Date }[]
  /** The default branch went red after a release of this task. */
  releaseWentRed: boolean
}

/** One measurement, dated when the run it describes ended. */
export type Observation = { metric: MetricName; repository: string; at: Date; value: number }

type Run = { start: Date; end: number; events: HistoryEvent[] }

/** How a run ends. A cancelled run ended too, but it is not a delivery and not a delivery coming back. */
const TERMINAL: TaskStage[] = ['done', 'failed', 'handoff', 'cancelled']
/** What, after a delivery in the same run, means the delivery did not hold. */
const CAME_BACK: TaskStage[] = ['failed', 'handoff']
const MINUTE = 60_000

/** A task's runs: one starts at each intake (the first at the first event) and lasts until the next. */
function runsOf(events: HistoryEvent[]): Run[] {
  const runs: Run[] = []
  for (const event of events) {
    if (runs.length === 0 || event.stage === 'intake') {
      runs.push({ start: event.at, end: Infinity, events: [] })
    }
    runs[runs.length - 1].events.push(event)
  }
  runs.forEach((run, i) => {
    if (i + 1 < runs.length) run.end = runs[i + 1].start.getTime()
  })
  return runs
}

const inRun = (run: Run, at: Date) => at >= run.start && at.getTime() < run.end

/** Whether every check of the run's first verification passed, or undefined when none was recorded. */
function firstPass(run: Run, evidence: TaskHistory['evidence']): number | undefined {
  const verifies = run.events.filter((e) => e.stage === 'verify')
  const first = verifies[0]
  if (!first) return undefined
  const until = verifies[1]?.at.getTime() ?? run.end
  const checks = evidence.filter(
    (e) => e.sha === first.detail?.sha && e.at >= first.at && e.at.getTime() < until,
  )
  if (checks.length === 0) return undefined
  return checks.every((e) => e.passed) ? 1 : 0
}

/** What one finished run says about each indicator. */
function measureRun(run: Run, h: TaskHistory, cameBackLater: boolean) {
  const values: Partial<Record<MetricName, number>> = {}
  const builds = run.events.filter((e) => e.stage === 'build')
  if (builds.length > 0)
    values.rework_rounds = builds.filter((e) => e.detail?.rework === true).length
  values.first_pass_checks = firstPass(run, h.evidence)
  const review = h.reviews.find((r) => inRun(run, r.at))
  if (review) {
    values.first_review_approval = review.verdict === 'approve' ? 1 : 0
    values.minutes_to_first_review = (review.at.getTime() - run.start.getTime()) / MINUTE
  }
  const doneAt = run.events.findIndex((e) => e.stage === 'done')
  if (doneAt >= 0) {
    const done = run.events[doneAt]
    values.minutes_to_delivery = (done.at.getTime() - run.start.getTime()) / MINUTE
    const cost = done.detail?.costUsd
    if (typeof cost === 'number') values.cost_per_delivery = cost
    const after = run.events.slice(doneAt + 1)
    // A release that went red belongs to the last delivery; an earlier one already came back to a new run.
    const failed =
      cameBackLater || after.some((e) => CAME_BACK.includes(e.stage)) || h.releaseWentRed
    values.change_failure = failed ? 1 : 0
  }
  return values
}

/**
 * The observations one task gives: one set per finished run, and the hours to its first release. A run that
 * only waited for another issue measures nothing, and neither does a run still going.
 */
export function observe(h: TaskHistory): Observation[] {
  const out: Observation[] = []
  const runs = runsOf(h.events)
  runs.forEach((run, i) => {
    const terminal = run.events.find((e) => TERMINAL.includes(e.stage))
    if (!terminal) return
    if (Array.isArray(terminal.detail?.blockedBy)) return
    const values = measureRun(run, h, i + 1 < runs.length)
    for (const [metric, value] of Object.entries(values)) {
      if (value === undefined) continue
      out.push({ metric: metric as MetricName, repository: h.repository, at: terminal.at, value })
    }
  })
  const released = h.events.find((e) => e.stage === 'released')
  if (released) {
    out.push({
      metric: 'hours_to_release',
      repository: h.repository,
      at: released.at,
      value: (released.at.getTime() - h.createdAt.getTime()) / (60 * MINUTE),
    })
  }
  return out
}
