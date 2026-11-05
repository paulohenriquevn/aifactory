import type { SandboxBackend } from '@theokit/agents/sandbox'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { pushWithRetry } from './run-support'

const failing = (times: number) => {
  let calls = 0
  const backend = {
    execute: async () => {
      calls += 1
      return calls <= times
        ? { exitCode: 1, stdout: '', stderr: 'remote: Internal Server Error' }
        : { exitCode: 0, stdout: 'ok', stderr: '' }
    },
  } as unknown as SandboxBackend
  return { backend, calls: () => calls }
}

afterEach(() => vi.restoreAllMocks())

describe('pushWithRetry', () => {
  it('waits twice as long after each failure, so a GitHub incident of a few minutes is outlasted', async () => {
    const delays: number[] = []
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      fn()
      return 0
    }) as unknown as typeof setTimeout)
    const { backend, calls } = failing(5)

    await pushWithRetry(backend, 'git push', 5_000)

    expect(calls()).toBe(6)
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000])
  })

  it('gives up after six tries with the last error', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn()
      return 0
    }) as unknown as typeof setTimeout)
    const { backend, calls } = failing(99)

    await expect(pushWithRetry(backend, 'git push', 1)).rejects.toThrow(/Internal Server Error/)
    expect(calls()).toBe(6)
  })

  it('does not wait when the first push works', async () => {
    const wait = vi.spyOn(globalThis, 'setTimeout')
    const { backend, calls } = failing(0)
    await pushWithRetry(backend, 'git push', 5_000)
    expect(calls()).toBe(1)
    expect(wait).not.toHaveBeenCalled()
  })
})
