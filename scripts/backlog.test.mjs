import { describe, expect, it } from 'vitest'

import {
  classify,
  isInfraFailure,
  issueFor,
  needsAPerson,
  nextRunnable,
  OPEN,
  parseBacklog,
  repoFor,
  resetAt,
  stuckBehind,
} from './backlog.mjs'

const FIXTURE = `# BACKLOG

## B-1 - Serve tools over MCP

> Registered 2026-10-31 by \`/backlog-item\` (slug: \`serve-tools\`).

domain: theokit
repo: packages/theo
status: raw
evidence: .squad/records/discoveries/opportunities/serve-tools-opportunity.md
why_now: the framework serves only an agent module
dod:
  - a test lists the tools
  - a test calls one

## B-2 - Signal gateway

domain: theokit-gateways
repo: theokit-gateways
status: approved
blocked_by: B-1, B-9
dod:
  - sends and receives on a real account
dod_amendment_2026-10-31 (session): bullet 2 moved to B-5
  - and a second line

## B-3 - Old thing

domain: theokit
repo: theokit
status: shipped
dod:
  - done

## B-4 - Change the release workflow

domain: theokit
repo: theokit
status: triaged
dod:
  - .github/workflows/release.yml no longer publishes twice

## B-5 - SDK retry

domain: theokit
repo: ../theokit-sdk
status: triaged
blocked_by: B-3
dod:
  - the sdk retries once
`

const items = parseBacklog(FIXTURE)
const byId = (id) => items.find((i) => i.id === id)

describe('parseBacklog', () => {
  it('reads each item with its status, repository, evidence, slug and conditions', () => {
    expect(items.map((i) => i.id)).toEqual(['B-1', 'B-2', 'B-3', 'B-4', 'B-5'])
    expect(byId('B-1')).toMatchObject({
      title: 'Serve tools over MCP',
      status: 'raw',
      domain: 'theokit',
      repo: 'packages/theo',
      slug: 'serve-tools',
      evidence: '.squad/records/discoveries/opportunities/serve-tools-opportunity.md',
      whyNow: 'the framework serves only an agent module',
      dod: ['a test lists the tools', 'a test calls one'],
      blockedBy: [],
    })
  })

  it('reads the blockers once each, and keeps the amendments to the conditions', () => {
    expect(byId('B-2').blockedBy).toEqual(['B-1', 'B-9'])
    expect(byId('B-2').amendments).toHaveLength(1)
    expect(byId('B-2').amendments[0]).toContain('bullet 2 moved to B-5')
    expect(byId('B-2').amendments[0]).toContain('and a second line')
  })

  it('finds nothing in a text with no items', () => {
    expect(parseBacklog('# BACKLOG\n\nnothing here')).toEqual([])
  })

  it('knows which statuses still ask for work', () => {
    expect(OPEN).toEqual(['approved', 'planned', 'triaged', 'raw'])
  })
})

describe('repoFor', () => {
  it('sends each item to the repository it belongs in', () => {
    expect(repoFor(byId('B-1'))).toBe('usetheokit/theokit')
    expect(repoFor(byId('B-2'))).toBe('usetheokit/theokit-gateways')
    expect(repoFor(byId('B-5'))).toBe('usetheokit/theokit-sdk')
    expect(repoFor({ repo: 'theokit-sdk' })).toBe('usetheokit/theokit-sdk')
    expect(repoFor({})).toBe('usetheokit/theokit')
  })
})

describe('needsAPerson', () => {
  it('refuses an item that changes a workflow, and says why', () => {
    expect(needsAPerson(byId('B-4'))).toMatch(/workflow/)
  })

  it('has nothing to say about the others', () => {
    for (const id of ['B-1', 'B-2', 'B-5']) expect(needsAPerson(byId(id))).toBeUndefined()
  })
})

