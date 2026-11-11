import { describe, expect, it } from 'vitest'

import { passLog, type PromotionWatchResult } from './promotion-watch'

const quiet: PromotionWatchResult = { reruns: 0, opened: [], commented: [], capped: 0, errors: [] }

describe('passLog', () => {
  it('says nothing for a pass that did nothing', () => {
    expect(passLog(quiet)).toEqual([])
  })

  it('logs a pass that reran, opened, commented or held back', () => {
    for (const result of [
      { ...quiet, reruns: 1 },
      { ...quiet, opened: ['u'] },
      { ...quiet, commented: ['o/r#1'] },
      { ...quiet, capped: 1 },
    ]) {
      const lines = passLog(result)
      expect(lines).toHaveLength(1)
      expect(lines[0].level).toBe('log')
      expect(JSON.parse(lines[0].line)).toEqual({
        event: 'watch_promotions',
        reruns: result.reruns,
        opened: result.opened,
        commented: result.commented,
        capped: result.capped,
      })
    }
  })

  it('reports the errors as errors, apart from what was done', () => {
    const lines = passLog({ ...quiet, opened: ['u'], errors: ['o/r: refused'] })
    expect(lines.map((l) => l.level)).toEqual(['error', 'log'])
    expect(JSON.parse(lines[0].line)).toEqual({
      event: 'watch_promotions_failed',
      errors: ['o/r: refused'],
    })
  })
})
