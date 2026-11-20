import { describe, expect, it } from 'vitest'

import type { Stage, TimelineEvent } from '../../shared/panel'

import { DICTIONARIES } from './copy'
import { en } from './copy/en'
import { ptBR } from './copy/pt-BR'
import {
  agentName,
  ago,
  describeEvent,
  duration,
  inQueueOrder,
  lastAgentLine,
  metricValue,
  money,
  priorityTone,
  runsAgain,
  shortSha,
  stageLabel,
  stepLine,
  topRank,
  workingLine,
} from './format'

describe('money', () => {
  it('writes cents, and a sum too small to be one as zero', () => {
    expect(money(0.2)).toBe('$0.20')
    expect(money(12.345)).toBe('$12.35')
    expect(money(0.005)).toBe('$0.01')
    expect(money(0.0049)).toBe('$0.00')
    expect(money(0)).toBe('$0.00')
  })
})

describe('metricValue', () => {
  it('writes each indicator in its unit', () => {
    expect(metricValue(0.756, 'share')).toBe('76%')
    expect(metricValue(0.531, 'usd')).toBe('$0.53')
    expect(metricValue(1.25, 'count')).toBe('1.3')
    expect(metricValue(42.4, 'minutes')).toBe('42 min')
    expect(metricValue(3.6, 'hours')).toBe('4 h')
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
      'plan',
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
      'cancelled',
    ]
    expect(all.map((s) => stageLabel(s))).toEqual([
      'queued',
      'starting sandbox',
      'planning',
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
      'cancelled',
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

  it('says which approved commit waits for its merge, and by whose review', () => {
    expect(line('merge', { sha: 'abc1234def', reviewer: 'codex' })).toBe(
      'abc1234, approved by codex',
    )
    expect(line('merge', { sha: 'abc1234def' })).toBe('abc1234')
  })

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
    expect(line('build', { harness: 'codex', attempt: 1, planned: true })).toBe(
      'codex, attempt 1, following its plan',
    )
  })

  it('names the agent that writes the plan', () => {
    expect(line('plan', { harness: 'claude-code' })).toBe('claude-code')
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

  it('says a task resolved with no change reached the release branch, with the commit it was resolved at', () => {
    expect(
      line('released', { actor: 'factory', releaseBranch: 'main', resolvedSha: 'abc1234def' }),
    ).toBe('already resolved at abc1234, now on main')
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
    expect(stageLabel('failed', { retryable: 'base' })).toBe('waiting for the base to pass')
    expect(stageLabel('build', { retryable: 'base' })).toBe('building')
    expect(stageLabel('failed', { retryable: null })).toBe('failed')
    expect(stageLabel('build', { integrated: true, retryable: 'quota' })).toBe('building')
  })

  it('says a finished task waits for the repository checks, rather than that it is not integrated', () => {
    expect(stageLabel('done', { waitingForChecks: true })).toBe('waiting for CI')
    expect(stageLabel('handoff', { waitingForChecks: true })).toBe('handed to a person')
  })
})

describe('in both languages', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')
  const before = (seconds: number) => new Date(now - seconds * 1000).toISOString()

  for (const language of ['en', 'pt-BR'] as const) {
    const t = DICTIONARIES[language]

    it(`ago reads from the ${language} dictionary`, () => {
      expect(ago(before(5), now, t.time)).toBe(t.time.secondsAgo(5))
      expect(ago(before(120), now, t.time)).toBe(t.time.minutesAgo(2))
      expect(ago(before(7_200), now, t.time)).toBe(t.time.hoursAgo(2))
      expect(ago(before(2 * 86_400), now, t.time)).toBe(t.time.daysAgo(2))
    })

    it(`runsAgain reads from the ${language} dictionary`, () => {
      const after = (seconds: number) => new Date(now + seconds * 1000).toISOString()
      expect(runsAgain(after(-1), now, t.time)).toBe(t.time.runsNextPass)
      expect(runsAgain(after(30), now, t.time)).toBe(t.time.runsUnderMinute)
      expect(runsAgain(after(300), now, t.time)).toBe(t.time.runsInMinutes(5))
    })

    it(`stageLabel reads from the ${language} dictionary`, () => {
      expect(stageLabel('build', {}, t.stages)).toBe(t.stages.build)
      expect(stageLabel('done', { resolved: true }, t.stages)).toBe(t.stages.alreadyResolved)
      expect(stageLabel('done', { integrated: true }, t.stages)).toBe(t.stages.integrated)
      expect(stageLabel('failed', { retryable: 'quota' }, t.stages)).toBe(t.stages.waitingForLimit)
    })
  }

  it('says things differently in Portuguese', () => {
    expect(ago(before(120), now, DICTIONARIES['pt-BR'].time)).toBe('há 2min')
    expect(stageLabel('intake', {}, DICTIONARIES['pt-BR'].stages)).toBe('na fila')
  })
})

describe('agentName', () => {
  it('gives the two known agents their product names and keeps any other name as it is', () => {
    expect(agentName('claude-code')).toBe('Claude Code')
    expect(agentName('codex')).toBe('Codex')
    expect(agentName('gemini-cli')).toBe('gemini-cli')
  })
})

describe('stepLine', () => {
  it('says the step, and its attempt or round past the first, without the agent', () => {
    const at = (step: 'building' | 'reviewing', attempt: number) =>
      stepLine({ step, agent: 'codex', model: 'gpt-6.1-terra', attempt }, en.board)

    expect(at('building', 1)).toBe('building')
    expect(at('building', 2)).toBe('building · attempt 2')
    expect(at('reviewing', 3)).toBe('reviewing · round 3')
  })
})

describe('workingLine', () => {
  it('names the agent, its model and the step while it plans', () => {
    const line = workingLine(
      { step: 'planning', agent: 'codex', model: 'gpt-6.1-terra', attempt: 1 },
      en.board,
    )
    expect(line).toBe('Codex · gpt-6.1-terra · planning')
  })

  it('says which attempt a build is past the first, and that a rework fixes findings', () => {
    expect(
      workingLine({ step: 'building', agent: 'claude-code', model: 'opus', attempt: 2 }, en.board),
    ).toBe('Claude Code · opus · building · attempt 2')
    expect(
      workingLine({ step: 'fixing', agent: 'claude-code', model: null, attempt: 2 }, en.board),
    ).toBe('Claude Code · fixing findings · attempt 2')
  })

  it('says which round a review is past the first', () => {
    expect(
      workingLine(
        { step: 'reviewing', agent: 'codex', model: 'gpt-6.1-terra', attempt: 2 },
        en.board,
      ),
    ).toBe('Codex · gpt-6.1-terra · reviewing · round 2')
  })

  it('names the checks while the factory verifies, with no agent', () => {
    expect(workingLine({ step: 'checks', checks: ['tests', 'lint'] }, en.board)).toBe(
      'checks · tests, lint',
    )
    expect(workingLine({ step: 'checks', checks: [] }, en.board)).toBe('checks')
  })

  it('speaks Portuguese with the Portuguese dictionary', () => {
    expect(
      workingLine({ step: 'reviewing', agent: 'codex', model: null, attempt: 3 }, ptBR.board),
    ).toBe('Codex · revisando · rodada 3')
  })
})

describe('lastAgentLine', () => {
  it('names who worked last, with the model when there is one', () => {
    expect(lastAgentLine({ agent: 'claude-code', model: 'opus' }, en.board)).toBe(
      'last: Claude Code · opus',
    )
    expect(lastAgentLine({ agent: 'codex', model: null }, ptBR.board)).toBe('por último: Codex')
  })
})

describe('the queued column', () => {
  const at = (id: number, position: number | null) => ({
    id,
    queue: { position, reasons: null, readiness: null },
  })

  it('lists the queued tasks in the order the worker serves them, held ones last in the order they came', () => {
    const tasks = [at(1, 3), at(2, null), at(3, 1), at(4, null), at(5, 2)]
    expect(inQueueOrder(tasks).map((t) => t.id)).toEqual([3, 5, 1, 2, 4])
  })

  it('leaves a task with no place in the line after the ones that have one', () => {
    expect(inQueueOrder([{ id: 1, queue: null }, at(2, 4)]).map((t) => t.id)).toEqual([2, 1])
  })

  it('does not reorder what it was given', () => {
    const tasks = [at(1, 2), at(2, 1)]
    inQueueOrder(tasks)
    expect(tasks.map((t) => t.id)).toEqual([1, 2])
  })

  it('ranks the first ten places of the line and nothing after them', () => {
    expect([1, 10, 11, null].map((position) => topRank(at(0, position).queue))).toEqual([
      1,
      10,
      null,
      null,
    ])
    expect(topRank(null)).toBeNull()
  })
})

describe('the badge of a priority', () => {
  it('is red for priority 1, amber for 2, violet for 3 and plain from 4 down', () => {
    expect([1, 2, 3, 4, 5, 9].map(priorityTone)).toEqual([
      'destructive',
      'warning',
      'primary',
      'default',
      'default',
      'default',
    ])
  })

  it('treats a priority under 1 as the most urgent', () => {
    expect(priorityTone(0)).toBe('destructive')
  })
})

describe('duration', () => {
  it('reads minutes under an hour, hours and minutes under a day, and days and hours after', () => {
    expect(duration(0)).toBe('0m')
    expect(duration(45)).toBe('45m')
    expect(duration(60)).toBe('1h')
    expect(duration(190)).toBe('3h 10m')
    expect(duration(1440)).toBe('1d')
    expect(duration(1440 + 4 * 60 + 30)).toBe('1d 4h')
  })
})

describe('duration', () => {
  it('counts whole minutes, so a time measured to the millisecond never shows a fraction', () => {
    expect(duration(5 * 60 + 9.406216666666694)).toBe('5h 9m')
    expect(duration(3 * 60 + 5.019783333333322)).toBe('3h 5m')
    expect(duration(59.99)).toBe('59m')
    expect(duration(0.4)).toBe('0m')
  })
})
