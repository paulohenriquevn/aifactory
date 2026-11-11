import { describe, expect, it } from 'vitest'

import {
  checkEvidence,
  findingSignature,
  recurrenceComment,
  issueBody,
  issueTitle,
  logEvidence,
  needsPerson,
  newIssuesCapFromEnv,
  promotionPullRequests,
  withEvidence,
  type FailedCheck,
} from './promotion'

describe('newIssuesCapFromEnv', () => {
  it('is three when nothing is set', () => {
    expect(newIssuesCapFromEnv({})).toBe(3)
  })

  it('takes a whole number, zero included', () => {
    expect(newIssuesCapFromEnv({ FACTORY_PROMOTION_ISSUES_PER_PASS: '10' })).toBe(10)
    expect(newIssuesCapFromEnv({ FACTORY_PROMOTION_ISSUES_PER_PASS: '0' })).toBe(0)
  })

  it('refuses anything else, naming the variable', () => {
    for (const value of ['-1', '2.5', 'many']) {
      expect(() => newIssuesCapFromEnv({ FACTORY_PROMOTION_ISSUES_PER_PASS: value })).toThrow(
        `FACTORY_PROMOTION_ISSUES_PER_PASS must be a whole number of issues, got ${value}`,
      )
    }
  })
})

const stamp = (line: string) => `2026-11-11T17:30:19.5575638Z ${line}`

describe('promotionPullRequests', () => {
  it('watches workspace into develop, develop into the release branch, and the version pull request', () => {
    expect(promotionPullRequests('main')).toEqual([
      { head: 'workspace', base: 'develop' },
      { head: 'develop', base: 'main' },
      { head: 'changeset-release/main', base: 'main' },
    ])
  })

  it('follows a release branch that is not main', () => {
    expect(promotionPullRequests('release').map((p) => p.base)).toEqual([
      'develop',
      'release',
      'release',
    ])
  })
})

