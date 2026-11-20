import { describe, expect, it } from 'vitest'

import {
  columnOf,
  COLUMNS,
  mergeBreakdown,
  mergeState,
  retryableFailure,
  type Column,
  type Stage,
  type TaskCard,
} from './panel'

describe('columnOf', () => {
  const expected: Record<Stage, Column> = {
    intake: 'queued',
    sandbox: 'working',
    plan: 'working',
    build: 'working',
    push: 'working',
    verify: 'working',
    review: 'working',
    merge: 'merge',
    pr: 'merge',
    waiting: 'waiting',
    // A done task with nothing merged yet: its integration is still ahead of it.
    done: 'merge',
    released: 'released',
    handoff: 'attention',
    failed: 'attention',
    cancelled: 'attention',
  }

  it('puts every stage on the board where a person would look for it', () => {
    for (const [stage, column] of Object.entries(expected)) {
      expect(columnOf(stage as Stage), stage).toBe(column)
    }
  })

  it('only uses columns the board has, and shows each of them in order', () => {
    expect(COLUMNS.map((c) => c.id)).toEqual([
      'queued',
      'working',
      'waiting',
      'retrying',
      'merge',
      'review',
      'released',
      'resolved',
      'attention',
    ])
    const known = new Set(COLUMNS.map((c) => c.id))
    for (const column of Object.values(expected)) expect(known.has(column)).toBe(true)
  })

  it('gives every column a title', () => {
    expect(COLUMNS.map((c) => c.title)).toEqual([
      'Queued',
      'Working',
      'Waiting for you',
      'Will retry itself',
      'Merge',
      'Delivered',
      'Released',
      'Already resolved',
      'Needs a person',
    ])
  })
})

describe('a task that finished with no change', () => {
  it('leaves Delivered, since no release will ever carry it', () => {
    expect(columnOf('done', null, { resolved: true })).toBe('resolved')
  })

  it('stays in Delivered once its work is integrated, until a release carries it', () => {
    expect(columnOf('done', null, { integrated: true })).toBe('review')
    expect(columnOf('done', null, { resolved: true, integrated: true })).toBe('review')
  })

  it('keeps approved work that is not integrated yet in Merge, waiting for CI or for its merge', () => {
    expect(columnOf('done', null, { resolved: false, integrated: false })).toBe('merge')
  })

  it('only changes the column of a done task', () => {
    expect(columnOf('released', null, { resolved: true })).toBe('released')
    expect(columnOf('failed', null, { resolved: true })).toBe('attention')
  })
})

