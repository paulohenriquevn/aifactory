import { describe, expect, it } from 'vitest'

import { columnOf, COLUMNS, retryableFailure, type Column, type Stage } from './panel'

describe('columnOf', () => {
  const expected: Record<Stage, Column> = {
    intake: 'queued',
    sandbox: 'working',
    build: 'working',
    push: 'working',
    verify: 'working',
    review: 'working',
    pr: 'working',
    waiting: 'waiting',
    done: 'review',
    released: 'released',
    handoff: 'attention',
    failed: 'attention',
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
      'review',
      'released',
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
      'Delivered',
      'Released',
      'Needs a person',
    ])
  })
})

describe('a failure that passes by itself', () => {
  it('goes to its own column, only when the task failed', () => {
    expect(columnOf('failed', 'quota')).toBe('retrying')
    expect(columnOf('failed', 'environment')).toBe('retrying')
    expect(columnOf('failed', null)).toBe('attention')
    expect(columnOf('failed')).toBe('attention')
    expect(columnOf('build', 'quota')).toBe('working')
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
