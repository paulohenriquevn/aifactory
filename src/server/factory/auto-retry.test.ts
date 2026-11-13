import { describe, expect, it } from 'vitest'

import { rerunsAfterConflict, retryAt } from './auto-retry'
import { AUTOMATIC_RETRIES } from './transitions'

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

describe('when a finished task whose pull request conflicts with its base runs again on its own', () => {
  const conflict =
    'GitHub answered 405 merging usetheokit/theokit#1475: {"message":"Pull Request has merge conflicts","status":"405"}'

  it('runs again a task GitHub refused to merge because the pull request conflicts with its base', () => {
    expect(rerunsAfterConflict(conflict, 0)).toBe(true)
  })

  it('runs it again up to the same limit as an environment failure', () => {
    expect(rerunsAfterConflict(conflict, AUTOMATIC_RETRIES - 1)).toBe(true)
  })

  it('leaves it to a person once it conflicted again after every automatic run', () => {
    expect(rerunsAfterConflict(conflict, AUTOMATIC_RETRIES)).toBe(false)
  })

  it('leaves to a person a merge GitHub refused for another reason', () => {
    expect(
      rerunsAfterConflict(
        'GitHub answered 405 merging a/b#3: {"message":"Required status check is expected"}',
        0,
      ),
    ).toBe(false)
  })

  it('does nothing for a task whose integration recorded no error', () => {
    expect(rerunsAfterConflict(undefined, 0)).toBe(false)
  })

  it('reads only a recorded message: a stored value of another shape holding the same words is not a refusal', () => {
    expect(rerunsAfterConflict(['Pull Request has merge conflicts'], 0)).toBe(false)
  })
})

describe('when a task blocked by an open issue runs again', () => {
  it('checks again half an hour later, however many times it already has', () => {
    for (const automaticRetries of [0, AUTOMATIC_RETRIES, 40]) {
      expect(iso(retryAt({ retryable: 'blocked', failedAt, automaticRetries }))).toBe(
        '2026-11-06T00:43:00.000Z',
      )
    }
  })
})
