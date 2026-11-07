import { describe, expect, it } from 'vitest'

import { isWorkerOnly, mainProcessCronLock, mainProcessOnly } from './worker-only'

describe('isWorkerOnly', () => {
  it('is on only for FACTORY_WORKER_ONLY=1', () => {
    expect(isWorkerOnly({ FACTORY_WORKER_ONLY: '1' })).toBe(true)
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(isWorkerOnly({ FACTORY_WORKER_ONLY: value }), String(value)).toBe(false)
    }
    expect(isWorkerOnly({})).toBe(false)
  })

  it('reads the process environment by default', () => {
    expect(isWorkerOnly()).toBe(process.env.FACTORY_WORKER_ONLY === '1')
  })
})

describe('mainProcessOnly', () => {
  it('runs the handler and returns what it returns in the main process', async () => {
    let ran = 0
    const run = mainProcessOnly(async () => (ran += 1), {})
    expect(await run()).toBe(1)
    expect(ran).toBe(1)
  })

  it('does not run the handler in a worker-only process', async () => {
    let ran = 0
    const run = mainProcessOnly(async () => (ran += 1), { FACTORY_WORKER_ONLY: '1' })
    expect(await run()).toBeUndefined()
    expect(ran).toBe(0)
  })

  it('lets the error of the handler through', async () => {
    const run = mainProcessOnly(async () => {
      throw new Error('boom')
    }, {})
    await expect(run()).rejects.toThrow('boom')
  })
})

describe('mainProcessCronLock', () => {
  const tick = new Date('2026-11-07T13:50:00Z')
  const shared = () => {
    const asked: string[] = []
    return {
      asked,
      lock: {
        acquire: async (name: string, at: Date) => {
          asked.push(`${name}@${at.toISOString()}`)
          return true
        },
      },
    }
  }

  it('never takes a tick in a worker-only process, so it cannot leave the main process without it', async () => {
    const { asked, lock } = shared()
    const ours = mainProcessCronLock(lock, { FACTORY_WORKER_ONLY: '1' })
    expect(await ours.acquire('knowledge-sync', tick)).toBe(false)
    expect(asked).toEqual([])
  })

  it('asks the shared lock in the main process, so two of them still fire a tick once', async () => {
    const { asked, lock } = shared()
    const ours = mainProcessCronLock(lock, {})
    expect(await ours.acquire('knowledge-sync', tick)).toBe(true)
    expect(asked).toEqual(['knowledge-sync@2026-11-07T13:50:00.000Z'])
  })

  it('says no when the shared lock says no', async () => {
    const ours = mainProcessCronLock({ acquire: async () => false }, {})
    expect(await ours.acquire('supervise', tick)).toBe(false)
  })
})
