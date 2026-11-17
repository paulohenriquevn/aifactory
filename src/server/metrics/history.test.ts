import { describe, expect, it } from 'vitest'

import { observe, type HistoryEvent, type TaskHistory } from './history'

const T0 = Date.parse('2026-11-10T10:00:00Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000)
const ev = (
  minutes: number,
  stage: HistoryEvent['stage'],
  detail: Record<string, unknown> | null = null,
) => ({
  stage,
  at: at(minutes),
  detail,
})

function history(over: Partial<TaskHistory> = {}): TaskHistory {
  return {
    repository: 'o/r',
    createdAt: at(0),
    events: [],
    reviews: [],
    evidence: [],
    releaseWentRed: false,
    ...over,
  }
}

/** A run that verifies once, green, is approved and delivered for 0.40 at minute 30. */
const delivered = history({
  events: [
    ev(0, 'intake'),
    ev(1, 'sandbox'),
    ev(2, 'build', { attempt: 1 }),
    ev(10, 'push'),
    ev(11, 'verify', { sha: 'a1' }),
    ev(20, 'review', { sha: 'a1' }),
    ev(30, 'done', { sha: 'a1', costUsd: 0.4, mergedSha: 'm1' }),
  ],
  evidence: [
    { sha: 'a1', passed: true, at: at(19) },
    { sha: 'a1', passed: true, at: at(19) },
  ],
  reviews: [{ verdict: 'approve', at: at(25) }],
})

const value = (h: TaskHistory, metric: string) =>
  observe(h)
    .filter((o) => o.metric === metric)
    .map((o) => o.value)

describe('observe', () => {
  it('measures a delivered run, dated when it ended, for its repository', () => {
    expect(observe(delivered)).toEqual(
      expect.arrayContaining([
        { metric: 'first_pass_checks', repository: 'o/r', at: at(30), value: 1 },
        { metric: 'rework_rounds', repository: 'o/r', at: at(30), value: 0 },
        { metric: 'first_review_approval', repository: 'o/r', at: at(30), value: 1 },
        { metric: 'minutes_to_first_review', repository: 'o/r', at: at(30), value: 25 },
        { metric: 'minutes_to_delivery', repository: 'o/r', at: at(30), value: 30 },
        { metric: 'cost_per_delivery', repository: 'o/r', at: at(30), value: 0.4 },
        { metric: 'change_failure', repository: 'o/r', at: at(30), value: 0 },
      ]),
    )
    expect(observe(delivered)).toHaveLength(7)
  })

  it('counts the first verification as red when any of its checks failed', () => {
    const h = history({
      ...delivered,
      evidence: [
        { sha: 'a1', passed: true, at: at(19) },
        { sha: 'a1', passed: false, at: at(19) },
      ],
    })
    expect(value(h, 'first_pass_checks')).toEqual([0])
  })

  it('reads only the first verification of the run, and only evidence of its commit', () => {
    const h = history({
      events: [
        ev(0, 'intake'),
        ev(11, 'verify', { sha: 'a1' }),
        ev(20, 'build', { rework: true }),
        ev(25, 'verify', { sha: 'a2' }),
        ev(30, 'done', { costUsd: 1 }),
      ],
      evidence: [
        { sha: 'a1', passed: false, at: at(19) },
        { sha: 'a2', passed: true, at: at(28) },
        { sha: 'zz', passed: true, at: at(12) },
      ],
    })
    expect(value(h, 'first_pass_checks')).toEqual([0])
    expect(value(h, 'rework_rounds')).toEqual([1])
  })

  it('leaves out evidence of the same commit from a later verification', () => {
    const h = history({
      events: [
        ev(0, 'intake'),
        ev(11, 'verify', { sha: 'a1' }),
        ev(20, 'verify', { sha: 'a1' }),
        ev(30, 'done', {}),
      ],
      evidence: [
        { sha: 'a1', passed: true, at: at(15) },
        { sha: 'a1', passed: false, at: at(25) },
      ],
    })
    expect(value(h, 'first_pass_checks')).toEqual([1])
  })

  it('makes no first-pass point for a run whose first verification left no evidence', () => {
    const h = history({
      events: [ev(0, 'intake'), ev(11, 'verify', { sha: 'a1' }), ev(30, 'failed', {})],
    })
    expect(value(h, 'first_pass_checks')).toEqual([])
  })

  it('counts each rework the run went through', () => {
    const h = history({
      events: [
        ev(0, 'intake'),
        ev(2, 'build', { attempt: 1 }),
        ev(12, 'build', { rework: true }),
        ev(22, 'build', { rework: true }),
        ev(30, 'failed', { error: 'no time left' }),
      ],
    })
    expect(value(h, 'rework_rounds')).toEqual([2])
  })

  it('makes no rework point for a run that never built', () => {
    const h = history({ events: [ev(0, 'intake'), ev(1, 'failed', { error: 'quota' })] })
    expect(value(h, 'rework_rounds')).toEqual([])
  })

  it('reads the first review of the run: changes asked is not an approval', () => {
    const h = history({
      ...delivered,
      reviews: [
        { verdict: 'changes', at: at(21) },
        { verdict: 'approve', at: at(28) },
      ],
    })
    expect(value(h, 'first_review_approval')).toEqual([0])
    expect(value(h, 'minutes_to_first_review')).toEqual([21])
  })

  it('splits a task into runs at each intake and measures each one alone', () => {
    const h = history({
      events: [
        ev(0, 'intake'),
        ev(5, 'verify', { sha: 'a1' }),
        ev(10, 'failed', { error: 'checks' }),
        ev(100, 'intake'),
        ev(105, 'verify', { sha: 'b1' }),
        ev(130, 'done', { costUsd: 0.2 }),
      ],
      evidence: [
        { sha: 'a1', passed: false, at: at(8) },
        { sha: 'b1', passed: true, at: at(110) },
      ],
      reviews: [
        { verdict: 'changes', at: at(9) },
        { verdict: 'approve', at: at(120) },
      ],
    })
    expect(observe(h).filter((o) => o.metric === 'first_pass_checks')).toEqual([
      { metric: 'first_pass_checks', repository: 'o/r', at: at(10), value: 0 },
      { metric: 'first_pass_checks', repository: 'o/r', at: at(130), value: 1 },
    ])
    expect(value(h, 'first_review_approval')).toEqual([0, 1])
    expect(value(h, 'minutes_to_first_review')).toEqual([9, 20])
    expect(value(h, 'minutes_to_delivery')).toEqual([30])
    expect(value(h, 'cost_per_delivery')).toEqual([0.2])
  })

  it('says a delivery failed when the task came back to a new run after it', () => {
    const h = history({
      events: [
        ev(0, 'intake'),
        ev(30, 'done', { costUsd: 0.1 }),
        ev(60, 'intake'),
        ev(90, 'done', {}),
      ],
    })
    expect(value(h, 'change_failure')).toEqual([1, 0])
  })

  it('measures a cancelled run as a run that ended, and never as a delivery', () => {
    const h = history({
      events: [ev(0, 'intake'), ev(2, 'build', { attempt: 1 }), ev(9, 'cancelled', {})],
    })
    expect(observe(h)).toEqual([
      { metric: 'rework_rounds', repository: 'o/r', at: at(9), value: 0 },
    ])
  })

  it('does not say a delivery failed because the task was cancelled after it', () => {
    const h = history({ events: [ev(0, 'intake'), ev(30, 'done', {}), ev(60, 'cancelled', {})] })
    expect(value(h, 'change_failure')).toEqual([0])
    expect(value(h, 'minutes_to_delivery')).toEqual([30])
  })

  it('says a delivery failed when it was handed to a person after it', () => {
    const h = history({ events: [ev(0, 'intake'), ev(30, 'done', {}), ev(60, 'handoff', {})] })
    expect(value(h, 'change_failure')).toEqual([1])
    const failedAfter = history({
      events: [ev(0, 'intake'), ev(30, 'done', {}), ev(60, 'failed', {})],
    })
    expect(value(failedAfter, 'change_failure')).toEqual([1])
  })

  it('does not count a second done, or a release, as the delivery coming back', () => {
    const h = history({
      events: [
        ev(0, 'intake'),
        ev(30, 'done', {}),
        ev(40, 'done', { mergedSha: 'm' }),
        ev(50, 'released', {}),
      ],
    })
    expect(value(h, 'change_failure')).toEqual([0])
    expect(value(h, 'minutes_to_delivery')).toEqual([30])
  })

  it('says the last delivery failed when its release went red', () => {
    const h = history({
      releaseWentRed: true,
      events: [ev(0, 'intake'), ev(30, 'done', {}), ev(60, 'intake'), ev(90, 'done', {})],
    })
    expect(value(h, 'change_failure')).toEqual([1, 1])
  })

  it('measures nothing about a run still going', () => {
    const h = history({ events: [ev(0, 'intake'), ev(5, 'verify', { sha: 'a1' })] })
    expect(observe(h)).toEqual([])
  })

  it('measures nothing about a run that waited for another issue instead of working', () => {
    const h = history({
      events: [
        ev(0, 'intake'),
        ev(1, 'failed', { error: 'blocked by o/r#1', blockedBy: ['o/r#1'] }),
      ],
    })
    expect(observe(h)).toEqual([])
  })

  it('makes no cost point for a delivery that reported none', () => {
    const h = history({ events: [ev(0, 'intake'), ev(30, 'done', {})] })
    expect(value(h, 'cost_per_delivery')).toEqual([])
  })

  it('measures the hours from the task to its first release, once', () => {
    const h = history({
      events: [
        ev(0, 'intake'),
        ev(30, 'done', {}),
        ev(180, 'released', {}),
        ev(240, 'released', {}),
      ],
    })
    expect(observe(h).filter((o) => o.metric === 'hours_to_release')).toEqual([
      { metric: 'hours_to_release', repository: 'o/r', at: at(180), value: 3 },
    ])
  })

  it('reads evidence only of the first commit verified, whatever the others say', () => {
    const h = history({
      events: [ev(0, 'intake'), ev(11, 'verify', { sha: 'a1' }), ev(30, 'done', {})],
      evidence: [
        { sha: 'a1', passed: true, at: at(15) },
        { sha: 'zz', passed: false, at: at(15) },
      ],
    })
    expect(value(h, 'first_pass_checks')).toEqual([1])
  })

  it('reads evidence from the moment of the verification until the next one, not before', () => {
    const h = history({
      events: [
        ev(0, 'intake'),
        ev(11, 'verify', { sha: 'a1' }),
        ev(20, 'verify', { sha: 'a1' }),
        ev(30, 'done', {}),
      ],
      evidence: [
        { sha: 'a1', passed: false, at: at(5) },
        { sha: 'a1', passed: true, at: at(11) },
        { sha: 'a1', passed: false, at: at(20) },
      ],
    })
    expect(value(h, 'first_pass_checks')).toEqual([1])
  })

  it('makes no first-pass point for a run that never verified, even with evidence around', () => {
    const h = history({
      events: [ev(0, 'intake'), ev(30, 'failed', {})],
      evidence: [{ sha: 'a1', passed: true, at: at(10) }],
    })
    expect(value(h, 'first_pass_checks')).toEqual([])
  })

  it('makes no first-pass point for a verification that names no commit', () => {
    const h = history({
      events: [ev(0, 'intake'), ev(11, 'verify'), ev(30, 'done', {})],
      evidence: [{ sha: 'a1', passed: true, at: at(15) }],
    })
    expect(value(h, 'first_pass_checks')).toEqual([])
  })

  it('reads a build without detail as a first build', () => {
    const h = history({ events: [ev(0, 'intake'), ev(2, 'build'), ev(30, 'failed', {})] })
    expect(value(h, 'rework_rounds')).toEqual([0])
  })

  it('gives a run only the reviews made while it lasted, from its first moment', () => {
    const h = history({
      events: [ev(0, 'intake'), ev(10, 'failed', {}), ev(100, 'intake'), ev(130, 'done', {})],
      reviews: [
        { verdict: 'approve', at: at(100) },
        { verdict: 'changes', at: at(120) },
      ],
    })
    expect(value(h, 'first_review_approval')).toEqual([1])
    expect(value(h, 'minutes_to_first_review')).toEqual([0])
  })

  it('measures a run that starts with its delivery', () => {
    const h = history({ events: [ev(0, 'done', { costUsd: 0.3 })] })
    expect(value(h, 'minutes_to_delivery')).toEqual([0])
    expect(value(h, 'cost_per_delivery')).toEqual([0.3])
  })

  it('makes no cost point for a delivery without detail, or with a cost that is not a number', () => {
    const bare = history({ events: [ev(0, 'intake'), ev(30, 'done')] })
    const odd = history({ events: [ev(0, 'intake'), ev(30, 'done', { costUsd: null })] })
    expect(value(bare, 'cost_per_delivery')).toEqual([])
    expect(value(odd, 'cost_per_delivery')).toEqual([])
  })

  it('does not count what happened before the delivery as the delivery coming back', () => {
    const h = history({ events: [ev(0, 'intake'), ev(10, 'failed', {}), ev(30, 'done', {})] })
    expect(value(h, 'change_failure')).toEqual([0])
  })

  it('measures nothing about a run still going, however far it got', () => {
    const h = history({
      events: [ev(0, 'intake'), ev(2, 'build'), ev(5, 'verify', { sha: 'a1' })],
      evidence: [{ sha: 'a1', passed: true, at: at(6) }],
      reviews: [{ verdict: 'approve', at: at(7) }],
    })
    expect(observe(h)).toEqual([])
  })

  it('measures nothing about a run that ended waiting for another issue, whatever it did before', () => {
    const h = history({
      events: [
        ev(0, 'intake'),
        ev(2, 'build'),
        ev(3, 'failed', { error: 'blocked by o/r#1', blockedBy: ['o/r#1'] }),
      ],
    })
    expect(observe(h)).toEqual([])
  })

  it('measures a run that failed without saying why', () => {
    const h = history({ events: [ev(0, 'intake'), ev(2, 'build'), ev(3, 'failed')] })
    expect(value(h, 'rework_rounds')).toEqual([0])
  })

  it('starts the first run at the first event when the task has no intake', () => {
    const h = history({ events: [ev(5, 'build', {}), ev(35, 'done', {})] })
    expect(value(h, 'minutes_to_delivery')).toEqual([30])
  })
})
