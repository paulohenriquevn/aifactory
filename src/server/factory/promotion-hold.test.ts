import { describe, expect, it } from 'vitest'

import type { PullRequestDetail } from '../github/pulls'

import {
  decidePromotionWait,
  holdsIntegrations,
  isFactoryPromotion,
  nextHoldUntil,
  PROMOTION_HOLD_MS,
  promotionHoldMs,
} from './promotion-hold'

const REPO = 'paulo/app'
const NOW = new Date('2026-11-16T12:00:00Z')
const later = (ms: number) => new Date(NOW.getTime() + ms)

const promotion = { headRepo: REPO, headRef: 'workspace', baseRef: 'develop' }

describe('isFactoryPromotion', () => {
  it('takes the pull request from the integration branch into develop of the same repository', () => {
    expect(isFactoryPromotion(promotion, REPO, 'workspace')).toBe(true)
  })

  it('takes it whatever the letter case GitHub gives the repository name', () => {
    expect(isFactoryPromotion({ ...promotion, headRepo: 'Paulo/App' }, REPO, 'workspace')).toBe(
      true,
    )
  })

  it('never takes a pull request from a fork', () => {
    expect(isFactoryPromotion({ ...promotion, headRepo: 'someone/app' }, REPO, 'workspace')).toBe(
      false,
    )
  })

  it('never takes a pull request whose fork was deleted', () => {
    expect(isFactoryPromotion({ ...promotion, headRepo: undefined }, REPO, 'workspace')).toBe(false)
  })

  it('never takes a pull request from another branch', () => {
    expect(isFactoryPromotion({ ...promotion, headRef: 'feature' }, REPO, 'workspace')).toBe(false)
  })

  it('never takes a pull request into another base', () => {
    expect(isFactoryPromotion({ ...promotion, baseRef: 'main' }, REPO, 'workspace')).toBe(false)
  })

  it('follows the integration branch the repository names', () => {
    expect(isFactoryPromotion({ ...promotion, headRef: 'trunk' }, REPO, 'trunk')).toBe(true)
  })
})

describe('holdsIntegrations', () => {
  it('holds while a waiting promotion is before its hold', () => {
    expect(holdsIntegrations({ status: 'waiting', holdUntil: later(1) }, NOW)).toBe(true)
  })

  it('holds nothing once the hold is reached', () => {
    expect(holdsIntegrations({ status: 'waiting', holdUntil: NOW }, NOW)).toBe(false)
  })

  it('holds nothing past the hold', () => {
    expect(holdsIntegrations({ status: 'waiting', holdUntil: later(-1) }, NOW)).toBe(false)
  })

  it('holds nothing for a promotion that merged', () => {
    expect(holdsIntegrations({ status: 'merged', holdUntil: later(60_000) }, NOW)).toBe(false)
  })

  it('holds nothing without a promotion', () => {
    expect(holdsIntegrations(undefined, NOW)).toBe(false)
  })
})

describe('nextHoldUntil', () => {
  it('starts a hold of PROMOTION_HOLD_MS without a promotion', () => {
    expect(nextHoldUntil(undefined, NOW)).toEqual(later(PROMOTION_HOLD_MS))
  })

  it('keeps a hold that still runs, so a new pin never extends it', () => {
    const wait = { status: 'waiting' as const, holdUntil: later(5_000) }
    expect(nextHoldUntil(wait, NOW)).toEqual(later(5_000))
  })

  it('starts a new hold once the last one expired', () => {
    const wait = { status: 'waiting' as const, holdUntil: later(-5_000) }
    expect(nextHoldUntil(wait, NOW)).toEqual(later(PROMOTION_HOLD_MS))
  })

  it('holds long enough for checks of 30 minutes, and under two hours', () => {
    expect(PROMOTION_HOLD_MS).toBeGreaterThanOrEqual(30 * 60_000)
    expect(PROMOTION_HOLD_MS).toBeLessThan(2 * 60 * 60_000)
  })
})

describe('decidePromotionWait', () => {
  const pull = (over: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
    number: 13,
    url: 'u',
    state: 'open',
    merged: false,
    headSha: 'h1',
    autoMerge: true,
    mergeableState: 'blocked',
    ...over,
  })

  it('ends the wait when GitHub merged the promotion', () => {
    expect(decidePromotionWait('h1', pull({ state: 'closed', merged: true }))).toEqual({
      kind: 'merged',
    })
  })

  it('ends the wait when the promotion was closed without a merge', () => {
    expect(decidePromotionWait('h1', pull({ state: 'closed' }))).toEqual({ kind: 'closed' })
  })

  it('pins auto-merge again to a head that moved after the factory looked', () => {
    expect(decidePromotionWait('h1', pull({ headSha: 'h2' }))).toEqual({
      kind: 'repin',
      sha: 'h2',
    })
  })

  it('waits while the pinned head is the head', () => {
    expect(decidePromotionWait('h1', pull())).toEqual({ kind: 'wait' })
  })
})

describe('promotionHoldMs', () => {
  it('is PROMOTION_HOLD_MS when the environment says nothing', () => {
    expect(promotionHoldMs({})).toBe(PROMOTION_HOLD_MS)
  })

  it('takes the milliseconds FACTORY_PROMOTION_HOLD_MS names', () => {
    expect(promotionHoldMs({ FACTORY_PROMOTION_HOLD_MS: '600000' })).toBe(600_000)
  })

  it('takes zero, which turns the hold off', () => {
    expect(promotionHoldMs({ FACTORY_PROMOTION_HOLD_MS: '0' })).toBe(0)
  })

  it.each(['-1', 'ten', '1.5', ''])('refuses %j, naming the variable', (value) => {
    expect(() => promotionHoldMs({ FACTORY_PROMOTION_HOLD_MS: value })).toThrow(
      /FACTORY_PROMOTION_HOLD_MS/,
    )
  })
})

describe('a hold turned off', () => {
  // The owner's flow integrates fast and fixes the promotion on its way to develop: with the hold on, a
  // promotion of usetheokit/theokit held 26 approved tasks out of workspace in two hours (2026-11-19), and
  // the ones still waiting when it ended conflicted with the moved branch and went back to the queue.
  it('holds nothing, even a promotion pinned before it was turned off', () => {
    const wait = { status: 'waiting' as const, holdUntil: later(PROMOTION_HOLD_MS) }

    expect(holdsIntegrations(wait, NOW, 0)).toBe(false)
  })

  it('starts no hold for a new pin', () => {
    expect(
      holdsIntegrations({ status: 'waiting', holdUntil: nextHoldUntil(undefined, NOW, 0) }, NOW, 0),
    ).toBe(false)
  })
})