describe('logEvidence', () => {
  it('keeps the error lines of a job log, without the timestamp or the colors', () => {
    const log = [
      stamp('##[group]Run pnpm test'),
      stamp('\u001b[31m FAIL \u001b[39m tests/memory.live.test.ts > recalls the fact'),
      stamp("AssertionError: expected 'I do not know' to contain 'jteygfst'"),
      stamp('all good here'),
      stamp('##[error]Process completed with exit code 1.'),
    ].join('\n')
    expect(logEvidence(log)).toEqual([
      'FAIL  tests/memory.live.test.ts > recalls the fact',
      "AssertionError: expected 'I do not know' to contain 'jteygfst'",
    ])
  })

  it('keeps an eslint error with the file it is in', () => {
    const log = [
      stamp('/home/runner/work/theokit/theokit/apps/theoclaw/tests/http-api.test.ts'),
      stamp('##[error]  259:114  error  Unexpected any  @typescript-eslint/no-explicit-any'),
      stamp('/home/runner/work/theokit/theokit/apps/theoclaw/tests/clean.test.ts'),
      stamp('✖ 1 problem (1 error, 0 warnings)'),
    ].join('\n')
    expect(logEvidence(log)).toEqual([
      'apps/theoclaw/tests/http-api.test.ts',
      '259:114  error  Unexpected any  @typescript-eslint/no-explicit-any',
      '✖ 1 problem (1 error, 0 warnings)',
    ])
  })

  it('keeps what knip reports under its heading', () => {
    const log = [
      stamp('Unused devDependencies (1)'),
      stamp('onnxruntime-node  packages/sdk/package.json:455:6'),
      stamp(''),
      stamp('> theokit-sdk-monorepo@ quality:public-surface'),
    ].join('\n')
    expect(logEvidence(log)).toEqual([
      'Unused devDependencies (1)',
      'onnxruntime-node  packages/sdk/package.json:455:6',
    ])
  })

  it('keeps a TypeScript error and drops the lines every failed job ends with', () => {
    const log = [
      stamp('src/a.ts(3,1): error TS2304: Cannot find name x.'),
      stamp('ELIFECYCLE  Command failed with exit code 1.'),
      stamp('ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  theoclaw@0.1.0 test'),
      stamp('##[error]at least one dependency did not succeed: see the table above.'),
    ].join('\n')
    expect(logEvidence(log)).toEqual(['src/a.ts(3,1): error TS2304: Cannot find name x.'])
  })

  it('says each line once, and stops at forty', () => {
    const repeated = Array.from({ length: 3 }, () => stamp('AssertionError: same')).join('\n')
    expect(logEvidence(repeated)).toEqual(['AssertionError: same'])
    const many = Array.from({ length: 60 }, (_, i) => stamp(`AssertionError: case ${i}`)).join('\n')
    expect(logEvidence(many)).toHaveLength(40)
  })

  it('cuts a very long line', () => {
    const line = `AssertionError: ${'x'.repeat(500)}`
    expect(logEvidence(stamp(line))[0]).toHaveLength(300)
  })

  it('finds nothing in a log with no error line', () => {
    expect(logEvidence([stamp('ok'), stamp('done')].join('\n'))).toEqual([])
  })

  it('strips a timestamp without fractions or a space after it, and keeps one in the middle', () => {
    expect(logEvidence('2026-11-11T17:30:19Z FAIL a')).toEqual(['FAIL a'])
    expect(logEvidence('2026-11-11T17:30:19.5ZFAIL b')).toEqual(['FAIL b'])
    expect(logEvidence('FAIL at 2026-11-11T17:30:19.5Z c')).toEqual([
      'FAIL at 2026-11-11T17:30:19.5Z c',
    ])
  })

  it('keeps an error named by its class, such as a TypeError', () => {
    expect(logEvidence(stamp('TypeError: cannot read x'))).toEqual(['TypeError: cannot read x'])
  })

  it('keeps a cross only when the line starts with it', () => {
    expect(logEvidence(stamp('✖ 3 problems'))).toEqual(['✖ 3 problems'])
    expect(logEvidence(stamp('built ✖ nothing'))).toEqual([])
  })

  it('reads a lint error with wide line and column numbers and any spacing', () => {
    const log = [stamp('/home/runner/work/r/r/src/a.ts'), stamp('120:45   error   no-x  rule')]
    expect(logEvidence(log.join('\n'))).toEqual(['src/a.ts', '120:45   error   no-x  rule'])
  })

  it('does not take a lint position in the middle of a line for a lint error', () => {
    expect(logEvidence(stamp('see 12:30 error codes'))).toEqual([])
    const log = [stamp('/x/src/a.ts'), stamp('FAIL near 12:30 error y')]
    expect(logEvidence(log.join('\n'))).toEqual(['FAIL near 12:30 error y'])
  })

  it('takes as a file only a line that is a path and nothing else', () => {
    const lint = stamp('1:2  error  rule')
    expect(logEvidence([stamp('at /x/a.ts'), lint].join('\n'))).toEqual(['1:2  error  rule'])
    expect(logEvidence([stamp('/x/a.ts extra'), lint].join('\n'))).toEqual(['1:2  error  rule'])
  })

  it('removes the runner checkout only at the start of a path', () => {
    const log = [stamp('/tmp/home/runner/work/r/r/a.ts'), stamp('1:2  error  rule')]
    expect(logEvidence(log.join('\n'))[0]).toBe('/tmp/home/runner/work/r/r/a.ts')
  })

  it('takes as a list heading only a whole line ending in its count', () => {
    expect(logEvidence(['Unused files (12)', 'a.ts', ''].join('\n'))).toEqual([
      'Unused files (12)',
      'a.ts',
    ])
    expect(logEvidence(['Unused files (1) found', 'a.ts', ''].join('\n'))).toEqual([])
    expect(logEvidence(['the Unused files (1)', 'a.ts', ''].join('\n'))).toEqual([])
  })
})

describe('checkEvidence', () => {
  it('gives the annotations, then the first lines of the summary', () => {
    expect(
      checkEvidence(['a.ts:1 Unused import'], '\n Quality Gate failed \n\n2 conditions\n'),
    ).toEqual(['a.ts:1 Unused import', 'Quality Gate failed', '2 conditions'])
  })

  it('takes ten summary lines, says each line once and stops at forty', () => {
    const summary = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    expect(checkEvidence([], summary)).toHaveLength(10)
    expect(checkEvidence(['same', 'same'], '')).toEqual(['same'])
    const many = Array.from({ length: 60 }, (_, i) => `a.ts:${i} x`)
    expect(checkEvidence(many, '')).toHaveLength(40)
    expect(checkEvidence([`a.ts:1 ${'y'.repeat(400)}`], '')[0]).toHaveLength(300)
  })
})

describe('recurrenceComment', () => {
  it('names the new commit, the promotion and the check', () => {
    const comment = recurrenceComment(
      { name: 'CI', url: 'https://github.com/o/r/runs/3', evidence: [] },
      {
        pullRequest: { number: 12, url: 'u' },
        head: 'develop',
        base: 'main',
        sha: 'beef1234567',
        rerun: true,
      },
    )
    expect(comment).toBe(
      'The same failure is back on `beef123`, the head of develop -> main (#12): https://github.com/o/r/runs/3',
    )
  })
})

