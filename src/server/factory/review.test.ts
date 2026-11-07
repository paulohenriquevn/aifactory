import { describe, expect, it } from 'vitest'

import { diffGuards, parseNameStatus, testScriptOf } from './guards'
import { parseVerdict, renderFindings, resolvedPrompt, reviewPrompt, reworkPrompt } from './review'

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

describe('reading a verdict, at its edges', () => {
  it('says the reviewer did not end with a verdict, with no findings, when there is none', () => {
    expect(parseVerdict('no json here')).toEqual({
      verdict: 'invalid',
      summary: 'the reviewer did not end with a verdict',
      findings: [],
    })
  })

  it('takes no findings from something that is not a list, and skips entries that are not objects', () => {
    expect(parseVerdict(answer({ verdict: 'changes', findings: 'oops' })).findings).toEqual([])
    const result = parseVerdict(
      answer({
        verdict: 'changes',
        findings: [null, 5, 'x', { severity: 'minor', issue: 'real' }],
      }),
    )
    expect(result.findings).toEqual([{ severity: 'minor', issue: 'real' }])
  })

  it('cuts a file name to 200 characters and a summary to 600', () => {
    const result = parseVerdict(
      answer({
        verdict: 'changes',
        summary: 'S'.repeat(900),
        findings: [{ severity: 'major', file: 'f'.repeat(500), issue: 'x' }],
      }),
    )
    expect(result.summary).toHaveLength(600)
    expect(result.findings[0].file).toHaveLength(200)
  })

  it('keeps an absent summary empty instead of writing the word undefined', () => {
    expect(parseVerdict(answer({ verdict: 'changes' })).summary).toBe('')
  })
})

describe('what the builder is told, at its edges', () => {
  it('mentions failing checks only when there are some, and findings only when there are some', () => {
    const none = reworkPrompt({ findings: [], failedChecks: [] })
    expect(none).toContain('Your change was not accepted.')
    expect(none).not.toContain('These checks failed')
    expect(none).not.toContain('A reviewer found')

    const checks = reworkPrompt({
      findings: [],
      failedChecks: [{ command: 'npm test', output: 'x' }],
    })
    expect(checks).toContain('These checks failed on your commit:')
    expect(checks).not.toContain('A reviewer found')

    const findings = reworkPrompt({
      findings: [{ severity: 'major', issue: 'bad' }],
      failedChecks: [],
    })
    expect(findings).toContain('A reviewer found:')
    expect(findings).not.toContain('These checks failed')
  })

  it('shows the end of a long output, where the failure is, and not the start', () => {
    const output = `START${'.'.repeat(3_000)}THE-FAILURE`
    const prompt = reworkPrompt({ findings: [], failedChecks: [{ command: 'npm test', output }] })
    expect(prompt).toContain('THE-FAILURE')
    expect(prompt).not.toContain('START')
  })
})

describe('guards, at their edges', () => {
  it('ignores lines that are not a change: blank, or a status with no path', () => {
    expect(parseNameStatus('\n\nM\n\tonly-a-tab\nA\tok.js\n')).toEqual([
      { status: 'A', path: 'ok.js' },
    ])
  })

  it('knows a test file by its folder or its name, and not by containing the word', () => {
    const deleted = (path: string) =>
      diffGuards({ changes: [{ status: 'D', path }], baseTestScript: 't', headTestScript: 't' })
    for (const path of [
      'src/__tests__/a.js',
      'tests/a.js',
      'src/test/a.js',
      'spec/a.ts',
      'a.spec.ts',
      'a.test.js',
    ]) {
      expect(deleted(path), path).toHaveLength(1)
    }
    for (const path of ['src/contest/a.js', 'a.testing.js', 'src/attest.js', 'inspector.js']) {
      expect(deleted(path), path).toHaveLength(0)
    }
  })

  it('reads a test script of the wrong type as none, and says null for a missing one in the finding', () => {
    expect(testScriptOf('{"scripts":{"test":5}}')).toBeUndefined()
    const [finding] = diffGuards({
      changes: [],
      baseTestScript: undefined,
      headTestScript: 'node --test',
    })
    expect(finding.issue).toContain('from null to "node --test"')
    const [other] = diffGuards({
      changes: [],
      baseTestScript: 'node --test',
      headTestScript: undefined,
    })
    expect(other.issue).toContain('from "node --test" to null')
  })
})

describe('resolvedPrompt', () => {
  const input = {
    repo: 'o/r',
    issueNumber: 3,
    title: 'Crash on empty input',
    body: 'It throws on an empty string.',
    baseSha: 'abc1234',
    claim: 'Fixed by commit 9f00 in src/parse.ts, tested in tests/parse.test.ts.',
  }

  it("asks the reviewer to check the builder's claim against the code at the commit, not to trust it", () => {
    const prompt = resolvedPrompt(input)
    expect(prompt).toContain('# Crash on empty input (#3)')
    expect(prompt).toContain('It throws on an empty string.')
    expect(prompt).toContain('at abc1234')
    expect(prompt).toContain('Fixed by commit 9f00 in src/parse.ts')
    expect(prompt).toMatch(/claim, not evidence/)
    expect(prompt).toContain('Do not edit, create or delete files')
  })

  it('says what each verdict means, so an approval closes the issue', () => {
    const prompt = resolvedPrompt(input)
    expect(prompt).toMatch(
      /"approve" only when everything the issue asks for is already in the code/,
    )
    expect(prompt).toMatch(/the issue is closed/)
    expect(prompt).toContain('"verdict"')
  })

  it('says when the issue has no description', () => {
    expect(resolvedPrompt({ ...input, body: '' })).toContain('(the issue has no description)')
  })
})
