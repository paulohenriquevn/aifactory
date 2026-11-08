import { describe, expect, it } from 'vitest'

import { AUTOMATIC_RETRIES, retryAt } from './auto-retry'

const failedAt = new Date('2026-11-06T00:13:00Z')
const iso = (d: Date | null) => d?.toISOString() ?? null

describe('when a failed task runs again on its own', () => {
  it('runs a quota stop again a minute after the quota comes back', () => {
    const at = retryAt({
      retryable: 'quota',
      failedAt,
      resumesAt: '2026-11-06T03:39:00.000Z',
      automaticRetries: 0,
    })
    expect(iso(at)).toBe('2026-11-06T03:40:00.000Z')
  })

  it('reads the instant from the agent words of a failure recorded before it was stored', () => {
    const at = retryAt({ retryable: 'quota', failedAt, resetsAt: '3:39 AM', automaticRetries: 0 })
    expect(iso(at)).toBe('2026-11-06T03:40:00.000Z')
  })

  it('waits an hour for a quota stop that did not say when it comes back', () => {
    const at = retryAt({ retryable: 'quota', failedAt, automaticRetries: 5 })
    expect(iso(at)).toBe('2026-11-06T01:13:00.000Z')
  })

  it('backs off an environment failure, doubling the wait each time', () => {
    const waits = [0, 1, 2].map((automaticRetries) =>
      iso(retryAt({ retryable: 'environment', failedAt, automaticRetries })),
    )
    expect(waits).toEqual([
      '2026-11-06T00:18:00.000Z',
      '2026-11-06T00:23:00.000Z',
      '2026-11-06T00:33:00.000Z',
    ])
  })

  it('leaves an environment failure to a person once it failed again after every retry', () => {
    expect(
      retryAt({ retryable: 'environment', failedAt, automaticRetries: AUTOMATIC_RETRIES }),
    ).toBeNull()
  })

  it('never runs again on its own a failure of the work itself', () => {
    expect(retryAt({ retryable: null, failedAt, automaticRetries: 0 })).toBeNull()
  })
})
