import { describe, expect, it } from 'vitest'

import { isWorkerOnly } from './worker-only'

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
