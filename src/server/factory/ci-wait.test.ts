import { describe, expect, it } from 'vitest'

import type { CheckReport, PullRequestDetail } from '../github/pulls'

import { AUTOMATIC_RETRIES } from './auto-retry'
import { CI_SILENCE_MS, checksFeedback, decideWaitingIntegration } from './ci-wait'

const VERIFIED = 'abc1234def'
const open: PullRequestDetail = {
  number: 12,
  url: 'https://github.com/o/r/pull/12',
  state: 'open',
  merged: false,
  headSha: VERIFIED,
  autoMerge: true,
  mergeableState: 'blocked',
}
const report = (name: string, state: CheckReport['state'], detail = ''): CheckReport => ({
  name,
  state,
  detail,
  url: `https://github.com/o/r/runs/${name}`,
})

const decide = (over: Partial<Parameters<typeof decideWaitingIntegration>[0]> = {}) =>
  decideWaitingIntegration({
    verifiedSha: VERIFIED,
    pull: open,
    required: ['CI', 'Lint'],
    reports: [report('CI', 'pending'), report('Lint', 'success')],
    waitedMs: 60_000,
    automaticRuns: 0,
    ...over,
  })

describe('decideWaitingIntegration', () => {
  it('waits while a required check is still running', () => {
    expect(decide()).toEqual({ kind: 'wait' })
  })

  it('waits for a required check that has not reported yet, for a while', () => {
    expect(decide({ reports: [report('Lint', 'success')] })).toEqual({ kind: 'wait' })
  })

  it('waits while every required check passed and GitHub has not merged yet', () => {
    expect(decide({ reports: [report('CI', 'success'), report('Lint', 'success')] })).toEqual({
      kind: 'wait',
    })
  })

  it('finishes the integration when GitHub merged the verified commit', () => {
    const merged = { ...open, state: 'closed' as const, merged: true, mergeCommitSha: 'm1' }
    expect(decide({ pull: merged })).toEqual({ kind: 'finish', mergedSha: 'm1' })
  })

  it('waits for GitHub to name the merge commit of a merge it just made', () => {
    const merged = { ...open, state: 'closed' as const, merged: true }
    expect(decide({ pull: merged })).toEqual({ kind: 'wait' })
  })

  it('hands to a person a merge of a commit nobody verified', () => {
    const merged = {
      ...open,
      state: 'closed' as const,
      merged: true,
      mergeCommitSha: 'm1',
      headSha: 'other99999',
    }
    expect(decide({ pull: merged })).toEqual({
      kind: 'person',
      reason: expect.stringMatching(/merged at other99, not at the verified abc1234/),
      stopAutoMerge: false,
    })
  })

  it('hands to a person a pull request closed without being merged', () => {
    expect(decide({ pull: { ...open, state: 'closed' } })).toEqual({
      kind: 'person',
      reason: expect.stringMatching(/closed without being merged/),
      stopAutoMerge: false,
    })
  })

  it('stops auto-merge and hands to a person a head that moved past the verified commit', () => {
    expect(decide({ pull: { ...open, headSha: 'pushed1234' } })).toEqual({
      kind: 'person',
      reason: expect.stringMatching(/pushed1 was pushed after the verified abc1234/),
      stopAutoMerge: true,
    })
  })

  it('starts over a pull request that conflicts with its base', () => {
    expect(decide({ pull: { ...open, mergeableState: 'dirty' } })).toEqual({
      kind: 'start_over',
      reason: expect.stringMatching(/conflicts/),
    })
  })

  it('hands to a person a pull request that keeps conflicting', () => {
    expect(
      decide({ pull: { ...open, mergeableState: 'dirty' }, automaticRuns: AUTOMATIC_RETRIES }),
    ).toEqual({
      kind: 'person',
      reason: expect.stringMatching(/conflicts with its base after 3 automatic runs/),
      stopAutoMerge: true,
    })
  })

  it('leaves to a person a pull request whose auto-merge somebody turned off', () => {
    expect(decide({ pull: { ...open, autoMerge: false } })).toEqual({
      kind: 'person',
      reason: expect.stringMatching(/auto-merge was turned off/),
      stopAutoMerge: false,
    })
  })

  it('sends the work back naming the required checks that failed', () => {
    const step = decide({
      reports: [report('CI', 'failure', 'two tests failed'), report('Lint', 'failure', 'semi')],
    })
    expect(step).toEqual({
      kind: 'send_back',
      failed: ['CI', 'Lint'],
      note: expect.stringContaining('two tests failed'),
    })
  })

  it('ignores a failed check the branch does not require', () => {
    expect(
      decide({
        reports: [report('CI', 'pending'), report('Lint', 'success'), report('Docs', 'failure')],
      }),
    ).toEqual({ kind: 'wait' })
  })

  it('hands to a person the checks that still fail after the automatic runs', () => {
    expect(
      decide({ reports: [report('CI', 'failure')], automaticRuns: AUTOMATIC_RETRIES }),
    ).toEqual({
      kind: 'person',
      reason: expect.stringMatching(/required checks still fail after 3 automatic runs: CI/),
      stopAutoMerge: true,
    })
  })

  it('sends the work back on the last automatic run left', () => {
    expect(
      decide({ reports: [report('CI', 'failure')], automaticRuns: AUTOMATIC_RETRIES - 1 }),
    ).toMatchObject({ kind: 'send_back' })
  })

  it('hands to a person a required check that never reports, saying where it must run', () => {
    expect(decide({ reports: [report('CI', 'success')], waitedMs: CI_SILENCE_MS + 1 })).toEqual({
      kind: 'person',
      reason: expect.stringMatching(
        /Lint never reported.*pull requests into the integration branch/,
      ),
      stopAutoMerge: true,
    })
  })

  it('still waits for a silent check until the limit itself', () => {
    expect(decide({ reports: [report('CI', 'success')], waitedMs: CI_SILENCE_MS })).toEqual({
      kind: 'wait',
    })
  })
})

describe('checksFeedback', () => {
  it('names each failed check with its link and the end of what it reported', () => {
    const note = checksFeedback(VERIFIED, [report('CI', 'failure', 'x'.repeat(5_000) + 'END')])
    expect(note).toContain('abc1234')
    expect(note).toContain('- CI: https://github.com/o/r/runs/CI')
    expect(note).toContain('END')
    expect(note.length).toBeLessThanOrEqual(4_000)
  })

  it('stays within the size of a note however many checks failed', () => {
    const failed = Array.from({ length: 30 }, (_, i) =>
      report(`check-${i}`, 'failure', 'y'.repeat(900)),
    )
    const note = checksFeedback(VERIFIED, failed)
    expect(note.length).toBeLessThanOrEqual(4_000)
    expect(note).toContain('- check-29:')
  })

  it('says where to read a check that reported nothing', () => {
    expect(checksFeedback(VERIFIED, [report('CI', 'failure')])).not.toContain('```')
  })
})
