import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { finding, ingress, question, stageEvent, task, watch } from '../db/schema'

import { detect, supervise } from './supervise'

const NOW = new Date('2026-11-04T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
const now = () => NOW

// The queue table the TheoKit worker creates on its first start.
const JOBS = `create table if not exists theokit_jobs (
  id text primary key, name text not null, input jsonb not null, attempts integer not null default 0,
  max_attempts integer not null default 1, available_at timestamptz not null default now(),
  locked_until timestamptz, traceparent text, idempotency_key text, created_at timestamptz not null default now(),
  lease_token text, last_error text, failed_at timestamptz)`

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await getPool().query(JOBS)
})
beforeEach(async () => {
  await getPool().query(JOBS)
  await getPool().query(
    'truncate table finding, agent_run, watch, delivery, decision, question, review, evidence, stage_event, task, ingress, theokit_jobs restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

let seeded = 0
async function seed(stage: string, lastEventMinutesAgo: number): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `s-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'c',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({
      ingressId: i.id,
      repository: 'paulo/app',
      issueNumber: seeded,
      issueTitle: 'T',
      stage: stage as never,
    })
    .returning({ id: task.id })
  await db
    .insert(stageEvent)
    .values({ taskId: t.id, stage: stage as never, at: minutesAgo(lastEventMinutesAgo) })
  return t.id
}

const job = (name: string, input: object, failed = false) =>
  getPool().query(
    'insert into theokit_jobs (id, name, input, failed_at, last_error) values ($1, $2, $3, $4, $5)',
    [
      `j-${Math.random()}`,
      name,
      JSON.stringify(input),
      failed ? new Date() : null,
      failed ? 'boom' : null,
    ],
  )

const keys = async (over: Parameters<typeof detect>[0] extends infer D ? Partial<D> : never = {}) =>
  (await detect({ db: getDb(), now, ...over })).found.map((f) => f.key).sort()

describe('stalled work', () => {
  it('flags a run that has been silent longer than any run should take', async () => {
    const stuck = await seed('build', 50)
    await seed('build', 10)
    expect(await keys()).toEqual([`stalled:run:${stuck}`])
    const [found] = (await detect({ db: getDb(), now })).found
    expect(found).toMatchObject({ kind: 'stalled', subject: 'run', taskId: stuck })
    expect(found.detail).toContain('in build and silent for 50 minutes')
  })

  it('looks at every stage where a run is alive, and at none where nothing should be moving', async () => {
    for (const stage of ['sandbox', 'push', 'verify', 'review', 'pr']) await seed(stage, 90)
    expect(await keys()).toHaveLength(5)
    await getPool().query('truncate table stage_event, task, ingress restart identity cascade')
    for (const stage of ['waiting', 'done', 'released', 'handoff', 'failed']) await seed(stage, 600)
    expect(await keys()).toEqual([])
  })
})

describe('a task queued with no job to run it', () => {
  it('flags it when no job is left, or the job failed, after the pickup time', async () => {
    const lost = await seed('intake', 15)
    const failed = await seed('intake', 15)
    await job('run-task', { taskId: failed }, true)

    const { found } = await detect({ db: getDb(), now })

    expect(found.map((f) => f.key).sort()).toEqual([
      `orphaned:queued_run:${lost}`,
      `orphaned:queued_run:${failed}`,
    ])
    expect(found.find((f) => f.taskId === failed)?.detail).toContain('failed: boom')
    expect(found.find((f) => f.taskId === lost)?.detail).toContain('no job is left to run it')
  })

  it('leaves alone a task whose job is still waiting, and one that was queued a moment ago', async () => {
    const queued = await seed('intake', 15)
    await job('run-task', { taskId: queued })
    await seed('intake', 2)
    expect(await keys()).toEqual([])
  })

  it('does not call a task orphaned when there is no queue table to check', async () => {
    await seed('intake', 15)
    await getPool().query('drop table theokit_jobs')
    const { found, checked } = await detect({ db: getDb(), now })
    expect(found).toEqual([])
    expect(checked.has('queued_run')).toBe(false)
  })
})

describe('an answer nobody resumed', () => {
  async function answered(minutes: number, resumed = false) {
    const id = await seed('waiting', minutes + 30)
    const [q] = await getDb()
      .insert(question)
      .values({
        taskId: id,
        body: 'A or B?',
        commentId: '1',
        snapshotId: `snap-${id}`,
        sessionId: 's',
        harness: 'h',
        repoDir: '/r',
        baseSha: 'b',
        attempt: 1,
        costUsd: 0,
        answer: 'B',
        answeredBy: 'paulo',
        answeredAt: minutesAgo(minutes),
        resumedAt: resumed ? minutesAgo(minutes - 1) : null,
      })
      .returning({ id: question.id })
    return { taskId: id, questionId: q.id }
  }

  it('flags an answer with no resume job after the pickup time', async () => {
    const { taskId, questionId } = await answered(20)
    const { found } = await detect({ db: getDb(), now })
    expect(found).toMatchObject([
      {
        key: `orphaned:answer_resume:${questionId}`,
        subject: 'answer_resume',
        taskId,
        ref: String(questionId),
      },
    ])
    expect(found[0].detail).toContain('answered 20 minutes ago')
  })

  it('leaves alone an answer that has its job, was resumed, or is recent', async () => {
    const withJob = await answered(20)
    await job('resume-task', { taskId: withJob.taskId, questionId: withJob.questionId })
    await answered(20, true)
    await answered(3)
    expect(await keys()).toEqual([])
  })
})

describe('a revert that never finished', () => {
  it('flags a watch stuck in reverting long after the watch window', async () => {
    const id = await seed('released', 300)
    const insert = (status: 'reverting' | 'watching', startedAt: Date) =>
      getDb()
        .insert(watch)
        .values({
          taskId: id,
          repository: 'paulo/app',
          sha: 'm',
          pullRequestNumber: 1,
          status,
          startedAt,
        })
        .returning({ id: watch.id })
    const [stuck] = await insert('reverting', minutesAgo(200))
    await insert('reverting', minutesAgo(20))
    await insert('watching', minutesAgo(200))
    expect(await keys()).toEqual([`orphaned:revert:${stuck.id}`])
  })
})

describe('snapshots nothing needs', () => {
  const snap = (id: string, minutes: number) => ({
    id,
    createdAt: minutesAgo(minutes),
    sizeBytes: 823_000_000,
  })

  it('flags an old snapshot no waiting question refers to, and keeps the ones in use', async () => {
    const id = await seed('waiting', 60)
    await getDb().insert(question).values({
      taskId: id,
      body: 'q',
      commentId: '1',
      snapshotId: 'snap-in-use',
      sessionId: 's',
      harness: 'h',
      repoDir: '/r',
      baseSha: 'b',
      attempt: 1,
      costUsd: 0,
    })
    const found = (
      await detect({
        db: getDb(),
        now,
        listSnapshots: async () => [
          snap('snap-in-use', 60),
          snap('snap-orphan', 60),
          snap('snap-new', 1),
        ],
      })
    ).found
    expect(found).toMatchObject([
      { key: 'orphaned:snapshot:snap-orphan', ref: 'snap-orphan', taskId: null },
    ])
    expect(found[0].detail).toContain('823 MB')
  })

  it('counts a snapshot as an orphan once its question was resumed', async () => {
    const id = await seed('build', 5)
    await getDb()
      .insert(question)
      .values({
        taskId: id,
        body: 'q',
        commentId: '1',
        snapshotId: 'snap-done',
        sessionId: 's',
        harness: 'h',
        repoDir: '/r',
        baseSha: 'b',
        attempt: 1,
        costUsd: 0,
        resumedAt: minutesAgo(30),
      })
    expect(await keys({ listSnapshots: async () => [snap('snap-done', 90)] })).toEqual([
      'orphaned:snapshot:snap-done',
    ])
  })
})

describe('supervise', () => {
  it('opens a finding, keeps it while it is true, and resolves it when it is gone', async () => {
    const id = await seed('build', 50)

    const first = await supervise({ db: getDb(), now })
    expect(first).toMatchObject({ opened: [`stalled:run:${id}`], resolved: [], open: 1 })
    const [opened] = await getDb().select().from(finding)
    expect(opened).toMatchObject({ kind: 'stalled', subject: 'run', taskId: id, resolvedAt: null })

    const later = () => new Date(NOW.getTime() + 5 * 60_000)
    const second = await supervise({ db: getDb(), now: later })
    expect(second.opened).toEqual([])
    const [seen] = await getDb().select().from(finding)
    expect(seen.firstSeenAt.getTime()).toBe(opened.firstSeenAt.getTime())
    expect(seen.lastSeenAt.getTime()).toBe(later().getTime())

    await getDb().update(task).set({ stage: 'failed' }).where(eq(task.id, id))
    const third = await supervise({ db: getDb(), now: later })
    expect(third).toMatchObject({ resolved: [`stalled:run:${id}`], open: 0 })
    expect((await getDb().select().from(finding))[0].resolvedAt).not.toBeNull()
  })

  it('starts a finding over, with a new first-seen time, when the problem comes back', async () => {
    const id = await seed('build', 50)
    await supervise({ db: getDb(), now })
    await getDb().update(task).set({ stage: 'failed' }).where(eq(task.id, id))
    await supervise({ db: getDb(), now })
    await getDb().update(task).set({ stage: 'build' }).where(eq(task.id, id))

    const back = () => new Date(NOW.getTime() + 60 * 60_000)
    const again = await supervise({ db: getDb(), now: back })

    expect(again.opened).toEqual([`stalled:run:${id}`])
    const [row] = await getDb().select().from(finding)
    expect(row.resolvedAt).toBeNull()
    expect(row.firstSeenAt.getTime()).toBe(back().getTime())
  })

  it('does not resolve a snapshot finding when it could not look at snapshots this time', async () => {
    await supervise({
      db: getDb(),
      now,
      listSnapshots: async () => [{ id: 'snap-x', createdAt: minutesAgo(90), sizeBytes: 1 }],
    })

    const blind = await supervise({ db: getDb(), now })

    expect(blind.resolved).toEqual([])
    expect((await getDb().select().from(finding))[0].resolvedAt).toBeNull()

    const sighted = await supervise({ db: getDb(), now, listSnapshots: async () => [] })
    expect(sighted.resolved).toEqual(['orphaned:snapshot:snap-x'])
  })
})
