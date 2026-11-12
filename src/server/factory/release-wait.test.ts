import { describe, expect, it } from 'vitest'

import type { CheckReport, PullRequestDetail } from '../github/pulls'

import { CI_SILENCE_MS } from './ci-wait'
import { decideWaitingRelease } from './release-wait'

const PINNED = 'dev1234beef'
const open: PullRequestDetail = {
  number: 381,
  url: 'https://github.com/o/r/pull/381',
  state: 'open',
  merged: false,
  headSha: PINNED,
  autoMerge: true,
  mergeableState: 'blocked',
}
const report = (name: string, state: CheckReport['state']): CheckReport => ({
  name,
  state,
  detail: '',
  url: `https://github.com/o/r/runs/${name}`,
})

const decide = (over: Partial<Parameters<typeof decideWaitingRelease>[0]> = {}) =>
  decideWaitingRelease({
    pinnedSha: PINNED,
    releaseBranch: 'main',
    pull: open,
    required: ['CI', 'SonarCloud Code Analysis'],
    reports: [report('CI', 'pending'), report('SonarCloud Code Analysis', 'success')],
    waitedMs: 60_000,
    ...over,
  })

describe('decideWaitingRelease', () => {
  it('waits while a required check of the release branch is still running', () => {
    expect(decide()).toEqual({ kind: 'wait' })
  })

  it('waits for a required check that has not reported yet, for a while', () => {
    expect(decide({ reports: [report('CI', 'success')] })).toEqual({ kind: 'wait' })
  })

  it('waits while every required check passed and GitHub has not merged yet', () => {
    const green = [report('CI', 'success'), report('SonarCloud Code Analysis', 'success')]
    expect(decide({ reports: green })).toEqual({ kind: 'wait' })
  })

  it('finishes the release when GitHub merged the pinned commit', () => {
    const merged = { ...open, state: 'closed' as const, merged: true, mergeCommitSha: 'm1' }
    expect(decide({ pull: merged })).toEqual({ kind: 'finish', mergeSha: 'm1' })
  })

  it('waits for GitHub to name the merge commit of a merge it just made', () => {
    const merged = { ...open, state: 'closed' as const, merged: true }
    expect(decide({ pull: merged })).toEqual({ kind: 'wait' })
  })

  it('refuses a release pull request merged at a head the factory did not ask for', () => {
    const merged = { ...open, state: 'closed' as const, merged: true, headSha: 'other99' }
    expect(decide({ pull: merged })).toEqual({
      kind: 'refuse',
      reason:
        'the release pull request was merged at other99, not at dev1234 that the release was asked for: check what reached main',
      stopAutoMerge: false,
    })
  })

  it('refuses a release pull request closed without a merge', () => {
    expect(decide({ pull: { ...open, state: 'closed' } })).toEqual({
      kind: 'refuse',
      reason: 'the release pull request was closed without being merged',
      stopAutoMerge: false,
    })
  })

  it('refuses when the pre-release branch moved after the release was asked for, and stops auto-merge', () => {
    expect(decide({ pull: { ...open, headSha: 'new5678' } })).toEqual({
      kind: 'refuse',
      reason:
        'the pre-release branch moved to new5678 after the release was asked for at dev1234: ask for the release again to promote what is there now',
      stopAutoMerge: true,
    })
  })

  it('refuses a release pull request that conflicts with the release branch', () => {
    expect(decide({ pull: { ...open, mergeableState: 'dirty' } })).toEqual({
      kind: 'refuse',
      reason: 'the release pull request conflicts with main',
      stopAutoMerge: true,
    })
  })

  it('refuses when somebody turned auto-merge off, because nothing would merge it', () => {
    expect(decide({ pull: { ...open, autoMerge: false } })).toEqual({
      kind: 'refuse',
      reason: 'auto-merge was turned off on the release pull request, so nothing will merge it',
      stopAutoMerge: false,
    })
  })

  it('refuses at once, naming them, when required checks fail: a release is never retried on its own', () => {
    const failed = [report('CI', 'failure'), report('SonarCloud Code Analysis', 'failure')]
    expect(decide({ reports: failed })).toEqual({
      kind: 'refuse',
      reason:
        'the required checks of main failed on the release pull request: CI, SonarCloud Code Analysis',
      failed: ['CI', 'SonarCloud Code Analysis'],
      stopAutoMerge: true,
    })
  })

  it('names a single failed check in the singular', () => {
    const one = [report('CI', 'failure'), report('SonarCloud Code Analysis', 'success')]
    expect(decide({ reports: one })).toMatchObject({
      reason: 'the required check of main failed on the release pull request: CI',
      failed: ['CI'],
    })
  })

  it('refuses a required check that stayed silent past the limit', () => {
    const step = decide({ reports: [report('CI', 'success')], waitedMs: CI_SILENCE_MS + 1 })
    expect(step).toEqual({
      kind: 'refuse',
      reason:
        'the required check SonarCloud Code Analysis never reported on dev1234: it must run on pull requests into main',
      stopAutoMerge: true,
    })
  })

  it('says "checks" and "they" for several silent checks', () => {
    const step = decide({ reports: [], waitedMs: CI_SILENCE_MS + 1 })
    expect(step).toMatchObject({
      reason:
        'the required checks CI, SonarCloud Code Analysis never reported on dev1234: they must run on pull requests into main',
    })
  })

  it('keeps waiting for a silent check up to the limit itself', () => {
    expect(decide({ reports: [report('CI', 'success')], waitedMs: CI_SILENCE_MS })).toEqual({
      kind: 'wait',
    })
  })

  it('waits while checks run even past the silence limit, as long as they reported', () => {
    expect(decide({ waitedMs: CI_SILENCE_MS * 2 })).toEqual({ kind: 'wait' })
  })
})
