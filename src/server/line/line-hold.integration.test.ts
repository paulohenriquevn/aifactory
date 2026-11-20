import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { maintainHolds } from '../coordinator/queue-hold'
import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, lineIncident, task } from '../db/schema'
import { jobBackend } from '../factory/job-backend'
import { integrationHeldUntil } from '../factory/promotion-merge'
import { inTransactionForRun } from '../factory/resume-queue'
import { listStoppedLines } from './incident'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await jobBackend().migrate()
})
beforeEach(async () => {
  await getPool().query(
    'truncate table theokit_jobs, line_incident, task, ingress restart identity cascade',
  )
})
// An open incident holds the jobs of every suite that runs after this one on the same database.
afterAll(async () => {
  await getPool().query('truncate table line_incident')
  await getStorageManager().dispose()
})

const REPO = 'paulo/app'
let seeded = 0

/** A task of `repository` in `intake`, its run queued. */
async function queued(repository = REPO): Promise<{ id: number; issue: number }> {
  const issue = ++seeded
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `l-${issue}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await getDb()
    .insert(task)
    .values({
      ingressId: i.id,
      repository,
      issueNumber: issue,
      issueTitle: `Issue ${issue}`,
      stage: 'intake',
    })
    .returning({ id: task.id })
  await inTransactionForRun(async (_tx, enqueueRun) => {
    await enqueueRun({ taskId: t.id }, `task-${t.id}`)
  })
  return { id: t.id, issue }
}

const stop = (issueNumber: number) =>
  getDb()
    .insert(lineIncident)
    .values({
      repository: REPO,
      cause: 'promotion_red',
      surface: 'workspace -> develop',
      issueNumber,
      issueUrl: `https://github.com/${REPO}/issues/${issueNumber}`,
      lastSha: 'sha1',
    })

/** Whether the task's run waits for ever (held) rather than at the time it was queued for. */
async function held(taskId: number): Promise<boolean> {
  const { rows } = await getPool().query<{ infinite: boolean }>(
    "select available_at = 'infinity' as infinite from theokit_jobs where idempotency_key = $1",
    [`task-${taskId}`],
  )
  return rows[0].infinite
}

describe('a stopped line', () => {
  it('tells the panel the line holds the rest of the repository back', async () => {
    await stop(999)

    const [line] = await listStoppedLines(getDb())

    expect(line).toMatchObject({ repository: REPO, issueNumber: 999, scope: 'hold' })
  })

  it('holds every other run of the repository and lets its fix run', async () => {
    const other = await queued()
    const fix = await queued()
    await stop(fix.issue)

    await maintainHolds(getDb())

    expect(await held(other.id)).toBe(true)
    expect(await held(fix.id)).toBe(false)
  })

  it('holds every run before its fix has a task', async () => {
    const other = await queued()
    await stop(999)

    await maintainHolds(getDb())

    expect(await held(other.id)).toBe(true)
  })

  it('leaves the runs of other repositories alone', async () => {
    const elsewhere = await queued('paulo/other')
    await stop(999)

    await maintainHolds(getDb())

    expect(await held(elsewhere.id)).toBe(false)
  })

  it('holds a run queued after the line stopped', async () => {
    await stop(999)

    const later = await queued()

    expect(await held(later.id)).toBe(true)
  })

  it('gives the runs back once the line runs again', async () => {
    const other = await queued()
    await stop(999)
    await maintainHolds(getDb())

    await getDb()
      .update(lineIncident)
      .set({ status: 'resolved' })
      .where(eq(lineIncident.repository, REPO))
    await maintainHolds(getDb())

    expect(await held(other.id)).toBe(false)
  })

  it('holds every integration of the repository but its fix', async () => {
    const other = await queued()
    const fix = await queued()
    await stop(fix.issue)
    const now = new Date()

    expect(await integrationHeldUntil(getDb(), REPO, now, other.id)).toBeInstanceOf(Date)
    expect(await integrationHeldUntil(getDb(), REPO, now, fix.id)).toBeUndefined()
  })
})

describe('a stopped line whose scope is fix first', () => {
  // A red promotion held every run of usetheokit/theokit and theokit-sdk for hours while their fixes waited for
  // the promotion's CI, so the factory finished almost nothing (2026-11-19). The owner's flow integrates fast and
  // fixes the promotion on its way to develop.
  beforeEach(() => vi.stubEnv('FACTORY_LINE_STOP_SCOPE', 'fix_first'))
  afterEach(() => vi.unstubAllEnvs())

  it('holds no run of the repository', async () => {
    const other = await queued()
    const fix = await queued()
    await stop(fix.issue)

    await maintainHolds(getDb())

    expect(await held(other.id)).toBe(false)
    expect(await held(fix.id)).toBe(false)
  })

  it('gives back the runs a line held before its scope became fix first', async () => {
    const other = await queued()
    await stop(999)
    vi.stubEnv('FACTORY_LINE_STOP_SCOPE', 'hold')
    await maintainHolds(getDb())
    vi.stubEnv('FACTORY_LINE_STOP_SCOPE', 'fix_first')

    await maintainHolds(getDb())

    expect(await held(other.id)).toBe(false)
  })

  it('holds no run queued after the line stopped', async () => {
    await stop(999)

    const later = await queued()

    expect(await held(later.id)).toBe(false)
  })

  it('tells the panel the line holds nothing back, so the board does not say it does', async () => {
    await stop(999)

    const [line] = await listStoppedLines(getDb())

    expect(line.scope).toBe('fix_first')
  })

  it('holds no integration of the repository', async () => {
    const other = await queued()
    const fix = await queued()
    await stop(fix.issue)

    expect(await integrationHeldUntil(getDb(), REPO, new Date(), other.id)).toBeUndefined()
  })
})
