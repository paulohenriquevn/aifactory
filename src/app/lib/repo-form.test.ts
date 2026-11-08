import { describe, expect, it } from 'vitest'

import { formatChecks, formatDomains, parseChecks, parseDomains } from './repo-form'

describe('checks as text', () => {
  it('reads one check per line as name: command, and keeps a colon inside the command', () => {
    expect(parseChecks('unit: pnpm test\ntypes: pnpm exec tsc --noEmit -p a:b')).toEqual([
      { name: 'unit', command: 'pnpm test' },
      { name: 'types', command: 'pnpm exec tsc --noEmit -p a:b' },
    ])
  })

  it('names a line with no name after its first word, and skips blank lines', () => {
    expect(parseChecks('\n  pnpm test  \n\npytest -q\n')).toEqual([
      { name: 'pnpm', command: 'pnpm test' },
      { name: 'pytest', command: 'pytest -q' },
    ])
  })

  it('does not take a command with a colon for a name', () => {
    expect(parseChecks('python -c "print(1:2)"')).toEqual([
      { name: 'python', command: 'python -c "print(1:2)"' },
    ])
    expect(parseChecks('./run.sh')).toEqual([{ name: 'runsh', command: './run.sh' }])
    expect(parseChecks('!!!')).toEqual([{ name: 'check', command: '!!!' }])
  })

  it('writes checks back the way they are read, and nothing for none', () => {
    const checks = [
      { name: 'unit', command: 'pnpm test' },
      { name: 'lint', command: 'pnpm lint' },
    ]
    expect(parseChecks(formatChecks(checks))).toEqual(checks)
    expect(formatChecks(null)).toBe('')
    expect(formatChecks([])).toBe('')
  })
})

describe('domains as text', () => {
  it('splits on commas, spaces and lines, lowercases, and drops empties', () => {
    expect(parseDomains('PyPI.org, files.pythonhosted.org\n  crates.io ,')).toEqual([
      'pypi.org',
      'files.pythonhosted.org',
      'crates.io',
    ])
    expect(parseDomains('  ')).toEqual([])
    expect(formatDomains(['a.com', 'b.com'])).toBe('a.com\nb.com')
  })
})

describe('checks as text, at their edges', () => {
  it('takes a one-word command as its own name', () => {
    expect(parseChecks('make')).toEqual([{ name: 'make', command: 'make' }])
  })

  it('ignores spaces around the name and the colon', () => {
    expect(parseChecks('unit : pnpm test')).toEqual([{ name: 'unit', command: 'pnpm test' }])
    expect(parseChecks('  unit:pnpm test  ')).toEqual([{ name: 'unit', command: 'pnpm test' }])
  })

  it('does not take a line that starts with a colon for a name', () => {
    expect(parseChecks(':rest')).toEqual([{ name: 'rest', command: ':rest' }])
  })
})
