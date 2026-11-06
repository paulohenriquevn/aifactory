import { describe, expect, it } from 'vitest'

import {
  classify,
  credentialFiles,
  credentialStamp,
  isInfraFailure,
  issueFor,
  needsAPerson,
  nextRunnable,
  OPEN,
  parseBacklog,
  repoFor,
  resetAt,
  settleKnown,
  stuckBehind,
  takeResumed,
  throughOutage,
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
      '[work] clone failed: timed out after 30000 ms',
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

describe('throughOutage', () => {
  const noSleep = () => Promise.resolve()

  it('tries again while the panel cannot be reached, and returns what it finally answers', async () => {
    let calls = 0
    const waited = []
    const result = await throughOutage(
      async () => {
        calls += 1
        if (calls < 3) throw new TypeError('fetch failed')
        return { status: 200 }
      },
      { waits: [1, 2, 3], sleep: async (ms) => waited.push(ms), onWait: () => {} },
    )
    expect(result).toEqual({ status: 200 })
    expect(calls).toBe(3)
    expect(waited).toEqual([1, 2])
  })

  it('says how long it waits and for which try', async () => {
    const said = []
    let calls = 0
    await throughOutage(
      async () => {
        if (++calls === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:3000')
      },
      { waits: [7], sleep: noSleep, onWait: (ms, n) => said.push([ms, n]) },
    )
    expect(said).toEqual([[7, 1]])
  })

  it('gives up with the same error when the outage outlasts the waits', async () => {
    let calls = 0
    await expect(
      throughOutage(
        async () => {
          calls += 1
          throw new TypeError('fetch failed')
        },
        { waits: [1, 1], sleep: noSleep },
      ),
    ).rejects.toThrow('fetch failed')
    expect(calls).toBe(3)
  })

  it('passes on at once an error that is not an outage, such as a refusal of the panel', async () => {
    let calls = 0
    await expect(
      throughOutage(
        async () => {
          calls += 1
          throw new Error('the panel kept refusing POST /x')
        },
        { waits: [1, 1], sleep: noSleep },
      ),
    ).rejects.toThrow('kept refusing')
    expect(calls).toBe(1)
  })

  it('knows an outage by the code on the cause, as node reports a refused connection', async () => {
    let calls = 0
    const result = await throughOutage(
      async () => {
        if (++calls === 1)
          throw Object.assign(new Error('request failed'), { cause: { code: 'ECONNREFUSED' } })
        return 'ok'
      },
      { waits: [1], sleep: noSleep },
    )
    expect(result).toBe('ok')
  })

  it('has waits that add up to several minutes, longer than a restart of the panel', async () => {
    const { OUTAGE_WAITS_MS } = await import('./backlog.mjs')
    expect(OUTAGE_WAITS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(7 * 60_000)
  })
})

describe('the credentials a usage pause watches', () => {
  it('are the panel token, the environment file and the Codex login, in the default places', () => {
    expect(credentialFiles({}, '/repo', '/home/p')).toEqual([
      '/repo/.secrets/claude-oauth-token',
      '/repo/.env.local',
      '/home/p/.codex-factory-1/auth.json',
      '/home/p/.codex-factory-1/factory-auth.json',
    ])
  })

  it('follow the paths the factory is told to use', () => {
    const env = { FACTORY_CLAUDE_TOKEN_FILE: '/s/claude', FACTORY_CODEX_HOME: '/s/codex' }
    expect(credentialFiles(env, '/repo', '/home/p')).toEqual([
      '/s/claude',
      '/repo/.env.local',
      '/s/codex/auth.json',
      '/s/codex/factory-auth.json',
    ])
  })
})

describe('credentialStamp', () => {
  const mtimes = { '/a': 100, '/b': 200 }
  const stat = (path) => {
    if (!(path in mtimes)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return mtimes[path]
  }

  it('stays the same while no credential file changes', () => {
    expect(credentialStamp(['/a', '/b'], stat)).toBe(credentialStamp(['/a', '/b'], stat))
  })

  it('changes when a credential file is rewritten', () => {
    const before = credentialStamp(['/a', '/b'], stat)
    const after = credentialStamp(['/a', '/b'], (path) => (path === '/b' ? 201 : stat(path)))
    expect(after).not.toBe(before)
  })

  it('changes when a missing credential file appears', () => {
    const before = credentialStamp(['/a', '/c'], stat)
    const after = credentialStamp(['/a', '/c'], (path) => (path === '/c' ? 5 : stat(path)))
    expect(after).not.toBe(before)
  })

  it('fails loudly on an error other than a missing file', () => {
    const denied = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
    expect(() => credentialStamp(['/a'], denied)).toThrow(/EACCES/)
  })
})

describe('settleKnown', () => {
  const backlog = parseBacklog(`## B-7 - Publish to npm

repo: apps/theoclaw
status: raw
deferred_2026-11-02: owner decision (operator conversation): not published for now
dod:
  - npm i -g works

## B-8 - Already built

> Registered 2026-10-20 by \`/backlog-item\` (slug: \`built\`).

repo: theokit
status: approved
dod:
  - it works
`)
  const onDevelop = (item) => (item.slug === 'built' ? 'abc1234' : undefined)

  it('reads a deferral the owner recorded on the item', () => {
    expect(backlog[0].deferred).toContain('not published for now')
    expect(backlog[1].deferred).toBeUndefined()
  })

  it('records a deferred item and one already on develop, so neither is opened', () => {
    const state = {}
    const settled = settleKnown(backlog, state, onDevelop)
    expect(settled.map((s) => s.id)).toEqual(['B-7', 'B-8'])
    expect(state['B-7'].outcome).toBe('deferred')
    expect(state['B-8']).toMatchObject({ outcome: 'integrated' })
    expect(state['B-8'].note).toContain('abc1234')
    expect(nextRunnable(backlog, state)).toBeUndefined()
  })

  it('leaves alone an item sent back to be checked against its conditions, though its plan is on develop', () => {
    const state = { 'B-8': { issue: 9, verify: true } }
    expect(settleKnown(backlog, state, onDevelop).map((s) => s.id)).toEqual(['B-7'])
    expect(state['B-8'].outcome).toBeUndefined()
  })

  it('settles a failed run of an item on develop, and leaves an integrated one as it was', () => {
    const state = { 'B-8': { outcome: 'failed', issue: 3 } }
    settleKnown(backlog, state, onDevelop)
    expect(state['B-8'].outcome).toBe('integrated')
    const done = { 'B-8': { outcome: 'integrated', issue: 3 } }
    expect(settleKnown(backlog, done, onDevelop).map((s) => s.id)).toEqual(['B-7'])
    expect(done['B-8'].issue).toBe(3)
  })
})

describe('takeResumed', () => {
  it('takes one item off the queue per call, so every half-done item is resumed', () => {
    const queue = ['B-5', 'B-1']
    expect(takeResumed(queue, items)?.id).toBe('B-5')
    expect(queue).toEqual(['B-1'])
    expect(takeResumed(queue, items)?.id).toBe('B-1')
    expect(takeResumed(queue, items)).toBeUndefined()
  })

  it('skips an id that is no longer in the backlog instead of stopping', () => {
    const queue = ['B-99', 'B-2']
    expect(takeResumed(queue, items)?.id).toBe('B-2')
    expect(queue).toEqual([])
  })
})
