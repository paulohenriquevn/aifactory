import { describe, expect, it } from 'vitest'

import type { Stage, TimelineEvent } from '../../shared/panel'

import { ago, describeEvent, money, runsAgain, shortSha, stageLabel } from './format'

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

describe('runsAgain', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')
  const after = (seconds: number) => new Date(now + seconds * 1000).toISOString()

  it('says how long until the factory runs a task again, in the largest unit that fits', () => {
    expect(runsAgain(after(30), now)).toBe('runs again in under a minute')
    expect(runsAgain(after(5 * 60), now)).toBe('runs again in 5m')
    expect(runsAgain(after(3 * 3600 + 120), now)).toBe('runs again in 3h')
  })

  it('says it is due once the time went by, because the next pass picks it up', () => {
    expect(runsAgain(after(-600), now)).toBe('runs again on the next pass')
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

  it('calls a task delivered without a pull request already resolved, before anything else', () => {
    expect(stageLabel('done', { resolved: true })).toBe('already resolved')
    expect(stageLabel('done', { resolved: true, integrated: true })).toBe('already resolved')
    expect(stageLabel('done', { resolved: false })).toBe('pull request open')
  })
})

describe('describeEvent', () => {
  it('says at which commit an issue was already resolved, and that it was closed', () => {
    const event = { id: 1, stage: 'done', at: '2026-11-04T10:00:00Z' } as TimelineEvent
    expect(describeEvent({ ...event, detail: { resolved: true, sha: 'abc1234def' } })).toBe(
      'already resolved at abc1234, issue closed',
    )
  })

  const line = (stage: Stage, detail: Record<string, unknown> | null) =>
    describeEvent({ id: 1, stage, at: '2026-11-04T10:00:00Z', detail } as TimelineEvent)

  it('says what a person asked for, with the note when there is one', () => {
    expect(line('intake', { decision: 'retry' })).toBe('a person retry')
    expect(line('intake', { decision: 'request_changes', note: 'rename it' })).toBe(
      'a person request changes: rename it',
    )
    expect(line('intake', null)).toBe('')
    expect(
      line('intake', { decision: 'request_changes', note: 'CI failed', automatic: true }),
    ).toBe('the factory request changes: CI failed')
    expect(line('intake', {})).toBe('')
  })

  it('says which checks an integration waits for, and that GitHub merged it once they passed', () => {
    expect(line('done', { pullRequestUrl: 'u', awaitingChecks: ['CI', 'Lint'] })).toBe(
      'u\nwaiting for the repository checks: CI, Lint',
    )
    expect(
      line('done', { pullRequestUrl: 'u', integratedBy: 'auto-merge', mergedSha: 'merge0001' }),
    ).toBe('u\nmerged by auto-merge at merge00')
  })

  it('names the sandbox, the branch and the review', () => {
    expect(line('sandbox', { provider: 'vercel-sandbox' })).toBe('vercel-sandbox')
    expect(line('sandbox', { provider: 'e2b', renewed: true, sessionMinutes: 36 })).toBe(
      'e2b, new session: the last one had run 36 minutes, the disk moved over',
    )
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

  it('says a changesets release waits for the repository to publish it', () => {
    expect(line('released', { actor: 'human', publishing: 'changesets' })).toBe(
      "promoted by human; the repository's release workflow publishes it",
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
    expect(stageLabel('failed', { retryable: 'blocked' })).toBe('waiting for another issue')
    expect(stageLabel('failed', { retryable: null })).toBe('failed')
    expect(stageLabel('build', { integrated: true, retryable: 'quota' })).toBe('building')
  })

  it('says a finished task waits for the repository checks, rather than that it is not integrated', () => {
    expect(stageLabel('done', { waitingForChecks: true })).toBe('waiting for CI')
    expect(stageLabel('handoff', { waitingForChecks: true })).toBe('handed to a person')
  })
})
