import { describe, expect, it } from 'vitest'

import { patchProblem } from './work'

const agents = ['claude-code', 'codex']
const problem = (patch: Parameters<typeof patchProblem>[0]) => patchProblem(patch, agents)

describe('patchProblem', () => {
  it('has nothing to say about an empty patch or a good one', () => {
    expect(problem({})).toBeUndefined()
    expect(
      problem({
        enabled: true,
        checks: [{ name: 'unit', command: 'pnpm test' }],
        egress: ['pypi.org'],
        harness: 'codex',
        reviewer: 'claude-code',
        releaseMode: 'auto',
      }),
    ).toBeUndefined()
    expect(problem({ checks: null, harness: null, reviewer: null })).toBeUndefined()
  })

  it('allows exactly eight checks and twenty domains', () => {
    const checks = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `c${i}`, command: 'x' }))
    const domains = (n: number) => Array.from({ length: n }, (_, i) => `d${i}.com`)
    expect(problem({ checks: checks(8) })).toBeUndefined()
    expect(problem({ checks: checks(9) })).toBe('at most 8 checks')
    expect(problem({ egress: domains(20) })).toBeUndefined()
    expect(problem({ egress: domains(21) })).toBe('at most 20 domains')
  })

  it('takes check names of letters, digits, - and _, up to 31 characters, starting with a letter or digit', () => {
    const named = (name: string) => problem({ checks: [{ name, command: 'x' }] })
    for (const ok of ['a', '9lives', 'unit-test_2', 'a'.repeat(31)])
      expect(named(ok), ok).toBeUndefined()
    for (const bad of ['', 'Unit', '-a', '_a', 'a b', 'a'.repeat(32)]) {
      expect(named(bad), bad).toMatch(/is not a check name/)
    }
  })

  it('wants one line of at most 500 characters for each command, and distinct names', () => {
    const command = (c: string) => problem({ checks: [{ name: 'a', command: c }] })
    expect(command('x'.repeat(500))).toBeUndefined()
    expect(command('x'.repeat(501))).toMatch(/at most 500/)
    expect(command('   ')).toMatch(/one line/)
    expect(command('a\nb')).toMatch(/one line/)
    expect(
      problem({
        checks: [
          { name: 'a', command: 'x' },
          { name: 'a', command: 'y' },
        ],
      }),
    ).toBe('two checks are named "a"')
  })

  it('accepts a domain in any case, and refuses what is not a hostname', () => {
    expect(problem({ egress: ['PyPI.ORG'] })).toBeUndefined()
    expect(problem({ egress: ['pypi.org', 'localhost'] })).toBe('"localhost" is not a domain name')
  })

  it('names the known agents when one is not known, for the builder and the reviewer alike', () => {
    expect(problem({ harness: 'gpt' })).toBe('unknown agent "gpt" (known: claude-code, codex)')
    expect(problem({ reviewer: 'gpt' })).toBe('unknown reviewer "gpt" (known: claude-code, codex)')
  })
})

describe('patchProblem and the release branch', () => {
  it('accepts a branch name, and null to go back to the default branch', () => {
    expect(problem({ releaseBranch: 'main' })).toBeUndefined()
    expect(problem({ releaseBranch: null })).toBeUndefined()
  })

  it('refuses a name git would not take', () => {
    expect(problem({ releaseBranch: '--force' })).toBe('"--force" is not a branch name')
  })
})

describe('patchProblem and the branch', () => {
  it('accepts a branch name, and null to go back to the default', () => {
    expect(problem({ baseBranch: 'develop' })).toBeUndefined()
    expect(problem({ baseBranch: 'release/1.2' })).toBeUndefined()
    expect(problem({ baseBranch: null })).toBeUndefined()
  })

  it('refuses a name git would not take, and says which', () => {
    expect(problem({ baseBranch: '--upload-pack=x' })).toBe(
      '"--upload-pack=x" is not a branch name',
    )
    expect(problem({ baseBranch: 'a b' })).toBe('"a b" is not a branch name')
  })
})
