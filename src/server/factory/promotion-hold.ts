import type { OpenPullRequest, PullRequestDetail } from '../github/pulls'

import { PRE_RELEASE_BRANCH } from './branches'

/**
 * The promotion of the integration branch into the pre-release branch through pinned auto-merge (ADR 0010,
 * section 3), as decisions over what was read. Nothing here reads or writes: `promotion-merge.ts` does.
 */

/**
 * How long new integrations are held out of the integration branch while its promotion waits for the
 * pre-release branch's required checks. The longest of them took a little over 30 minutes on the largest
 * repository when ADR 0010 was written, and every integration in that window would restart them.
 */
export const PROMOTION_HOLD_MS = 45 * 60_000

/**
 * The hold the factory applies: `FACTORY_PROMOTION_HOLD_MS` when set, `PROMOTION_HOLD_MS` otherwise. Zero turns
 * it off, for an owner who integrates fast and fixes the promotion on its way to develop: the promotion's checks
 * then start again on each new head, and develop advances less often.
 */
export function promotionHoldMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FACTORY_PROMOTION_HOLD_MS
  if (raw === undefined) return PROMOTION_HOLD_MS
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `FACTORY_PROMOTION_HOLD_MS must be a whole number of milliseconds, got ${JSON.stringify(raw)}`,
    )
  }
  return Number(raw)
}

/**
 * Whether a pull request is the factory's promotion, the only one auto-merge is turned on for: from the
 * integration branch of the same repository (never a fork, never another head) into the pre-release branch.
 */
export const isFactoryPromotion = (
  pull: Pick<OpenPullRequest, 'headRepo' | 'headRef' | 'baseRef'>,
  repository: string,
  integration: string,
): boolean =>
  pull.headRepo?.toLowerCase() === repository.toLowerCase() &&
  pull.headRef === integration &&
  pull.baseRef === PRE_RELEASE_BRANCH

/** A promotion as the hold reads it. */
export type HeldBy = { status: 'waiting' | 'merged' | 'closed'; holdUntil: Date }

/** Whether a promotion still holds new integrations out: it waits, and its hold has not expired. */
export const holdsIntegrations = (
  wait: HeldBy | undefined,
  now: Date,
  holdMs: number = promotionHoldMs(),
): boolean => holdMs > 0 && wait?.status === 'waiting' && now.getTime() < wait.holdUntil.getTime()

/**
 * The hold of a promotion pinned now: the one that still runs, so pinning a new head never extends it, or a
 * new one of the configured hold once the last expired.
 */
export const nextHoldUntil = (
  wait: HeldBy | undefined,
  now: Date,
  holdMs: number = promotionHoldMs(),
): Date =>
  wait && holdsIntegrations(wait, now, holdMs) ? wait.holdUntil : new Date(now.getTime() + holdMs)

/** What a pass does with a waiting promotion. */
export type PromotionStep =
  | { kind: 'merged' }
  | { kind: 'closed' }
  /** The head moved after the factory looked: auto-merge is pinned again, to the new head. */
  | { kind: 'repin'; sha: string }
  | { kind: 'wait' }

/** The next step for a promotion whose auto-merge was pinned to `sha`, given how its pull request stands. */
export function decidePromotionWait(sha: string, pull: PullRequestDetail): PromotionStep {
  if (pull.merged) return { kind: 'merged' }
  if (pull.state === 'closed') return { kind: 'closed' }
  if (pull.headSha !== sha) return { kind: 'repin', sha: pull.headSha }
  return { kind: 'wait' }
}
