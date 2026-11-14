import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import {
  evidence,
  ingress,
  metricPoint,
  metricSignal,
  review,
  stageEvent,
  task,
  watch,
} from '../db/schema'
import { metricsReport } from '../panel/metrics'

import { BANDS } from './config'
import { loadHistories, measure } from './measure'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

const DAY_MS = 86_400_000
const FIRST = Date.parse('2026-10-20T00:00:00Z')
/** The last seeded day is the twentieth; the cron runs that evening. */
const NOW = new Date(FIRST + 19 * DAY_MS + 18 * 3_600_000)
const dayAt = (d: number, minutes: number) =>
  new Date(FIRST + d * DAY_MS + 10 * 3_600_000 + minutes * 60_000)

let seeded = 0

/** A task with one run, started at 10:00 on day `d` and delivered half an hour later for `cost`. */
async function delivered(d: number, cost: number, repository = 'paulo/app') {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `d-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({
      ingressId: i.id,
      repository,
      issueNumber: seeded,
      issueTitle: 't',
      stage: 'done',
      createdAt: dayAt(d, 0),
    })
    .returning({ id: task.id })
  await db.insert(stageEvent).values([
    { taskId: t.id, stage: 'intake', at: dayAt(d, 0) },
    { taskId: t.id, stage: 'done', detail: { costUsd: cost }, at: dayAt(d, 30) },
  ])
  return t.id
}

/** Nineteen days of three deliveries a day costing 0.9 or 1.1, then a day at `last`. */
async function history(last: number) {
  for (let d = 0; d < 19; d++)
    for (let n = 0; n < 3; n++) await delivered(d, d % 2 === 0 ? 0.9 : 1.1)
  for (let n = 0; n < 3; n++) await delivered(19, last)
}

const opened: { repository: string; title: string; body: string }[] = []
let failures = 0
const openIssue = async (repository: string, title: string, body: string) => {
  if (failures > 0) {
    failures -= 1
    throw new Error('GitHub answered 502 creating an issue')
  }
  opened.push({ repository, title, body })
  return `https://github.com/${repository}/issues/${opened.length}`
}

beforeEach(async () => {
  await getPool().query(
    'truncate table metric_signal, metric_point, watch, review, evidence, stage_event, task, ingress restart identity cascade',
  )
  opened.length = 0
  failures = 0
})

describe('measure', () => {
  it('opens one issue when the last day breaks 3 sigma, and none on a second pass the same day', async () => {
    await history(5)

    const first = await measure({ db: getDb(), now: () => NOW, openIssue })
    const second = await measure({ db: getDb(), now: () => NOW, openIssue })

    expect(first.issues).toHaveLength(1)
    expect(opened).toHaveLength(1)
    expect(opened[0].repository).toBe(BANDS.issueRepository)
    expect(opened[0].title).toBe(
      'metrics: cost per delivered run left its control band in paulo/app on 2026-11-08',
    )
    expect(opened[0].body).toContain(
      '`cost_per_delivery` in paulo/app broke `beyond_3_sigma` on 2026-11-08',
    )
    expect(opened[0].body).toContain('| 2026-11-08 | US$ 5.00 | 3 |')
    expect(second.issues).toEqual([])
    expect(second.signals).toEqual([])
  })

  it('records the signal of the series of all repositories without a second issue for the same day', async () => {
    await history(5)

    const result = await measure({ db: getDb(), now: () => NOW, openIssue })

    expect(result.signals).toEqual(
      expect.arrayContaining([
        {
          metric: 'cost_per_delivery',
          repository: 'paulo/app',
          day: '2026-11-08',
          rule: 'beyond_3_sigma',
          tier: 'act',
        },
        {
          metric: 'cost_per_delivery',
          repository: '*',
          day: '2026-11-08',
          rule: 'beyond_3_sigma',
          tier: 'act',
        },
      ]),
    )
    const rows = await getDb()
      .select({ repository: metricSignal.repository, issueUrl: metricSignal.issueUrl })
      .from(metricSignal)
      .where(eq(metricSignal.rule, 'beyond_3_sigma'))
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          repository: 'paulo/app',
          issueUrl: `https://github.com/${BANDS.issueRepository}/issues/1`,
        },
        { repository: '*', issueUrl: null },
      ]),
    )
  })

  it('opens nothing when the last day is inside the band', async () => {
    await history(1)

    const result = await measure({ db: getDb(), now: () => NOW, openIssue })

    expect(result.issues).toEqual([])
    expect(result.signals).toEqual([])
  })

  it('opens nothing for a day better than the band, however far', async () => {
    await history(0.01)

    expect((await measure({ db: getDb(), now: () => NOW, openIssue })).signals).toEqual([])
  })

  it('keeps a point per day and series, written again on every pass', async () => {
    await history(5)

    const first = await measure({ db: getDb(), now: () => NOW, openIssue })
    await measure({ db: getDb(), now: () => NOW, openIssue })

    const points = await getDb()
      .select()
      .from(metricPoint)
      .where(
        and(eq(metricPoint.metric, 'cost_per_delivery'), eq(metricPoint.repository, 'paulo/app')),
      )
    expect(points).toHaveLength(20)
    expect(points.find((p) => p.day === '2026-11-08')).toMatchObject({ value: 5, samples: 3 })
    // Cost, minutes to delivery and change failure, for the repository and for all: 20 days each.
    expect(first.points).toBe(120)
  })

  it('records a failure to open the issue and tries again on the next pass', async () => {
    await history(5)
    // Both the repository's series and the one of all repositories try, and both fail.
    failures = 2

    const first = await measure({ db: getDb(), now: () => NOW, openIssue })
    const [failed] = await getDb()
      .select()
      .from(metricSignal)
      .where(and(eq(metricSignal.repository, 'paulo/app'), eq(metricSignal.rule, 'beyond_3_sigma')))
    const second = await measure({ db: getDb(), now: () => NOW, openIssue })

    expect(first.issues).toEqual([])
    expect(failed.error).toContain('GitHub answered 502')
    expect(second.issues).toHaveLength(1)
  })

  it('records signals without an issue when nothing can open one', async () => {
    await history(5)

    const result = await measure({ db: getDb(), now: () => NOW })

    expect(result.issues).toEqual([])
    expect(result.signals.length).toBeGreaterThan(0)
  })

  it('leaves out work older than the window and its tail', async () => {
    await delivered(-60, 100)

    expect((await measure({ db: getDb(), now: () => NOW, openIssue })).points).toBe(0)
  })
})

