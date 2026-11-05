import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, repository, stageEvent, task } from '../db/schema'

import { describeTask, factoryStatus, findTasks } from './chat-tools'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table agent_run, stage_event, task, ingress, repository restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

let n = 0
async function seed(stage: string, detail?: object, repo = 'paulo/app') {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `c-${++n}`,
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
      repository: repo,
      issueNumber: n,
      issueTitle: `Issue ${n}`,
      stage: stage as never,
    })
    .returning({ id: task.id })
  if (detail) await db.insert(stageEvent).values({ taskId: t.id, stage: stage as never, detail })
  return t.id
}

describe('factoryStatus', () => {
  it('counts tasks by stage and tells the failures that retry themselves from the ones for a person', async () => {
    await seed('done')
    await seed('build')
    await seed('failed', { quota: true })
    await seed('failed', { error: 'git push: remote rejected' })
    await seed('failed', { error: 'the agent made no change' })
    await getDb()
      .insert(repository)
      .values({ fullName: 'paulo/app', enabled: true, baseBranch: null, releaseBranch: 'main' })
    await getDb().insert(repository).values({ fullName: 'paulo/off', enabled: false })

    const status = await factoryStatus(getDb(), { FACTORY_HARNESS: 'codex' }, null)

    expect(status.tasksByStage).toEqual({ done: 1, build: 1, failed: 3 })
    expect(status.failedTasks).toEqual({
      willRetryItself: 2,
      waitingForTheUsageLimit: 1,
      needAPerson: 1,
    })
    expect(status.repositories).toEqual([
      expect.objectContaining({
        name: 'paulo/app',
        integrationBranch: 'workspace',
        releaseBranch: 'main',
        checks: ['npm test'],
      }),
    ])
    expect(status.setup).toEqual({ builder: 'codex', sandbox: 'vercel', releaseMode: 'manual' })
    expect(status.backlogFeed).toBeNull()
  })
})

describe('findTasks and describeTask', () => {
  it('filters by stage and repository, and caps the number returned', async () => {
    await seed('failed', { quota: true }, 'paulo/app')
    await seed('done', undefined, 'paulo/other')
    expect((await findTasks(getDb(), { stage: 'failed' })).map((t) => t.repository)).toEqual([
      'paulo/app',
    ])
    expect((await findTasks(getDb(), { repository: 'OTHER' })).map((t) => t.stage)).toEqual([
      'done',
    ])
    expect(await findTasks(getDb(), { limit: 1 })).toHaveLength(1)
    expect(await findTasks(getDb(), { limit: 0 })).toHaveLength(1)
  })

  it('describes one task with its last events, and says when there is none', async () => {
    const id = await seed('failed', { error: 'x'.repeat(500), quota: true })
    const detail = await describeTask(getDb(), id)
    expect(detail).toMatchObject({ task: { id, stage: 'failed' } })
    const events = (detail as { lastEvents: { detail: Record<string, string> }[] }).lastEvents
    expect(events.at(-1)?.detail.error).toHaveLength(300)
    expect(await describeTask(getDb(), 99999)).toEqual({ error: 'there is no task 99999' })
  })
})
