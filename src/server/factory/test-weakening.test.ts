import { describe, expect, it } from 'vitest'

import { parsePatch, testWeakening, TEST_FILE, TEST_PATHSPECS } from './test-weakening'

/** A unified diff of one file, as `git diff -U0` prints it. */
function patchOf(path: string, lines: string[], header: string[] = []): string {
  return [
    `diff --git a/${path} b/${path}`,
    ...header,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    ...lines,
  ].join('\n')
}

const feature = { labels: ['factory'], title: 'Add a flag', body: 'Add --flag to the CLI.' }
const bug = { labels: ['bug'], title: 'The parser drops the last line', body: 'It drops it.' }

describe('parsePatch', () => {
  it('reads each file with its added and removed lines', () => {
    const files = parsePatch(
      patchOf('src/a.test.ts', ['-  expect(a).toBe(1)', '+  expect(a).toBe(2)']) +
        '\n' +
        patchOf('src/b.test.ts', ['+it("new", () => {})'], ['new file mode 100644']),
    )
    expect(files).toEqual([
      {
        path: 'src/a.test.ts',
        isNew: false,
        added: ['  expect(a).toBe(2)'],
        removed: ['  expect(a).toBe(1)'],
      },
      { path: 'src/b.test.ts', isNew: true, added: ['it("new", () => {})'], removed: [] },
    ])
  })

  it('does not take the file headers for lines', () => {
    const [file] = parsePatch(patchOf('x.test.ts', ['+ok']))
    expect(file.added).toEqual(['ok'])
    expect(file.removed).toEqual([])
  })

  it('reads a removed line that starts with dashes as content, not as a header', () => {
    const [file] = parsePatch(patchOf('tests/test_q.py', ['-- SELECT 1', '+++ x']))
    expect(file.removed).toEqual(['- SELECT 1'])
    expect(file.added).toEqual(['++ x'])
  })

  it('reads nothing from an empty diff', () => {
    expect(parsePatch('')).toEqual([])
  })

  it('ignores what comes before the first file', () => {
    expect(parsePatch(`+stray\n-stray\n${patchOf('a.test.ts', ['+ok'])}`)).toEqual([
      { path: 'a.test.ts', isNew: false, added: ['ok'], removed: [] },
    ])
  })

  it('reads a hunk header that carries the enclosing function, as git prints it', () => {
    const patch = [
      'diff --git a/a.test.ts b/a.test.ts',
      '--- a/a.test.ts',
      '+++ b/a.test.ts',
      "@@ -3 +2,0 @@ describe('parse', () => {",
      '-  expect(a).toBe(1)',
    ].join('\n')
    expect(parsePatch(patch)[0].removed).toEqual(['  expect(a).toBe(1)'])
  })

  it('does not take a line that mentions a diff for the start of another file', () => {
    const [file, ...rest] = parsePatch(patchOf('a.test.ts', ['+// diff --git a/x b/y']))
    expect(rest).toEqual([])
    expect(file.added).toEqual(['// diff --git a/x b/y'])
  })

  it('does not count the note git adds about a missing newline', () => {
    const [file] = parsePatch(patchOf('a.test.ts', ['-old', '\\ No newline at end of file']))
    expect(file.removed).toEqual(['old'])
  })
})

describe('TEST_FILE', () => {
  it.each([
    'src/a.test.ts',
    'src/a.spec.js',
    'tests/helpers.py',
    'pkg/__tests__/x.ts',
    'test_parse.py',
    'lib/test_parse.py',
    'parse_test.go',
    'parse_test.py',
  ])('takes %s for a test', (path) => {
    expect(TEST_FILE.test(path)).toBe(true)
  })

  it.each([
    'dist/a.test.js.map',
    'lib/test_parse.pyc',
    'parse_test.golden',
    'src/latest.ts',
    'contest_x.py',
  ])('does not take %s for a test', (path) => {
    expect(TEST_FILE.test(path)).toBe(false)
  })
})

