import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { coordinatorAction, ingress, stageEvent, task } from '../db/schema'
import { FakeGithub } from '../../test/fake-github'
import { jobBackend } from '../factory/job-backend'

import { coordinate, type CoordinatorDeps } from './coordinate'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  // A pass reads and keeps the holds of the `prioritise` playbook, which live in TheoKit's job table.
  await jobBackend().migrate()
})
beforeEach(async () => {
  await getPool().query(
    'truncate table theokit_jobs, coordinator_action, finding, decision, review, change_plan, stage_event, task, ingress, repository restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const queued: unknown[] = []

const deps = (api: FakeGithub): CoordinatorDeps => ({
  db: getDb(),
  github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
  api,
  issues: api,
  readIssue: (repo, number) => api.readIssue(repo, number),
  drafter: async () => ({ response: '', cost: 0 }),
  releaseMode: 'manual',
  enqueueResume: async () => undefined,
  deleteSnapshot: async () => undefined,
  inTransaction: (work) =>
    getDb().transaction((tx) => work(tx as never, async (input) => void queued.push(input))),
})

describe('the coordinator on a task whose recorded pull request is closed', () => {
  it('escalates it as unknown, not sending it back on the stale merge state', async () => {
    const db = getDb()
    const api = new FakeGithub()
    api
      .repo('paulo/app')
      .pullRequest({ number: 3, headRef: 'factory/3', state: 'closed', mergeableState: 'dirty' })
    const [i] = await db
      .insert(ingress)
      .values({
        deliveryId: 'closed-1',
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
        repository: 'paulo/app',
        issueNumber: 3,
        issueTitle: 'T',
        stage: 'handoff',
        headSha: 'abc',
        pullRequestUrl: 'https://github.com/paulo/app/pull/3',
      })
      .returning({ id: task.id })
    await db.insert(stageEvent).values([
      { taskId: t.id, stage: 'intake', detail: null },
      {
        taskId: t.id,
        stage: 'handoff',
        detail: { reason: 'the required checks failed', cause: 'checks_unchanged' },
      },
    ])

    const result = await coordinate(deps(api), 'auto')

    expect(result).toMatchObject({ escalated: 1, applied: 0 })
    expect(queued).toEqual([])
    const [row] = await db.select().from(coordinatorAction)
    expect(row).toMatchObject({ exceptionKind: 'unknown', action: 'escalate' })
    expect(row.reason).toContain('the pull request is closed')
  })
})