describe('findingSignature', () => {
  it('is the same for the same failure on another commit, with other random values', () => {
    const a = findingSignature('Live model', [
      "AssertionError: expected 'x' to contain 'tok-e995236d5eeb'",
    ])
    const b = findingSignature('Live model', [
      "AssertionError: expected 'x' to contain 'tok-fb4d823c8edc'",
    ])
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('differs for another check or another failure', () => {
    const lines = ['FAIL tests/a.test.ts > one']
    expect(findingSignature('CI', lines)).not.toBe(findingSignature('lint', lines))
    expect(findingSignature('CI', lines)).not.toBe(
      findingSignature('CI', ['FAIL tests/a.test.ts > two']),
    )
  })

  it('ignores what a quoted string says, in single or double quotes', () => {
    expect(findingSignature('CI', ["expected 'foo'"])).toBe(
      findingSignature('CI', ["expected 'bar'"]),
    )
    expect(findingSignature('CI', ['expected "foo"'])).toBe(
      findingSignature('CI', ['expected "bar"']),
    )
  })

  it('ignores how many digits a number has', () => {
    expect(findingSignature('CI', ['took 5 ms'])).toBe(findingSignature('CI', ['took 12 ms']))
  })

  it('keeps short words and words that are not hexadecimal', () => {
    expect(findingSignature('CI', ['miss in bad'])).not.toBe(
      findingSignature('CI', ['miss in fed']),
    )
    expect(findingSignature('CI', ['ZZZZZZ'])).not.toBe(findingSignature('CI', ['YYYYYY']))
  })

  it('ignores the order the lines came in', () => {
    expect(findingSignature('CI', ['a', 'b'])).toBe(findingSignature('CI', ['b', 'a']))
  })
})

describe('needsPerson', () => {
  it('sends a secret scanner to a person, since it reads history no change can fix', () => {
    expect(needsPerson('trufflehog / TruffleHog')).toBe(true)
    expect(needsPerson('Secret Scan')).toBe(true)
    expect(needsPerson('gitleaks')).toBe(true)
  })

  it('leaves every other check to the factory', () => {
    expect(needsPerson('CI')).toBe(false)
    expect(needsPerson('CodeQL')).toBe(false)
  })
})

describe('withEvidence', () => {
  const failed = (name: string, evidence: string[]): FailedCheck => ({
    name,
    url: `https://github.com/o/r/runs/${name}`,
    evidence,
  })

  it('drops a check that only says another one failed, when that one says why', () => {
    const checks = [failed('CI', []), failed('validate', ['Unused devDependencies (1)'])]
    expect(withEvidence(checks).map((c) => c.name)).toEqual(['validate'])
  })

  it('keeps a check without evidence when it is the only failure', () => {
    expect(withEvidence([failed('CI', [])]).map((c) => c.name)).toEqual(['CI'])
  })
})

describe('the issue', () => {
  const check: FailedCheck = {
    name: 'validate (node 22.12)',
    url: 'https://github.com/o/r/actions/runs/1/job/2',
    evidence: ['Unused devDependencies (1)', 'onnxruntime-node  packages/sdk/package.json:455:6'],
  }
  const at = {
    pullRequest: { number: 979, url: 'https://github.com/o/r/pull/979' },
    head: 'workspace',
    base: 'develop',
    sha: 'acf5736aaaa',
    rerun: true,
  }

  it('names the check and the promotion in its title', () => {
    expect(issueTitle(check, at)).toBe(
      'promotion: `validate (node 22.12)` fails on workspace -> develop',
    )
  })

  it('carries the run, the commit and the lines the log showed', () => {
    const body = issueBody(check, at)
    expect(body).toContain('https://github.com/o/r/actions/runs/1/job/2')
    expect(body).toContain('#979')
    expect(body).toContain('`acf5736`')
    expect(body).toContain('onnxruntime-node  packages/sdk/package.json:455:6')
    expect(body).toContain('after a rerun')
    expect(body).not.toContain('a person decides')
  })

  it('goes from the description straight to the evidence when the factory can fix it', () => {
    const lines = issueBody(check, at).split('\n')
    const description = lines.findIndex((line) => line.startsWith('The check '))
    expect(lines.slice(description + 1, description + 3)).toEqual(['', '## Evidence'])
  })

  it('says a check it could not rerun was not rerun', () => {
    expect(issueBody(check, { ...at, rerun: false })).toContain('was not rerun')
  })

  it('tells a person why the factory leaves a secret scanner to them', () => {
    expect(issueBody({ ...check, name: 'trufflehog / TruffleHog' }, at)).toContain(
      'a person decides',
    )
  })

  it('keeps a fence in the log from breaking the evidence block', () => {
    const body = issueBody({ ...check, evidence: ['~~~~ injected', 'ok'] }, at)
    expect(body.match(/^~~~~/gm)).toHaveLength(2)
  })

  it('says when the log had no line to show', () => {
    expect(issueBody({ ...check, evidence: [] }, at)).toContain('No error line')
  })
})