describe('issueFor', () => {
  it('stands alone: the title carries the id, and the body names what to do, where and when it is done', () => {
    const issue = issueFor(byId('B-1'))
    expect(issue.title).toBe('[B-1] Serve tools over MCP')
    expect(issue.body).toContain('backlog item B-1')
    expect(issue.body).toContain('## Why now')
    expect(issue.body).toContain('The work belongs in `packages/theo`.')
    expect(issue.body).toContain('`.squad/records/plans/serve-tools-plan.md`')
    expect(issue.body).toContain('- a test lists the tools\n- a test calls one')
  })

  it('says what the sandbox cannot prove, and what must not be touched', () => {
    const { body } = issueFor(byId('B-1'))
    expect(body).toContain('live model, a real account')
    expect(body).toContain('Never mark a parity ledger row as shipped')
    expect(body).toContain('Do not touch `.github/`')
  })

  it('carries the amendments and the blockers', () => {
    const { body } = issueFor(byId('B-2'))
    expect(body).toContain('## Amendments to the conditions above')
    expect(body).toContain('bullet 2 moved to B-5')
    expect(body).toContain('blocked by B-1, B-9')
  })

  it('leaves out the sections an item has nothing for', () => {
    const { body } = issueFor({ id: 'B-7', title: 'Bare', dod: [], amendments: [], blockedBy: [] })
    expect(body).not.toContain('## Why now')
    expect(body).not.toContain('Background')
    expect(body).not.toContain('## Amendments')
    expect(body).toContain('a test shows it')
    expect(body).toContain('the repository')
  })

  it('does not point at evidence that does not exist yet', () => {
    const { body } = issueFor({ ...byId('B-1'), evidence: 'none-yet', slug: undefined })
    expect(body).not.toContain('Background')
  })

  it('cuts a very long body to what the panel accepts, and says so', () => {
    const long = { ...byId('B-1'), dod: ['x'.repeat(20_000)] }
    const { body } = issueFor(long)
    expect(body.length).toBeLessThan(12_000)
    expect(body).toContain('The text was cut')
  })

  it('keeps the title within what GitHub takes', () => {
    expect(issueFor({ ...byId('B-1'), title: 't'.repeat(500) }).title.length).toBeLessThanOrEqual(
      290,
    )
  })
})

describe('nextRunnable', () => {
  it('takes approved before triaged before raw, and lower numbers first', () => {
    expect(nextRunnable(items, {}).id).toBe('B-5') // B-2 waits for B-1 and B-9
  })

  it('skips what was tried, what is running, and what needs a person', () => {
    expect(nextRunnable(items, { 'B-5': { outcome: 'failed' } }).id).toBe('B-1')
    expect(nextRunnable(items, { 'B-5': {} }, new Set(['B-1']))).toBeUndefined()
    expect(nextRunnable(items, {}, new Set(['B-5']))?.id).toBe('B-1')
  })

  it('waits for a blocker that is open, and ignores one that is shipped or not in the backlog', () => {
    const state = { 'B-5': { outcome: 'integrated' }, 'B-1': { outcome: 'failed' } }
    expect(nextRunnable(items, state)).toBeUndefined() // B-2 still waits for B-1
    state['B-1'] = { outcome: 'integrated' }
    expect(nextRunnable(items, state).id).toBe('B-2') // B-9 is not in the backlog
  })
})

describe('stuckBehind', () => {
  it('lists the items that can never start because a blocker was tried and did not integrate', () => {
    const stuck = stuckBehind(items, {
      'B-1': { outcome: 'failed' },
      'B-5': { outcome: 'integrated' },
    })
    expect(stuck.map((s) => [s.item.id, s.blockers])).toEqual([['B-2', ['B-1']]])
  })

  it('lists nothing while the blockers have not been tried', () => {
    expect(stuckBehind(items, {})).toEqual([])
  })
})

