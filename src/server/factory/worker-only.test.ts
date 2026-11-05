import { describe, expect, it } from 'vitest'

import { isWorkerOnly, mainProcessOnly } from './worker-only'

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
