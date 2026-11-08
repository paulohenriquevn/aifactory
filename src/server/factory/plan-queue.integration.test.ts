import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { plan } from '../db/schema'

import { jobBackend } from './job-backend'
import { inTransactionForPlan } from './resume-queue'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await jobBackend().migrate()
})
beforeEach(async () => {
  await getPool().query('truncate table plan_item, plan, theokit_jobs restart identity cascade')
})
afterAll(() => getStorageManager().dispose())

const jobs = async () =>
  (
    await getPool().query<{ name: string; input: { planId: number } }>(
      "select name, input from theokit_jobs where name = 'plan-run'",
    )
  ).rows

describe('queueing a plan', () => {
  it('commits the plan and its plan-run job together', async () => {
    const id = await inTransactionForPlan(async (tx, enqueuePlan) => {
      const [row] = await tx
        .insert(plan)
        .values({ repository: 'o/r', goal: 'Add a command line' })
        .returning({ id: plan.id })
      await enqueuePlan(row.id)
      return row.id
    })

    expect((await jobs()).map((j) => j.input.planId)).toEqual([id])
    expect(await getDb().select().from(plan)).toHaveLength(1)
  })

  it('leaves neither behind when the transaction fails after queueing', async () => {
    await expect(
      inTransactionForPlan(async (tx, enqueuePlan) => {
        const [row] = await tx
          .insert(plan)
          .values({ repository: 'o/r', goal: 'Add a command line' })
          .returning({ id: plan.id })
        await enqueuePlan(row.id)
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')

    expect(await jobs()).toEqual([])
    expect(await getDb().select().from(plan)).toEqual([])
  })
})