describe('testWeakening', () => {
  it('reports a test case whose name leaves the diff', () => {
    const patch = patchOf('src/parse.test.ts', [
      "-  it('keeps the last line', () => {",
      '-    expect(parse("a\\nb")).toEqual(["a", "b"])',
      '-  })',
    ])
    const [finding] = testWeakening({ patch, issue: feature })
    expect(finding.file).toBe('src/parse.test.ts')
    expect(finding.issue).toContain('"keeps the last line"')
    expect(finding.issue).toContain('1 assertion fewer')
  })

  it('reports nothing when an assertion is rewritten in place', () => {
    const patch = patchOf('src/parse.test.ts', ['-    expect(a).toBe(1)', '+    expect(a).toBe(2)'])
    expect(testWeakening({ patch, issue: feature })).toEqual([])
  })

  it('reports nothing when a test moves to another file under the same name', () => {
    const patch =
      patchOf('src/old.test.ts', ['-  it("parses a list", () => {', '-    expect(x).toBe(1)']) +
      '\n' +
      patchOf(
        'src/new.test.ts',
        ['+  it("parses a list", () => {', '+    expect(x).toBe(1)'],
        ['new file mode 100644'],
      )
    expect(testWeakening({ patch, issue: feature })).toEqual([])
  })

  it('counts the assertions a test that moved left behind', () => {
    const patch =
      patchOf('src/old.test.ts', [
        '-  it("parses a list", () => {',
        '-    expect(x).toBe(1)',
        '-    expect(y).toBe(2)',
      ]) +
      '\n' +
      patchOf('src/new.test.ts', ['+  it("parses a list", () => {', '+    expect(x).toBe(1)'])
    const [finding] = testWeakening({ patch, issue: feature })
    expect(finding.file).toBe('src/old.test.ts')
    expect(finding.issue).toBe(
      'the change weakens a test that was there before it: it leaves 1 assertion fewer',
    )
  })

  it('counts an assertion once when a test is rewritten under the same name in its own file', () => {
    const patch = patchOf('src/a.test.ts', [
      '-  it("parses a list", () => {',
      '-    expect(x).toBe(1)',
      '-    expect(y).toBe(2)',
      '+  it("parses a list", () => {',
      '+    expect(x).toBe(1)',
    ])
    expect(testWeakening({ patch, issue: feature })[0].issue).toContain('1 assertion fewer')
  })

  it('names how many cases went, in the singular and the plural', () => {
    const one = patchOf('src/a.test.ts', ['-  it("parses a list", () => {})'])
    const two = patchOf('src/a.test.ts', [
      '-  it("parses a list", () => {})',
      '-  it("parses a map", () => {})',
    ])
    expect(testWeakening({ patch: one, issue: feature })[0].issue).toContain(
      'removes 1 test case (',
    )
    expect(testWeakening({ patch: two, issue: feature })[0].issue).toContain(
      'removes 2 test cases ("parses a list", "parses a map")',
    )
  })

  it.each([
    ["it.each([1, 2])('doubles %s', (n) => {", 'doubles %s'],
    ["it ('spaced', () => {", 'spaced'],
    ["it( 'padded', () => {", 'padded'],
    ['def  test_spaced():', 'test_spaced'],
    ['func  TestSpaced(t *testing.T) {', 'TestSpaced'],
  ])('reads the name of the case in %s', (line, name) => {
    const patch = patchOf('src/a.test.ts', [`-${line}`])
    expect(testWeakening({ patch, issue: feature })[0].issue).toContain(`"${name}"`)
  })

  it.each([
    'expect (a).toBe(1)',
    'assert(a)',
    'assert x == 1',
    'assertEqual(a, 1)',
    'assert.strictEqual(a, 1)',
    't.Fatalf("x")',
  ])('counts %s as an assertion', (line) => {
    const patch = patchOf('src/a.test.ts', [`-${line}`])
    expect(testWeakening({ patch, issue: feature })[0].issue).toContain('1 assertion fewer')
  })

  it.each(['const total = expectedTotal(cart)', 'const ok = assertive'])(
    'does not count %s as an assertion',
    (line) => {
      const patch = patchOf('src/a.test.ts', [`-${line}`])
      expect(testWeakening({ patch, issue: feature })).toEqual([])
    },
  )

  it('does not report a skip the change took away', () => {
    const patch = patchOf('src/a.test.ts', [
      '-  it.skip("works", () => {',
      '+  it("works", () => {',
    ])
    expect(testWeakening({ patch, issue: feature })).toEqual([])
  })

  it('names the skip it found, among the other lines it added', () => {
    const patch = patchOf('src/a.test.ts', ['+  const n = 1', '+  it.only("works", () => {'])
    expect(testWeakening({ patch, issue: feature })[0].issue).toBe(
      'the change weakens a test that was there before it: it adds it.only',
    )
  })

  it('reports a skip added to a test that existed', () => {
    const patch = patchOf('src/a.test.ts', [
      '-  it("works", () => {',
      '+  it.skip("works", () => {',
    ])
    const [finding] = testWeakening({ patch, issue: feature })
    expect(finding.issue).toContain('it.skip')
  })

  it.each([
    ['it.only("x", () => {})'],
    ['test.todo("x")'],
    ['describe.skip("x", () => {})'],
    ['xit("x", () => {})'],
    ['xdescribe("x", () => {})'],
    ['@pytest.mark.skip(reason="later")'],
    ['t.Skip("later")'],
  ])('reports %s added to a test file that existed', (line) => {
    const patch = patchOf('src/a.test.ts', [`+${line}`])
    expect(testWeakening({ patch, issue: feature })).toHaveLength(1)
  })

  it('reports a net loss of assertions in a file that existed', () => {
    const patch = patchOf('src/a.test.ts', [
      '-    expect(a).toBe(1)',
      '-    expect(b).toBe(2)',
      '+    expect(a).toBe(1)',
    ])
    const [finding] = testWeakening({ patch, issue: feature })
    expect(finding.issue).toContain('1 assertion fewer')
  })

  it('counts every assertion on a line', () => {
    const patch = patchOf('src/a.test.ts', ['-    expect(a).toBe(1); expect(b).toBe(2)'])
    const [finding] = testWeakening({ patch, issue: feature })
    expect(finding.issue).toContain('2 assertions fewer')
  })

  it('reads Python and Go tests too', () => {
    const python = patchOf('tests/test_parse.py', [
      '-def test_last_line():',
      '-    assert parse("a") == ["a"]',
    ])
    const go = patchOf('parse_test.go', ['-func TestLastLine(t *testing.T) {', '-\tt.Errorf("x")'])
    const findings = testWeakening({ patch: `${python}\n${go}`, issue: feature })
    expect(findings.map((f) => f.file)).toEqual(['tests/test_parse.py', 'parse_test.go'])
    expect(findings[0].issue).toContain('"test_last_line"')
    expect(findings[1].issue).toContain('"TestLastLine"')
  })

  it('leaves alone a file that is not a test', () => {
    const patch = patchOf('src/parse.ts', ['-  it("x", () => {})', '-  expect(a).toBe(1)'])
    expect(testWeakening({ patch, issue: feature })).toEqual([])
  })

  it('leaves alone a test file the run added', () => {
    const patch = patchOf(
      'src/a.test.ts',
      ['+it.skip("later", () => {})'],
      ['new file mode 100644'],
    )
    expect(testWeakening({ patch, issue: feature })).toEqual([])
  })

  it('leaves a deleted test file to the guard that reports deletions', () => {
    const patch = patchOf(
      'src/a.test.ts',
      ['-it("x", () => { expect(1).toBe(1) })'],
      ['deleted file mode 100644'],
    )
    expect(testWeakening({ patch, issue: feature })).toEqual([])
  })

  it('reports nothing for a change that only adds tests', () => {
    const patch = patchOf('src/a.test.ts', ['+  it("new", () => {', '+    expect(a).toBe(1)'])
    expect(testWeakening({ patch, issue: feature })).toEqual([])
  })

  it('is a blocker in a bug fix and major in other work', () => {
    const patch = patchOf('src/a.test.ts', ['-  expect(a).toBe(1)'])
    expect(testWeakening({ patch, issue: bug })[0].severity).toBe('blocker')
    expect(testWeakening({ patch, issue: feature })[0].severity).toBe('major')
  })

  it('is a blocker when the bug label is one among others', () => {
    const patch = patchOf('src/a.test.ts', ['-  expect(a).toBe(1)'])
    const issue = { ...bug, labels: ['factory', 'bug'] }
    expect(testWeakening({ patch, issue })[0].severity).toBe('blocker')
  })

  it('reads the bug label whatever its case', () => {
    const patch = patchOf('src/a.test.ts', ['-  expect(a).toBe(1)'])
    expect(testWeakening({ patch, issue: { ...bug, labels: ['Bug'] } })[0].severity).toBe('blocker')
  })

  it('is minor, for the reviewer to judge, when the issue names the file', () => {
    const patch = patchOf('src/legacy/a.test.ts', ['-  expect(a).toBe(1)'])
    const issue = { ...bug, body: 'Remove the legacy mode and its tests in a.test.ts.' }
    const [finding] = testWeakening({ patch, issue })
    expect(finding.severity).toBe('minor')
    expect(finding.issue).toContain('the issue names it')
  })

  it('is minor when the issue names a removed test', () => {
    const patch = patchOf('src/a.test.ts', ['-  it("accepts the old flag", () => {'])
    const issue = {
      ...feature,
      title: 'Drop the old flag',
      body: 'The test "accepts the old flag" goes too.',
    }
    expect(testWeakening({ patch, issue })[0].severity).toBe('minor')
  })

  it('does not take a short common word in the issue for the file name', () => {
    const patch = patchOf('src/a.test.ts', ['-  expect(a).toBe(1)'])
    expect(testWeakening({ patch, issue: { ...feature, body: 'a test' } })[0].severity).toBe(
      'major',
    )
  })
})