describe('loadHistories', () => {
  it('reads each active task with its events, reviews, evidence and whether its release went red', async () => {
    const id = await delivered(19, 1)
    const db = getDb()
    await db.insert(review).values({
      taskId: id,
      round: 1,
      sha: 'a1',
      reviewer: 'r',
      verdict: 'approve',
      summary: '',
      findings: [],
      at: dayAt(19, 20),
    })
    await db.insert(evidence).values({
      taskId: id,
      name: 'tests',
      command: 'npm test',
      sha: 'a1',
      exitCode: 0,
      timedOut: false,
      passed: true,
      output: '',
      durationMs: 1,
      at: dayAt(19, 10),
    })
    await db.insert(watch).values({
      taskId: id,
      repository: 'paulo/app',
      sha: 'm',
      pullRequestNumber: 1,
      status: 'red',
    })
    await delivered(-60, 1)

    const histories = await loadHistories(db, new Date(FIRST))

    expect(histories).toEqual([
      {
        repository: 'paulo/app',
        createdAt: dayAt(19, 0),
        events: [
          { stage: 'intake', at: dayAt(19, 0), detail: null },
          { stage: 'done', at: dayAt(19, 30), detail: { costUsd: 1 } },
        ],
        reviews: [{ taskId: id, verdict: 'approve', at: dayAt(19, 20) }],
        evidence: [{ taskId: id, sha: 'a1', passed: true, at: dayAt(19, 10) }],
        releaseWentRed: true,
      },
    ])
  })

  it('reads nothing when no task moved since the day given', async () => {
    await delivered(0, 1)
    expect(await loadHistories(getDb(), new Date(FIRST + 5 * DAY_MS))).toEqual([])
  })
})

describe('metricsReport', () => {
  it('shows the latest day of each indicator against its band, the whole factory first', async () => {
    await history(5)
    await delivered(19, 5, 'paulo/other')
    await delivered(19, 5, 'paulo/other')
    await delivered(19, 5, 'paulo/other')
    await measure({ db: getDb(), now: () => NOW, openIssue })

    const report = await metricsReport(getDb(), NOW)

    const cost = report.rows.filter((r) => r.metric === 'cost_per_delivery')
    expect(cost.map((r) => r.repository)).toEqual(['*', 'paulo/app', 'paulo/other'])
    expect(cost[1]).toMatchObject({
      label: 'Cost per delivered run',
      unit: 'usd',
      worse: 'up',
      day: '2026-11-08',
      value: 5,
      samples: 3,
      mean: expect.closeTo(1, 6),
      band: 'act',
      rules: ['beyond_3_sigma'],
    })
    expect(cost[2]).toMatchObject({ band: 'no_baseline', mean: null, sd: null, rules: [] })
    expect(report.rows.find((r) => r.metric === 'minutes_to_delivery')).toMatchObject({
      band: 'no_baseline',
    })
    expect(report.signals[0]).toMatchObject({ tier: 'act', label: 'Cost per delivered run' })
    expect(report.signals.some((s) => s.issueUrl !== null)).toBe(true)
  })

  it('reads a day inside the band as in band, and leaves logged signals off the panel', async () => {
    await history(1.1)
    await getDb().insert(metricSignal).values({
      metric: 'cost_per_delivery',
      repository: 'paulo/app',
      day: '2026-11-08',
      rule: 'four_of_five_beyond_1_sigma',
      tier: 'log',
      value: 1,
      mean: 1,
      sd: 0.1,
    })
    await measure({ db: getDb(), now: () => NOW, openIssue })

    const report = await metricsReport(getDb(), NOW)

    expect(report.rows.find((r) => r.metric === 'cost_per_delivery')).toMatchObject({
      band: 'in_band',
    })
    expect(report.signals).toEqual([])
  })
})

describe('first-review approval by agent', () => {
  it('gives one series for each agent that reviewed, so a change of reviewer can be compared', async () => {
    const db = getDb()
    const reviewed = async (reviewer: string, verdict: 'approve' | 'changes') => {
      const taskId = await delivered(10, 1)
      await db.insert(review).values({
        taskId,
        round: 1,
        sha: 'a1',
        reviewer,
        verdict,
        summary: '',
        findings: [],
        at: dayAt(10, 20),
      })
    }
    await reviewed('claude-code', 'changes')
    await reviewed('claude-code', 'approve')
    await reviewed('codex', 'approve')

    expect((await metricsReport(db, NOW)).byAgent.approval).toEqual([
      { reviewer: 'claude-code', model: null, reviews: 2, approved: 1, share: 0.5 },
      { reviewer: 'codex', model: null, reviews: 1, approved: 1, share: 1 },
    ])
    expect((await metricsReport(db, NOW)).byAgent.reviewerRework).toEqual([
      { reviewer: 'claude-code', model: null, reviews: 2, reworkRounds: 0, perReview: 0 },
      { reviewer: 'codex', model: null, reviews: 1, reworkRounds: 0, perReview: 0 },
    ])
  })
})
