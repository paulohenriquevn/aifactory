import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withLeaseHeartbeat } from './lease'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('withLeaseHeartbeat', () => {
  it('renews the lease for the configured seconds while the work runs', async () => {
    const extend = vi.fn(async () => {})
    const work = deferred()
    const run = withLeaseHeartbeat(extend, () => work.promise, { everyMs: 1_000, seconds: 90 })

    await vi.advanceTimersByTimeAsync(3_500)
    expect(extend).toHaveBeenCalledTimes(3)
    expect(extend).toHaveBeenCalledWith(90)

    work.resolve()
    await run
  })

  it('stops renewing once the work is done, and returns its result', async () => {
    const extend = vi.fn(async () => {})
    const result = await withLeaseHeartbeat(extend, async () => 'pushed', { everyMs: 1_000 })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(result).toBe('pushed')
    expect(extend).not.toHaveBeenCalled()
  })

  it('stops renewing, and still ends the timer, when the work throws', async () => {
    const extend = vi.fn(async () => {})
    const run = withLeaseHeartbeat(
      extend,
      async () => {
        throw new Error('sandbox failed')
      },
      { everyMs: 1_000 },
    )

    await expect(run).rejects.toThrow('sandbox failed')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(extend).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops renewing after a renewal fails, because the lease is gone', async () => {
    const extend = vi.fn(async () => {
      throw new Error('lease lost')
    })
    const work = deferred()
    const run = withLeaseHeartbeat(extend, () => work.promise, { everyMs: 1_000 })

    await vi.advanceTimersByTimeAsync(5_500)
    expect(extend).toHaveBeenCalledTimes(1)

    work.resolve()
    await run
  })
})