describe('a test retitled in its own file', () => {
  const retitle = [
    "-  it('the real ledger holds exactly the 113 source ids', () => {",
    "+  it('the real ledger holds exactly the 114 source ids', () => {",
    '-    expect(ids).toHaveLength(113)',
    '+    expect(ids).toHaveLength(114)',
  ]

  it('is not a removed case when the file keeps its assertions', () => {
    const patch = patchOf('tools/check-parity-ledger.test.mjs', retitle)
    expect(testWeakening({ patch, issue: feature })).toEqual([
      {
        severity: 'minor',
        file: 'tools/check-parity-ledger.test.mjs',
        issue:
          'the change retitles 1 test case (the file lost "the real ledger holds exactly the 113 source ids" and gained "the real ledger holds exactly the 114 source ids"), and the file keeps its assertions; judge whether the new title still says what the test checks',
      },
    ])
  })

  it('stays minor in a bug fix', () => {
    const patch = patchOf('tools/check-parity-ledger.test.mjs', retitle)
    expect(testWeakening({ patch, issue: bug }).map((f) => f.severity)).toEqual(['minor'])
  })

  it('names every case retitled, in the plural', () => {
    const patch = patchOf('src/a.test.ts', [
      '-  it("counts 1", () => {})',
      '-  it("counts 2", () => {})',
      '+  it("counts one", () => {})',
      '+  it("counts two", () => {})',
    ])
    expect(testWeakening({ patch, issue: feature })[0].issue).toContain(
      'retitles 2 test cases (the file lost "counts 1", "counts 2" and gained "counts one", "counts two")',
    )
  })

  it('still reports a case removed when the only new name is in another file', () => {
    const patch =
      patchOf('src/a.test.ts', ['-  it("keeps the last line", () => {})']) +
      '\n' +
      patchOf('src/b.test.ts', ['+  it("keeps the first line", () => {})'])
    const findings = testWeakening({ patch, issue: feature })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('major')
    expect(findings[0].issue).toBe(
      'the change weakens a test that was there before it: it removes 1 test case ("keeps the last line")',
    )
  })

  it('reports one removed case when two leave a file and one new name comes in', () => {
    const patch = patchOf('src/a.test.ts', [
      '-  it("parses a list", () => {})',
      '-  it("parses a map", () => {})',
      '+  it("parses a collection", () => {})',
    ])
    const [finding] = testWeakening({ patch, issue: feature })
    expect(finding.severity).toBe('major')
    expect(finding.issue).toBe(
      'the change weakens a test that was there before it: it removes 1 test case ("parses a list", "parses a map" left the file and 1 new name came in, "parses a collection")',
    )
  })

  it('names the new names in the plural when more than one came in', () => {
    const patch = patchOf('src/a.test.ts', [
      '-  it("parses a list", () => {})',
      '-  it("parses a map", () => {})',
      '-  it("parses a set", () => {})',
      '+  it("parses a collection", () => {})',
      '+  it("parses a dictionary", () => {})',
    ])
    expect(testWeakening({ patch, issue: feature })[0].issue).toContain(
      'removes 1 test case ("parses a list", "parses a map", "parses a set" left the file and 2 new names came in, "parses a collection", "parses a dictionary")',
    )
  })

  it('does not take an added line that opens no case for a new name', () => {
    const patch = patchOf('src/a.test.ts', [
      '-  it("keeps the last line", () => {',
      '+  it("keeps the last line", () => {',
      '-  it("trims", () => {})',
      '+    expect(a).toBe(1)',
    ])
    expect(testWeakening({ patch, issue: feature })[0].issue).toBe(
      'the change weakens a test that was there before it: it removes 1 test case ("trims")',
    )
  })

  it('still reports the loss when the retitled file has fewer assertions', () => {
    const patch = patchOf('src/a.test.ts', [
      '-  it("parses a list", () => {',
      '+  it("parses a sequence", () => {',
      '-    expect(x).toBe(1)',
      '-    expect(y).toBe(2)',
      '+    expect(x).toBe(1)',
    ])
    const [finding] = testWeakening({ patch, issue: bug })
    expect(finding.severity).toBe('blocker')
    expect(finding.issue).toBe(
      'the change weakens a test that was there before it: it leaves 1 assertion fewer; retitles 1 test case (the file lost "parses a list" and gained "parses a sequence")',
    )
  })

  it('does not pair a removed case with a name another file lost', () => {
    const patch =
      patchOf('src/a.test.ts', [
        '-  it("keeps the last line", () => {})',
        '+  it("trims", () => {})',
      ]) +
      '\n' +
      patchOf('src/b.test.ts', ['-  it("trims", () => {})'])
    const findings = testWeakening({ patch, issue: feature })
    expect(findings).toHaveLength(1)
    expect(findings[0].issue).toContain('removes 1 test case ("keeps the last line")')
  })

  it('does not pair a removed case with a name the file lost and got back', () => {
    const patch = patchOf('src/a.test.ts', [
      '-  it("keeps the last line", () => {})',
      '-  it("trims", () => {})',
      '+  it("trims", () => {})',
    ])
    expect(testWeakening({ patch, issue: feature })[0].issue).toContain(
      'removes 1 test case ("keeps the last line")',
    )
  })

  it('is minor when the issue names the old title and the file loses an assertion', () => {
    const patch = patchOf('src/a.test.ts', [
      '-  it("parses a list", () => {',
      '+  it("parses a sequence", () => {',
      '-    expect(x).toBe(1)',
    ])
    const issue = { ...bug, body: 'The test "parses a list" checks too much.' }
    expect(testWeakening({ patch, issue })[0].severity).toBe('minor')
  })
})

describe('a test the issue names', () => {
  it('counts a removed name of six letters in the issue, and not one of five', () => {
    const six = patchOf('src/a.test.ts', ['-  it("parses", () => {})'])
    const five = patchOf('src/a.test.ts', ['-  it("trims", () => {})'])
    const issue = { ...feature, body: 'It parses and trims.' }
    expect(testWeakening({ patch: six, issue })[0].severity).toBe('minor')
    expect(testWeakening({ patch: five, issue })[0].severity).toBe('major')
  })

  it('does not count a long removed name the issue does not mention', () => {
    const patch = patchOf('src/a.test.ts', ['-  it("keeps the last line", () => {})'])
    expect(testWeakening({ patch, issue: feature })[0].severity).toBe('major')
  })
})

describe('TEST_PATHSPECS', () => {
  it('reach every kind of test file the guard knows', () => {
    expect(TEST_PATHSPECS).toHaveLength(9)
    expect(TEST_PATHSPECS).toContain("':(glob)**/*_test.go'")
  })

  it('are fixed git pathspecs, so no path from the repository reaches the shell', () => {
    for (const spec of TEST_PATHSPECS) expect(spec).toMatch(/^':\(glob\)[*a-z_/.{}]+'$/)
  })
})
