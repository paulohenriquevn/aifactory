import { describe, expect, it } from 'vitest'

import type { CommitChecks } from '../github/pulls'

import { classify } from './watch'

const run = (name: string, status: string, conclusion: string | null) => ({
  name,
  status,
  conclusion,
})
const checks = (
  runs: ReturnType<typeof run>[],
  statuses: CommitChecks['statuses'] = 'none',
): CommitChecks => ({
  checkRuns: runs,
  statuses,
})

describe('classify', () => {
  it('is green when every check finished well', () => {
    expect(
      classify(checks([run('ci', 'completed', 'success'), run('lint', 'completed', 'neutral')])),
    ).toEqual({
      state: 'green',
      failing: [],
    })
    expect(classify(checks([], 'success')).state).toBe('green')
  })

  it('is red as soon as one check failed, even while others still run', () => {
    expect(
      classify(checks([run('ci', 'completed', 'failure'), run('slow', 'in_progress', null)])),
    ).toEqual({ state: 'red', failing: ['ci'] })
    for (const conclusion of ['timed_out', 'action_required', 'startup_failure']) {
      expect(classify(checks([run('x', 'completed', conclusion)])).state).toBe('red')
    }
  })

  it('counts a failing commit status as red, and names it', () => {
    expect(classify(checks([run('ci', 'completed', 'success')], 'failure'))).toEqual({
      state: 'red',
      failing: ['commit status'],
    })
    expect(classify(checks([], 'error')).state).toBe('red')
  })

  it('does not call a commit broken because a run was cancelled or skipped', () => {
    expect(
      classify(
        checks([
          run('old', 'completed', 'cancelled'),
          run('opt', 'completed', 'skipped'),
          run('ci', 'completed', 'success'),
        ]),
      ).state,
    ).toBe('green')
  })

  it('is pending while something still runs', () => {
    expect(classify(checks([run('ci', 'queued', null)])).state).toBe('pending')
    expect(classify(checks([run('ci', 'completed', 'success')], 'pending')).state).toBe('pending')
  })

  it('is none, not green, when nothing reported at all', () => {
    expect(classify(checks([]))).toEqual({ state: 'none', failing: [] })
  })
})