describe('resetAt', () => {
  it('reads the date a usage limit gives', () => {
    const d = resetAt('Nov 5th, 2026 11:48 AM')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(10)
    expect(d.getDate()).toBe(5)
    expect(d.getHours()).toBe(11)
    expect(d.getMinutes()).toBe(48)
  })

  it('reads every ordinal', () => {
    for (const day of ['1st', '2nd', '3rd', '4th', '22nd']) {
      expect(resetAt(`Nov ${day}, 2026 9:00 AM`)).toBeInstanceOf(Date)
    }
  })

  it('reads a bare time as today, or as tomorrow once it has passed', () => {
    const now = new Date(2026, 10, 5, 15, 25)
    const evening = resetAt('7:38 PM', now)
    expect([evening.getDate(), evening.getHours(), evening.getMinutes()]).toEqual([5, 19, 38])
    const morning = resetAt('9:05 AM', now)
    expect([morning.getDate(), morning.getHours(), morning.getMinutes()]).toEqual([6, 9, 5])
    expect(resetAt('12:00 AM', now).getHours()).toBe(0)
    expect(resetAt('12:30 PM', now).getHours()).toBe(12)
    expect(resetAt('3:25 PM', now).getDate()).toBe(6) // the minute it resets is already gone
  })

  it('says nothing when there is no date to read', () => {
    expect(resetAt(undefined)).toBeUndefined()
    expect(resetAt('')).toBeUndefined()
    expect(resetAt('soon')).toBeUndefined()
  })
})

describe('classify', () => {
  const detail = (stage, over = {}, info = {}) => ({
    task: { stage, integrated: false, preRelease: null, pullRequestUrl: 'u', ...over },
    timeline: [{ stage, detail: info }],
  })

  it('counts only a merged integration as a success', () => {
    expect(classify(detail('done', { integrated: true, preRelease: { tag: 'pre/1-a' } }))).toEqual({
      outcome: 'integrated',
      prerelease: 'pre/1-a',
      pullRequest: 'u',
    })
    expect(classify(detail('released')).outcome).toBe('integrated')
  })

  it('says a pull request left open is not an integration, and why', () => {
    expect(classify(detail('done', {}, { integrationError: 'conflicts' }))).toMatchObject({
      outcome: 'pr-open',
      reason: 'conflicts',
    })
    expect(classify(detail('done')).reason).toMatch(/not merged/)
  })

  it('tells a handoff from a failure, and a usage limit from both', () => {
    expect(classify(detail('handoff', {}, { handoff: 'reviewer asked again' }))).toMatchObject({
      outcome: 'handoff',
      reason: 'reviewer asked again',
    })
    expect(classify(detail('failed', {}, { error: 'no change', failedAt: 'push' }))).toEqual({
      outcome: 'failed',
      reason: 'no change',
      failedAt: 'push',
    })
    expect(
      classify(
        detail(
          'failed',
          {},
          { error: 'usage limit', quota: true, resetsAt: 'Nov 5th, 2026 11:48 AM' },
        ),
      ),
    ).toEqual({ outcome: 'quota', reason: 'usage limit', resetsAt: 'Nov 5th, 2026 11:48 AM' })
  })

  it('has no outcome while the task is still working', () => {
    expect(classify(detail('build')).outcome).toBeUndefined()
  })

  it('cuts a very long failure to a line a table can hold', () => {
    expect(classify(detail('failed', {}, { error: 'e'.repeat(1000) })).reason).toHaveLength(400)
  })
})

describe('isInfraFailure', () => {
  it('recognises what GitHub, the network and the sandbox do to a run', () => {
    for (const reason of [
      '`git push origin factory/1` exited 1: remote: Internal Server Error',
      '! [remote rejected] factory/182 -> factory/182 (Internal Server Error)',
      'GitHub answered 502 creating an issue',
      'GitHub answered 503 reading the repository',
      'connect ETIMEDOUT 140.82.112.3:443',
      'fetch failed',
      'Worker terminated: JS heap out of memory',
      'the factory was restarted while this run was working',
      'Status code 402 is not ok: Hobby plan usage limit exceeded',
    ]) {
      expect(isInfraFailure(reason), reason).toBe(true)
    }
  })

  it('does not call a failure of the work an environment failure', () => {
    for (const reason of [
      'the agent made no change to the repository',
      'the checks did not pass: tests exited 1',
      'the reviewer still asked for changes after 3 attempts',
      undefined,
      '',
    ]) {
      expect(isInfraFailure(reason), String(reason)).toBe(false)
    }
  })
})