describe('a failure that passes by itself', () => {
  it('goes to its own column, only when the task failed', () => {
    expect(columnOf('failed', 'quota')).toBe('retrying')
    expect(columnOf('failed', 'environment')).toBe('retrying')
    expect(columnOf('failed', null)).toBe('attention')
    expect(columnOf('failed')).toBe('attention')
    expect(columnOf('build', 'quota')).toBe('working')
    expect(columnOf('cancelled', 'quota')).toBe('attention')
  })

  it('is told by the usage limit flag or by an error of the environment', () => {
    expect(retryableFailure({ quota: true })).toBe('quota')
    expect(retryableFailure({ error: 'git push: remote rejected' })).toBe('environment')
    expect(retryableFailure({ error: 'GitHub answered 502' })).toBe('environment')
    expect(retryableFailure({ error: 'Status code 402' })).toBe('environment')
    expect(retryableFailure({ error: 'the agent made no change' })).toBeNull()
    expect(retryableFailure({ error: 42 })).toBeNull()
    expect(retryableFailure({})).toBeNull()
    expect(retryableFailure(null)).toBeNull()
    expect(retryableFailure(undefined)).toBeNull()
  })

  it('reads a run GitHub refused for the spent rate limit as the environment, which passes at the reset', () => {
    expect(
      retryableFailure({
        error:
          'GitHub rate limit spent: GET /repos/o/r/issues/3 was refused with 403 for the core limit, until 2026-11-18T01:22:00.000Z',
      }),
    ).toBe('environment')
  })

  it('reads a run that failed on the rate limit before the factory named it as the environment', () => {
    expect(
      retryableFailure({
        error:
          'GitHub answered 403 creating the check run on o/r: {"message": "API rate limit exceeded for installation ID 178693604."}',
      }),
    ).toBe('environment')
  })

  it('waits, rather than going to a person, while an issue the task is blocked by is open', () => {
    const detail = { error: 'blocked by o/a#1, still open; …', blockedBy: ['o/a#1'] }

    expect(retryableFailure(detail)).toBe('blocked')
    expect(columnOf('failed', 'blocked')).toBe('retrying')
    expect(retryableFailure({ error: 'x', blockedBy: [] })).toBeNull()
    expect(retryableFailure({ error: 'x', blockedBy: 'o/a#1' })).toBeNull()
  })

  it('waits for the base, rather than going to a person, when the failing checks fail on the integration branch too', () => {
    const detail = {
      error: '"quality" fails on workspace too',
      baseRed: { sha: 'abc', checks: ['quality'] },
    }

    expect(retryableFailure(detail)).toBe('base')
    expect(columnOf('failed', 'base')).toBe('retrying')
    expect(retryableFailure({ error: 'x', baseRed: { sha: 'abc', checks: [] } })).toBeNull()
    expect(retryableFailure({ error: 'x', baseRed: 'quality' })).toBeNull()
    expect(retryableFailure({ error: 'x', baseRed: null })).toBeNull()
    expect(retryableFailure({ error: 'x', baseRed: { sha: 'abc', checks: 'quality' } })).toBeNull()
    expect(retryableFailure({ error: 'x', baseRed: { sha: 'abc' } })).toBeNull()
  })

  it('reads the sandbox provider refusing past its concurrent sandbox limit as the environment', () => {
    const refused =
      'Rate limit exceeded, please try again later - you have reached the maximum number of concurrent E2B sandboxes (10).'

    expect(retryableFailure({ error: refused })).toBe('environment')
    expect(retryableFailure({ error: `the sandbox did not start: ${refused}` })).toBe('environment')
  })

  it('reads a harness that would not install as the environment', () => {
    expect(retryableFailure({ error: 'claude did not install: added 1 package in 1s' })).toBe(
      'environment',
    )
    expect(retryableFailure({ error: 'codex did not install: npm error code E404' })).toBe(
      'environment',
    )
  })

  it('reads a sandbox that the provider ended mid-command as the environment', () => {
    const ended =
      '[unavailable] the connection to sandbox i0ry24bnztijroi40rdot ended before the stream completed: The sandbox was killed or reached its end of life while the request was in flight. (cause: [unavailable] the connection to sandbox i0ry24bnztijroi40rdot ended before the stream completed)'

    expect(retryableFailure({ error: ended })).toBe('environment')
  })

  it('reads a sandbox provider that refuses for billing as the environment, not as the work', () => {
    expect(
      retryableFailure({ error: 'the sandbox did not start: 403: team is blocked: spend_limit' }),
    ).toBe('environment')
    expect(retryableFailure({ error: '403: team is blocked: spend_limit' })).toBe('environment')
    // E2B on 2026-11-19, once the team's credit ran out.
    expect(retryableFailure({ error: '403: team is blocked: credit_exhausted' })).toBe(
      'environment',
    )
    expect(retryableFailure({ error: "404: template 'aifactory-sandbox' not found" })).toBe(
      'environment',
    )
    expect(retryableFailure({ error: "404: template 'invoice' not found" })).toBeNull()
    expect(retryableFailure({ error: 'expected 200 but got 404 from /api/x' })).toBeNull()
    expect(retryableFailure({ error: 'GitHub answered 403 reading the issue' })).toBeNull()
  })

  it('reads a sandbox the provider could not reach as the environment, not as the work', () => {
    expect(
      retryableFailure({
        error:
          '[unknown] terminated: The sandbox could not be reached and its health probe failed too (The operation was aborted due to timeout). It was not stopped by the factory.',
      }),
    ).toBe('environment')
    expect(retryableFailure({ error: 'the API could not be reached by the test' })).toBeNull()
  })

  // Ten theokit tasks sat in failed on this message, never retried, after e2b dropped their streams (2026-11-19).
  it('reads a sandbox whose stream dropped with its state unknown as the environment', () => {
    expect(
      retryableFailure({
        error:
          "[unavailable] the connection to sandbox is1o7eqprocq5135s0y3f ended before the stream completed: The sandbox could not be reached and its state is unknown — it may have been killed or reached its timeout, or the connection to it was lost. Check the sandbox state with 'Sandbox.getInfo()'.",
      }),
    ).toBe('environment')
  })

  it('leaves with a person an agent that used all its time, and still retries a command of the environment that timed out', () => {
    expect(
      retryableFailure({
        error:
          'the agent did not finish the rework: codex failed: timed out after 1500000 ms (exit 124)',
      }),
    ).toBeNull()
    expect(
      retryableFailure({
        error: 'the agent did not finish: codex failed: request timed out after 1500000 ms',
      }),
    ).toBeNull()
    expect(retryableFailure({ error: '[work] clone failed: timed out after 30000 ms' })).toBe(
      'environment',
    )
    expect(retryableFailure({ error: 'the agent did not finish: GitHub answered 502' })).toBe(
      'environment',
    )
  })
})

describe('the Merge column', () => {
  const card = (over: Partial<Pick<TaskCard, 'stage' | 'integrated' | 'waitingForChecks'>>) => ({
    stage: 'done' as Stage,
    integrated: false,
    waitingForChecks: false,
    ...over,
  })

  it('tells what approved work that is not integrated yet waits for', () => {
    expect(mergeState(card({ stage: 'merge' }))).toBe('merging')
    expect(mergeState(card({ stage: 'pr' }))).toBe('opening_pr')
    expect(mergeState(card({ waitingForChecks: true }))).toBe('waiting_for_checks')
    expect(mergeState(card({}))).toBe('awaiting_merge')
  })

  it('says nothing of integrated work or of a task outside the column', () => {
    expect(mergeState(card({ integrated: true }))).toBeNull()
    expect(mergeState(card({ stage: 'build' }))).toBeNull()
  })

  it('counts every card of the column in exactly one state', () => {
    const cards = [
      card({ waitingForChecks: true }),
      card({ waitingForChecks: true }),
      card({}),
      card({ stage: 'pr' }),
      card({ integrated: true }),
    ]

    expect(mergeBreakdown(cards)).toEqual({
      merging: 0,
      opening_pr: 1,
      waiting_for_checks: 2,
      awaiting_merge: 1,
    })
  })
})
