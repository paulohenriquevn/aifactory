import { describe, expect, it } from 'vitest'

import { checksFeedback, fixedBaseNote } from '../factory/ci-wait'
import { conflictNote } from './actions'
import { RETURNED_NOTE_MAX, returnedOf } from './returned'

const AT = new Date('2026-11-19T20:00:00.000Z')

const intake = (detail: Record<string, unknown>) => ({ stage: 'intake', detail, at: AT })
const handoff = (detail: Record<string, unknown>) => ({ stage: 'handoff', detail, at: AT })

describe('returnedOf: why a delivered task went back', () => {
  it('is nothing for a task that never left done, or that went on to its release', () => {
    expect(returnedOf(undefined, {})).toBeNull()
    expect(returnedOf({ stage: 'released', detail: {}, at: AT }, {})).toBeNull()
    expect(returnedOf({ stage: 'done', detail: {}, at: AT }, {})).toBeNull()
  })

  it('names a conflict with the base the integration branch moved to, with the note the run got', () => {
    const note = conflictNote('workspace')

    expect(returnedOf(intake({ decision: 'request_changes', automatic: true, note }), {})).toEqual({
      reason: 'base_conflict',
      at: AT.toISOString(),
      note,
    })
  })

  it('names a conflict when GitHub refused the merge and the run started over with no note', () => {
    const done = {
      integrationError:
        'GitHub answered 405 merging paulo/app#3: {"message":"Pull Request has merge conflicts"}',
    }

    expect(returnedOf(intake({ decision: 'retry', automatic: true, note: '' }), done)).toEqual({
      reason: 'base_conflict',
      at: AT.toISOString(),
      note: null,
    })
  })

  it('names a required check that failed on the pull request, which the run is told to fix', () => {
    const note = checksFeedback('abc1234def', [
      { name: 'CI', url: 'https://ci/1', state: 'failure', detail: '' },
    ])

    expect(
      returnedOf(intake({ decision: 'request_changes', automatic: true, note }), {})?.reason,
    ).toBe('ci_red')
  })

  it('names a base that failed the checks too and passes them now, which the run only merges', () => {
    const note = fixedBaseNote('workspace', ['CI'])

    expect(
      returnedOf(intake({ decision: 'request_changes', automatic: true, note }), {})?.reason,
    ).toBe('base_fixed')
  })

  it("names a person's request for changes as review, and a person's plain retry as other", () => {
    expect(
      returnedOf(intake({ decision: 'request_changes', note: 'Rename the flag' }), {}),
    ).toEqual({ reason: 'review', at: AT.toISOString(), note: 'Rename the flag' })
    expect(returnedOf(intake({ decision: 'retry', note: '' }), {})?.reason).toBe('other')
  })

  it('names a handoff after the automatic runs by its cause, and an older one by its reason', () => {
    expect(returnedOf(handoff({ cause: 'pull_conflict', reason: 'whatever it says' }), {})).toEqual(
      { reason: 'base_conflict', at: AT.toISOString(), note: 'whatever it says' },
    )
    expect(returnedOf(handoff({ cause: 'ci_red', reason: 'x' }), {})?.reason).toBe('ci_red')
    expect(returnedOf(handoff({ cause: 'base_fixed', reason: 'x' }), {})?.reason).toBe('base_fixed')
    expect(
      returnedOf(
        handoff({ reason: 'the pull request conflicts with its base after 3 automatic runs' }),
        {},
      )?.reason,
    ).toBe('base_conflict')
    expect(
      returnedOf(
        handoff({ reason: 'the required checks still fail after 3 automatic runs: CI' }),
        {},
      )?.reason,
    ).toBe('ci_red')
    expect(
      returnedOf(
        handoff({
          reason:
            'the integration branch passes CI again, and the pull request still has to merge it after 3 automatic runs',
        }),
        {},
      )?.reason,
    ).toBe('base_fixed')
    expect(
      returnedOf(handoff({ reason: 'auto-merge was turned off on the pull request' }), {})?.reason,
    ).toBe('other')
  })

  it('is other for anything it cannot tell, and never fails on a detail it does not expect', () => {
    expect(returnedOf({ stage: 'sandbox', detail: null, at: AT }, null)?.reason).toBe('other')
    expect(returnedOf({ stage: 'intake', detail: 'text', at: '2026-11-19T20:00:00Z' }, 7)).toEqual({
      reason: 'other',
      at: AT.toISOString(),
      note: null,
    })
  })

  it('cuts a long note, so a card does not carry a whole log', () => {
    const note = 'x'.repeat(RETURNED_NOTE_MAX + 50)

    const seen = returnedOf(intake({ decision: 'request_changes', note }), {})

    expect(seen?.note).toHaveLength(RETURNED_NOTE_MAX + 1)
    expect(seen?.note?.endsWith('…')).toBe(true)
  })
})
