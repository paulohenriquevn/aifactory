import { describe, expect, it } from 'vitest'

import { columnOf, COLUMNS, type Column, type Stage } from './panel'

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
      'Pull request',
      'Released',
      'Needs a person',
    ])
  })
})
