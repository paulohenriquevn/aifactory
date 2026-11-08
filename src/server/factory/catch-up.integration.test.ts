import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, webhookRedelivery } from '../db/schema'
import type { HookDelivery } from '../github/app'

import { catchUp } from './catch-up'

const NOW = new Date('2026-11-04T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table webhook_redelivery, finding, agent_run, watch, delivery, decision, question, review, evidence, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

let nextId = 1
const delivery = (guid: string, statusCode: number, minutes: number): HookDelivery => ({
  id: String(nextId++),
  guid,
  deliveredAt: minutesAgo(minutes),
  statusCode,
  event: 'issues',
})

function fakeApp(list: HookDelivery[]) {
  const asked: string[] = []
  return {
    asked,
    app: {
      hookDeliveries: async () => list,
      redeliver: async (id: string) => void asked.push(id),
    },
  }
}

const run = (list: HookDelivery[]) => {
  const fake = fakeApp(list)
  return { fake, result: catchUp({ db: getDb(), app: fake.app, now: () => NOW }) }
}

describe('catching up on webhooks that did not get through', () => {
  it('asks again for a delivery that failed and was never recorded', async () => {
    const failed = delivery('g-1', 502, 30)
    const { fake, result } = run([failed])
    expect((await result).redelivered).toEqual(['g-1'])
    expect(fake.asked).toEqual([failed.id])
  })

  it('leaves alone one that was accepted, even when an earlier try of it failed', async () => {
    const { fake, result } = run([delivery('g-1', 200, 5), delivery('g-1', 502, 30)])
    expect((await result).redelivered).toEqual([])
    expect(fake.asked).toEqual([])
  })

  it('asks for a delivery once, using its newest failure', async () => {
    const older = delivery('g-1', 502, 40)
    const newer = delivery('g-1', 504, 10)
    const { fake, result } = run([newer, older])
    await result
    expect(fake.asked).toEqual([newer.id])
  })

  it('leaves alone a delivery the factory already recorded, and a failure from the last minute', async () => {
    await getDb().insert(ingress).values({
      deliveryId: 'g-1',
      event: 'issues',
      payload: {},
      outcome: 'ignored',
      code: 'c',
      reason: 'r',
    })
    const { fake, result } = run([delivery('g-1', 500, 30), delivery('g-2', 500, 0.5)])
    expect((await result).redelivered).toEqual([])
    expect(fake.asked).toEqual([])
  })

  it('ignores what GitHub no longer keeps, with a margin of three days', async () => {
    const { fake, result } = run([
      delivery('old', 502, 72 * 60 + 1),
      delivery('edge', 502, 72 * 60 - 1),
    ])
    expect((await result).redelivered).toEqual(['edge'])
    expect(fake.asked).toHaveLength(1)
  })

  it('stops after three asks for a delivery that keeps failing, and says it gave up', async () => {
    const stubborn = delivery('g-1', 401, 30)
    for (let i = 0; i < 3; i++) expect((await run([stubborn]).result).redelivered).toEqual(['g-1'])

    const fourth = run([stubborn])
    const outcome = await fourth.result
    expect(outcome).toEqual({ redelivered: [], gaveUp: ['g-1'], errors: [] })
    expect(fourth.fake.asked).toEqual([])
    const [row] = await getDb().select().from(webhookRedelivery)
    expect(row.attempts).toBe(3)
  })

  it('does nothing, and asks for nothing, when every delivery got through', async () => {
    const { fake, result } = run([delivery('g-1', 200, 5), delivery('g-2', 204, 9)])
    expect(await result).toEqual({ redelivered: [], gaveUp: [], errors: [] })
    expect(fake.asked).toEqual([])
  })

  it('goes on to the next delivery when GitHub refuses one, and reports the refusal', async () => {
    const first = delivery('g-1', 502, 30)
    const second = delivery('g-2', 502, 30)
    const asked: string[] = []
    const app = {
      hookDeliveries: async () => [first, second],
      redeliver: async (id: string) => {
        if (id === first.id) throw new Error('GitHub answered 404 redelivering')
        asked.push(id)
      },
    }

    const result = await catchUp({ db: getDb(), app, now: () => NOW })

    expect(asked).toEqual([second.id])
    expect(result.redelivered).toEqual(['g-2'])
    expect(result.errors).toEqual(['g-1: GitHub answered 404 redelivering'])
  })
})
