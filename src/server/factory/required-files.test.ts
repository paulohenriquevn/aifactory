import { describe, expect, it } from 'vitest'

import { errorLine, repairedChecks, withoutRequired, type CheckRun } from './required-files'

const check = { name: 'changeset', command: 'pnpm exec changeset status' }
const run = (sha: string, passed: boolean, extra: Partial<CheckRun> = {}): CheckRun => ({
  ...check,
  sha,
  passed,
  output: passed ? 'ok' : 'error no changesets were found',
  ...extra,
})

describe('repairedChecks', () => {
  it('finds a check that failed on one commit and passes on the next', () => {
    expect(repairedChecks([run('c1', false), run('c2', true)], ['c2', 'c1'])).toEqual([
      {
        ...check,
        error: 'error no changesets were found',
        failedSha: 'c1',
        passedSha: 'c2',
      },
    ])
  })

  it('finds nothing when the check never failed', () => {
    expect(repairedChecks([run('c1', true), run('c2', true)], ['c2', 'c1'])).toEqual([])
  })

  it('finds nothing when the check fails on the commit under review', () => {
    expect(repairedChecks([run('c1', false), run('c2', false)], ['c2', 'c1'])).toEqual([])
  })

  it('finds nothing when the check did not run on the commit under review', () => {
    expect(repairedChecks([run('c1', false), run('c2', true)], ['c3', 'c2', 'c1'])).toEqual([])
  })

  it('finds nothing when no commit is under review', () => {
    expect(repairedChecks([run('c1', false), run('c2', true)], [])).toEqual([])
  })

  it('reads the last result of a commit, as the gate does', () => {
    // A check that failed once and passed when run again on the same commit did not fail there.
    const flaky = [run('c1', false), run('c1', true), run('c2', true)]
    expect(repairedChecks(flaky, ['c2', 'c1'])).toEqual([])

    const failedTwice = [run('c1', false, { output: 'first' }), run('c1', false), run('c2', true)]
    expect(repairedChecks(failedTwice, ['c2', 'c1'])).toMatchObject([
      { failedSha: 'c1', error: 'error no changesets were found' },
    ])
  })

  it('ignores a result on a commit that is not part of the change', () => {
    expect(repairedChecks([run('old', false), run('c2', true)], ['c2', 'c1'])).toEqual([])
  })

  it('keeps the commit that repaired the check when later commits pass too', () => {
    const runs = [run('c1', false), run('c2', true), run('c3', true)]

    expect(repairedChecks(runs, ['c3', 'c2', 'c1'])).toMatchObject([
      { failedSha: 'c1', passedSha: 'c2' },
    ])
  })

  it('reads the commits in the order of the history, not of the results', () => {
    const runs = [run('c3', true), run('c2', true), run('c1', false)]

    expect(repairedChecks(runs, ['c3', 'c2', 'c1'])).toMatchObject([
      { failedSha: 'c1', passedSha: 'c2' },
    ])
  })

  it('takes the last repair when a check failed more than once', () => {
    const runs = [
      run('c1', false),
      run('c2', true),
      run('c3', false, { output: 'error again' }),
      run('c4', true),
    ]

    expect(repairedChecks(runs, ['c4', 'c3', 'c2', 'c1'])).toMatchObject([
      { failedSha: 'c3', passedSha: 'c4', error: 'error again' },
    ])
  })

  it('skips a commit the check did not run on', () => {
    const runs = [run('c1', false), run('c3', true)]

    expect(repairedChecks(runs, ['c3', 'c2', 'c1'])).toMatchObject([
      { failedSha: 'c1', passedSha: 'c3' },
    ])
  })

  it('reads each check on its own', () => {
    const tests = { name: 'test', command: 'npm test' }
    const runs = [run('c1', true, tests), run('c1', false), run('c2', true, tests), run('c2', true)]

    expect(repairedChecks(runs, ['c2', 'c1']).map((c) => c.name)).toEqual(['changeset'])
  })
})

describe('errorLine', () => {
  it('takes the first line that says error', () => {
    const output = [
      'info NO packages to be bumped at patch',
      '  error Some packages have been changed but no changesets were found.',
      'error If this change does not need a release, run `changeset add --empty`.',
    ].join('\n')

    expect(errorLine(output)).toBe(
      'error Some packages have been changed but no changesets were found.',
    )
  })

  it('prefers the line a test runner fails with', () => {
    expect(errorLine('ran 3 tests\n FAIL  src/a.test.ts > cuts\nerror Command failed')).toBe(
      'FAIL  src/a.test.ts > cuts',
    )
  })

  it('does not take a word that only contains "error"', () => {
    expect(errorLine('0 errors found\nnot ok 1 - truncates\n\n')).toBe('not ok 1 - truncates')
  })

  it('falls back to the last line, and says so when there is none', () => {
    expect(errorLine('one\ntwo\nthree\n')).toBe('three')
    expect(errorLine(' \n')).toBe('(no output)')
  })

  it('cuts a long line', () => {
    expect(errorLine(`error ${'x'.repeat(500)}`)).toHaveLength(300)
  })
})

describe('withoutRequired', () => {
  it('drops the files added for a check and keeps the rest', () => {
    const required = [{ files: ['.changeset/a.md'] }, { files: ['b.md'] }]

    expect(withoutRequired(['src/x.ts', '.changeset/a.md', 'b.md'], required)).toEqual(['src/x.ts'])
  })

  it('keeps every file when no check required one', () => {
    expect(withoutRequired(['src/x.ts'], [])).toEqual(['src/x.ts'])
  })
})
