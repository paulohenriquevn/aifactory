import type { Retryable } from '../../shared/panel'

import { quotaResumesAt } from './quota-reset'

/**
 * How many times in a row the factory runs again, on its own, a task that failed on the environment. Past
 * that the failure is not passing by itself, and it goes to a person.
 */
export const AUTOMATIC_RETRIES = 3

const ENVIRONMENT_WAIT_MS = 5 * 60_000
const QUOTA_UNKNOWN_WAIT_MS = 60 * 60_000
const AFTER_RESET_MS = 60_000

export type FailureToRetry = {
  retryable: Retryable
  failedAt: Date
  /** The instant the quota comes back, as the failure recorded it. */
  resumesAt?: string
  /** The agent's own words for it, for a failure recorded before the instant was. */
  resetsAt?: string
  /** Automatic runs since a person last started the task. */
  automaticRetries: number
}

/**
 * When a failed task runs again on its own, or nothing when it does not. A quota stop runs again once the
 * quota is back, however often that takes, because waiting is what fixes it. An environment failure runs
 * again with a doubling wait, a limited number of times. A failure of the work itself never does.
 */
export function retryAt(failure: FailureToRetry): Date | null {
  const failed = failure.failedAt.getTime()
  if (failure.retryable === 'quota') {
    const stored = failure.resumesAt ? new Date(failure.resumesAt) : undefined
    const resumes =
      stored && !Number.isNaN(stored.getTime())
        ? stored
        : quotaResumesAt(failure.resetsAt, failure.failedAt)
    return new Date(resumes ? resumes.getTime() + AFTER_RESET_MS : failed + QUOTA_UNKNOWN_WAIT_MS)
  }
  if (failure.retryable === 'environment' && failure.automaticRetries < AUTOMATIC_RETRIES) {
    return new Date(failed + ENVIRONMENT_WAIT_MS * 2 ** failure.automaticRetries)
  }
  return null
}
