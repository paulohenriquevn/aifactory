import type { Retryable } from '../../shared/panel'

import { quotaResumesAt } from './quota-reset'
import { automaticRunsLeft } from './transitions'

const ENVIRONMENT_WAIT_MS = 5 * 60_000
const QUOTA_UNKNOWN_WAIT_MS = 60 * 60_000
/** How often a task blocked by an open issue checks again. The check reads issues, before any sandbox. */
const BLOCKED_WAIT_MS = 30 * 60_000
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
 * quota is back, and a task blocked by an open issue every half hour, however often that takes, because
 * waiting is what fixes them. An environment failure runs
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
  // Waiting is what unblocks it, so it is not limited like an environment failure.
  if (failure.retryable === 'blocked') return new Date(failed + BLOCKED_WAIT_MS)
  if (failure.retryable === 'environment' && automaticRunsLeft(failure.automaticRetries)) {
    return new Date(failed + ENVIRONMENT_WAIT_MS * 2 ** failure.automaticRetries)
  }
  return null
}

/** GitHub's refusal to merge a pull request that conflicts with its base, as the integration records it. */
const MERGE_CONFLICT = /Pull Request has merge conflicts/

/**
 * Whether a task the factory finished, but whose pull request GitHub refused to merge because it conflicts
 * with its base, runs again on its own. Its work started from a base that has moved since (another task
 * merged first), and starting again from the new one is what a person would do. It is limited like an
 * environment failure, so a pull request that conflicts every time goes to a person.
 */
export function rerunsAfterConflict(integrationError: unknown, automaticRetries: number): boolean {
  return (
    typeof integrationError === 'string' &&
    MERGE_CONFLICT.test(integrationError) &&
    automaticRunsLeft(automaticRetries)
  )
}
