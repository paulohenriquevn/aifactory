import { count } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { PostgresJobBackend, createOutbox, createQueueClient } from 'theokit/server/jobs'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, lazyPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, task } from '../db/schema'

import { recordAndQueue } from './queue'
import type { Delivery } from './record'

const backend = new PostgresJobBackend({ pool: lazyPool })
const queue = createQueueClient(backend, createOutbox())

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await backend.migrate()
})
beforeEach(async () => {
  await getPool().query(
    'truncate table stage_event, task, ingress, theokit_jobs restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const labeled = (number = 7, label = 'factory'): unknown => ({
  action: 'labeled',
  label: { name: label },
  issue: { number, title: 'Fix it', labels: [{ name: label }] },
  repository: { full_name: 'paulo/app' },
})
const delivery = (id: string, payload: unknown = labeled(), event = 'issues'): Delivery => ({
  deliveryId: id,
  event,
  payload,
})

const jobs = async () =>
  (await getPool().query<{ name: string; input: unknown }>('select name, input from theokit_jobs'))
    .rows

describe('a delivery and its job', () => {
  it('queues exactly one run-task job for the task it created', async () => {
    const result = await recordAndQueue(delivery('d-1'), queue)

    expect(result.status).toBe('task_created')
    const [{ id }] = await getDb().select().from(task)
    expect(await jobs()).toEqual([{ name: 'run-task', input: { taskId: id } }])
  })

  it('queues nothing for a redelivery', async () => {
    await recordAndQueue(delivery('d-1'), queue)
    const again = await recordAndQueue(delivery('d-1'), queue)

    expect(again).toEqual({ status: 'duplicate' })
    expect(await jobs()).toHaveLength(1)
  })

  it('queues nothing when the issue already has a task', async () => {
    await recordAndQueue(delivery('d-1'), queue)
    const again = await recordAndQueue(delivery('d-2'), queue)

    expect(again.status).toBe('task_exists')
    expect(await jobs()).toHaveLength(1)
  })

  it('queues nothing for a delivery that is ignored', async () => {
    const result = await recordAndQueue(delivery('d-1', labeled(7, 'bug')), queue)

    expect(result.status).toBe('ignored')
    expect(await jobs()).toHaveLength(0)
  })

  it('rolls the delivery and the task back when the job cannot be queued', async () => {
    const broken = {
      ...queue,
      enqueueInTransaction: async () => {
        throw new Error('queue is down')
      },
    } as unknown as typeof queue

    await expect(recordAndQueue(delivery('d-1'), broken)).rejects.toThrow('queue is down')

    const db = getDb()
    expect((await db.select({ n: count() }).from(ingress))[0].n).toBe(0)
    expect((await db.select({ n: count() }).from(task))[0].n).toBe(0)
    expect(await jobs()).toHaveLength(0)
  })

  it('lets the same delivery succeed once the queue is back', async () => {
    const broken = {
      ...queue,
      enqueueInTransaction: async () => {
        throw new Error('queue is down')
      },
    } as unknown as typeof queue
    await recordAndQueue(delivery('d-1'), broken).catch(() => {})

    const result = await recordAndQueue(delivery('d-1'), queue)

    expect(result.status).toBe('task_created')
    expect(await jobs()).toHaveLength(1)
  })
})
