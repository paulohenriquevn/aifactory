import { describe, expect, it } from 'vitest'

import type { Stage, TimelineEvent } from '../../shared/panel'

import { ago, describeEvent, money, shortSha, stageLabel } from './format'

describe('money', () => {
  it('writes cents, and a sum too small to be one as zero', () => {
    expect(money(0.2)).toBe('$0.20')
    expect(money(12.345)).toBe('$12.35')
    expect(money(0.005)).toBe('$0.01')
    expect(money(0.0049)).toBe('$0.00')
    expect(money(0)).toBe('$0.00')
  })
})

describe('shortSha', () => {
  it('keeps seven characters, and nothing for nothing', () => {
    expect(shortSha('abcdef1234567')).toBe('abcdef1')
    expect(shortSha('abc')).toBe('abc')
    expect(shortSha(null)).toBe('')
    expect(shortSha(undefined)).toBe('')
    expect(shortSha('')).toBe('')
  })
})

describe('ago', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')
  const before = (seconds: number) => new Date(now - seconds * 1000).toISOString()

  it('counts in the largest unit that fits, at each boundary', () => {
    expect(ago(before(0), now)).toBe('0s ago')
    expect(ago(before(59), now)).toBe('59s ago')
    expect(ago(before(60), now)).toBe('1m ago')
    expect(ago(before(3_599), now)).toBe('59m ago')
    expect(ago(before(3_600), now)).toBe('1h ago')
    expect(ago(before(86_399), now)).toBe('23h ago')
    expect(ago(before(86_400), now)).toBe('1d ago')
    expect(ago(before(3 * 86_400 + 5), now)).toBe('3d ago')
  })

  it('does not say a time is in the past when it is slightly ahead of the clock', () => {
    expect(ago(before(-30), now)).toBe('0s ago')
  })
})

describe('stageLabel', () => {
  it("has words for every stage, in the person's terms", () => {
    const all: Stage[] = [
      'intake',
      'sandbox',
      'build',
      'push',
      'verify',
      'review',
      'waiting',
      'pr',
      'done',
      'released',
      'handoff',
      'failed',
    ]
    expect(all.map((s) => stageLabel(s))).toEqual([
      'queued',
      'starting sandbox',
      'building',
      'pushing',
      'running checks',
      'in review',
      'waiting for you',
      'opening pull request',
      'pull request open',
      'released',
      'handed to a person',
      'failed',
    ])
  })
})

describe('describeEvent', () => {
  const line = (stage: Stage, detail: Record<string, unknown> | null) =>
    describeEvent({ id: 1, stage, at: '2026-11-04T10:00:00Z', detail } as TimelineEvent)

  it('says what a person asked for, with the note when there is one', () => {
    expect(line('intake', { decision: 'retry' })).toBe('a person retry')
    expect(line('intake', { decision: 'request_changes', note: 'rename it' })).toBe(
      'a person request changes: rename it',
    )
    expect(line('intake', null)).toBe('')
    expect(line('intake', {})).toBe('')
  })

  it('names the sandbox, the branch and the review', () => {
    expect(line('sandbox', { provider: 'vercel-sandbox' })).toBe('vercel-sandbox')
    expect(line('push', { branch: 'factory/7' })).toBe('factory/7')
    expect(line('review', { reviewer: 'codex', sha: 'abcdef123456' })).toBe('codex, abcdef1')
    expect(line('review', { reviewer: 'codex' })).toBe('codex')
  })

  it('says how a build went: the agent, the attempt, a resume and a rework', () => {
    expect(line('build', { harness: 'claude-code', attempt: 2, resumed: true })).toBe(
      'claude-code, attempt 2, resumed after an answer',
    )
    expect(line('build', { harness: 'codex', rework: true })).toBe('codex, rework')
    expect(line('build', { harness: 'claude-code' })).toBe('claude-code')
  })

  it('says which commit and attempt were checked, leaving out what is missing', () => {
    expect(line('verify', { sha: 'abcdef123456', attempt: 3 })).toBe('abcdef1, attempt 3')
    expect(line('verify', { attempt: 1 })).toBe('attempt 1')
    expect(line('verify', { sha: 'abcdef123456' })).toBe('abcdef1')
  })

  it('shows the question, the reason for a handoff and the way a run failed', () => {
    expect(line('waiting', { question: 'A or B?' })).toBe('A or B?')
    expect(line('handoff', { reason: 'three attempts' })).toBe('three attempts')
    expect(line('failed', { failedAt: 'verify', error: 'no pull request' })).toBe(
      'verify: no pull request',
    )
    expect(line('failed', { quota: true })).toBe('out of quota')
    expect(line('failed', { quota: true, resetsAt: 'Nov 5th' })).toBe(
      'out of quota, resets Nov 5th',
    )
  })

  it('tells a done event apart: the pull request, the pre-release, and a pull request left as it was', () => {
    expect(line('done', { pullRequestUrl: 'u' })).toBe('u')
    expect(line('done', { pullRequestUrl: 'u', preRelease: 'pre/7-abc1234' })).toBe(
      'u\npre-release pre/7-abc1234',
    )
    expect(line('done', { preReleaseError: 'GitHub refused' })).toBe(
      'no pre-release: GitHub refused',
    )
    expect(line('done', { unchanged: true })).toBe('nothing to change')
  })

  it('tells a release apart from a merge whose release could not be made', () => {
    expect(line('released', { tag: 'v0.1.0', actor: 'human' })).toBe('v0.1.0 by human')
    expect(line('released', { tag: 'v0.1.0', actor: 'human', releaseError: 'boom' })).toBe(
      'v0.1.0 by human, but the release could not be created: boom',
    )
    expect(line('released', { actor: 'agent:codex', releaseError: 'boom' })).toBe(
      'merged by agent:codex, but the release could not be created: boom',
    )
  })

  it('has nothing to say for stages that carry nothing', () => {
    expect(line('pr', {})).toBe('')
  })
})

describe('stageLabel with what is known of the task', () => {
  it('calls a merged task integrated, and a failure that passes by itself a wait', () => {
    expect(stageLabel('done', { integrated: true })).toBe('integrated')
    expect(stageLabel('done', { integrated: false })).toBe('pull request open')
    expect(stageLabel('failed', { retryable: 'quota' })).toBe('waiting for the limit')
    expect(stageLabel('failed', { retryable: 'environment' })).toBe('will retry')
    expect(stageLabel('failed', { retryable: null })).toBe('failed')
    expect(stageLabel('build', { integrated: true, retryable: 'quota' })).toBe('building')
  })
})
