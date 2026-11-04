import { describe, expect, it } from 'vitest'

import { diffGuards, parseNameStatus, testScriptOf } from './guards'
import { parseVerdict, renderFindings, reviewPrompt, reworkPrompt } from './review'

const answer = (verdict: unknown) => `I read the diff.\n\n${JSON.stringify(verdict)}`

describe('parseVerdict', () => {
  it('reads an approval and a request for changes at the end of an answer', () => {
    expect(parseVerdict(answer({ verdict: 'approve', summary: 'good', findings: [] }))).toEqual({
      verdict: 'approve',
      summary: 'good',
      findings: [],
    })
    const changes = parseVerdict(
      answer({
        verdict: 'changes',
        summary: 'bug',
        findings: [{ severity: 'blocker', file: 'a.js', issue: 'off by one' }],
      }),
    )
    expect(changes).toMatchObject({
      verdict: 'changes',
      findings: [{ severity: 'blocker', file: 'a.js', issue: 'off by one' }],
    })
  })

  it('takes the last verdict, not an example in the middle of the answer', () => {
    const text = `For example {"verdict":"approve"} is what I write when fine.\n${JSON.stringify({ verdict: 'changes', summary: 'no', findings: [] })}`
    expect(parseVerdict(text).verdict).toBe('changes')
  })

  it('finds a verdict whose text contains braces and quotes', () => {
    const text = answer({
      verdict: 'changes',
      summary: 'uses "{}" wrongly',
      findings: [{ severity: 'major', issue: 'object is {a: 1} not "{}"' }],
    })
    expect(parseVerdict(text).verdict).toBe('changes')
  })

  it('is invalid without a verdict, with a word that is neither, or with broken JSON', () => {
    expect(parseVerdict('Looks great!').verdict).toBe('invalid')
    expect(parseVerdict(answer({ verdict: 'maybe' })).verdict).toBe('invalid')
    expect(parseVerdict('{"verdict":"approve",').verdict).toBe('invalid')
    expect(parseVerdict('').verdict).toBe('invalid')
  })

  it('does not read a kinder verdict into an approval that lists a blocker or a major finding', () => {
    for (const severity of ['blocker', 'major']) {
      const result = parseVerdict(
        answer({ verdict: 'approve', summary: 's', findings: [{ severity, issue: 'bad' }] }),
      )
      expect(result.verdict).toBe('invalid')
    }
    expect(
      parseVerdict(answer({ verdict: 'approve', findings: [{ severity: 'minor', issue: 'nit' }] }))
        .verdict,
    ).toBe('approve')
  })

  it('cleans findings: unknown severity becomes major, empty ones go, long ones are cut', () => {
    const result = parseVerdict(
      answer({
        verdict: 'changes',
        findings: [{ severity: 'urgent', issue: 'x'.repeat(2000) }, { issue: '' }, 'not an object'],
      }),
    )
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].severity).toBe('major')
    expect(result.findings[0].issue).toHaveLength(600)
  })
})

describe('prompts', () => {
  it('tells the reviewer the base commit and not to write', () => {
    const prompt = reviewPrompt({
      repo: 'o/r',
      issueNumber: 3,
      title: 'T',
      body: 'B',
      branch: 'factory/3',
      baseSha: 'abc',
    })
    expect(prompt).toContain('git diff abc...HEAD')
    expect(prompt).toContain('Do not edit, create or delete files')
    expect(prompt).toContain('"verdict"')
  })

  it('gives the builder the failing output and the findings, and forbids committing', () => {
    const prompt = reworkPrompt({
      findings: [{ severity: 'major', file: 'a.js', issue: 'rejects nothing' }],
      failedChecks: [{ command: 'npm test', output: 'not ok 2 - fails' }],
    })
    expect(prompt).toContain('`npm test` output')
    expect(prompt).toContain('not ok 2 - fails')
    expect(prompt).toContain('**major** `a.js`: rejects nothing')
    expect(prompt).toContain('Do not run git commit or git push')
  })

  it('renders findings as a list', () => {
    expect(renderFindings([{ severity: 'minor', issue: 'nit' }])).toBe('- **minor**: nit')
  })
})

describe('diffGuards', () => {
  const clean = { changes: [], baseTestScript: 'node --test', headTestScript: 'node --test' }

  it('says nothing about a diff that only adds code and tests', () => {
    expect(
      diffGuards({
        ...clean,
        changes: [
          { status: 'A', path: 'src/x.js' },
          { status: 'A', path: 'src/x.test.js' },
        ],
      }),
    ).toEqual([])
  })

  it('blocks a change to the command the checks run, and to .github', () => {
    const findings = diffGuards({
      changes: [{ status: 'M', path: '.github/workflows/ci.yml' }],
      baseTestScript: 'node --test',
      headTestScript: 'true',
    })
    expect(findings.map((f) => [f.severity, f.file])).toEqual([
      ['blocker', '.github/workflows/ci.yml'],
      ['blocker', 'package.json'],
    ])
  })

  it('flags a deleted test file but not a deleted source file', () => {
    const findings = diffGuards({
      ...clean,
      changes: [
        { status: 'D', path: 'src/x.test.js' },
        { status: 'D', path: 'tests/y.js' },
        { status: 'D', path: 'src/old.js' },
      ],
    })
    expect(findings.map((f) => f.file)).toEqual(['src/x.test.js', 'tests/y.js'])
  })

  it('treats a new test script on a repository that had none as a change', () => {
    const findings = diffGuards({
      changes: [],
      baseTestScript: undefined,
      headTestScript: 'node --test',
    })
    expect(findings).toHaveLength(1)
  })
})

describe('git output readers', () => {
  it('reads name-status lines, renames included', () => {
    expect(parseNameStatus('A\ta.js\nM\tb.js\nR100\told.js\tnew.js\n')).toEqual([
      { status: 'A', path: 'a.js' },
      { status: 'M', path: 'b.js' },
      { status: 'R', path: 'new.js' },
    ])
    expect(parseNameStatus('')).toEqual([])
  })

  it('reads the test script, and nothing from missing or broken JSON', () => {
    expect(testScriptOf('{"scripts":{"test":"node --test"}}')).toBe('node --test')
    expect(testScriptOf('{"scripts":{}}')).toBeUndefined()
    expect(testScriptOf('not json')).toBeUndefined()
    expect(testScriptOf(undefined)).toBeUndefined()
  })
})
