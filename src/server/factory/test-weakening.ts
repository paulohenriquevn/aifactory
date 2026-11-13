import type { Finding } from './review'

/** A test file, by where it lives or what it is called, in the languages the factory's projects use. */
export const TEST_FILE =
  /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i

/**
 * The paths whose diff the guard reads. They are fixed strings, so no path the agent created reaches the
 * shell. `TEST_FILE` still decides, since a pathspec cannot say everything it does.
 */
export const TEST_PATHSPECS = [
  "':(glob)**/*.test.*'",
  "':(glob)**/*.spec.*'",
  "':(glob)**/test/**'",
  "':(glob)**/tests/**'",
  "':(glob)**/__tests__/**'",
  "':(glob)**/spec/**'",
  "':(glob)**/test_*.py'",
  "':(glob)**/*_test.go'",
  "':(glob)**/*_test.py'",
]

export type FilePatch = { path: string; isNew: boolean; added: string[]; removed: string[] }

/** Reads `git diff -U0` output into the lines each file gained and lost. A deleted file is left out. */
export function parsePatch(patch: string): FilePatch[] {
  type Reading = FilePatch & { deleted: boolean; inHunk: boolean }
  const files: Reading[] = []
  let current: Reading | undefined
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/.* b\/(.*)/.exec(line)
    if (header) {
      current = {
        path: header[1],
        isNew: false,
        deleted: false,
        inHunk: false,
        added: [],
        removed: [],
      }
      files.push(current)
    } else if (!current) {
      continue
    } else if (line.startsWith('@@')) current.inHunk = true
    else if (!current.inHunk) {
      // Before the first hunk, the lines describe the file: `--- a/x` and `+++ b/x` are not content.
      if (line.startsWith('new file mode')) current.isNew = true
      if (line.startsWith('deleted file mode')) current.deleted = true
    } else if (line.startsWith('+')) current.added.push(line.slice(1))
    else if (line.startsWith('-')) current.removed.push(line.slice(1))
  }
  return files
    .filter((f) => !f.deleted)
    .map(({ path, isNew, added, removed }) => ({ path, isNew, added, removed }))
}

const CASE_NAMES = [
  /\b(?:it|test)(?:\.(?:each\([^)]*\)|concurrent|sequential|skip|only|todo))?\s*\(\s*(['"`])(.+?)\1/,
  /\bdef\s+(test_\w+)/,
  /\bfunc\s+(Test\w+)/,
]
const ASSERTION =
  /\bexpect\s*\(|\bassert(?:\.\w+|\w*)\s*[(\s]|\bt\.(?:Error|Errorf|Fatal|Fatalf)\(/g
const SKIP =
  /\b(?:it|test|describe)\.(?:skip|only|todo)\b|\b(?:xit|xtest|xdescribe)\s*\(|@pytest\.mark\.skip|\bt\.Skip(?:Now|f)?\(/g

/** The name of the test a line opens, when it opens one. */
function caseName(line: string): string | undefined {
  for (const pattern of CASE_NAMES) {
    const match = pattern.exec(line)
    if (match) return match[match.length - 1]
  }
  return undefined
}

function count(lines: string[], pattern: RegExp): number {
  return lines.reduce((sum, line) => sum + (line.match(pattern)?.length ?? 0), 0)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * The assertions that went with the cases this file lost to another file: what the files that gained one
 * of those names gained. A test that moved is not a test that got weaker.
 */
function movedAssertions(files: FilePatch[], from: FilePatch, cases: string[]): number {
  const destinations = files.filter(
    (f) => f !== from && f.added.some((line) => cases.includes(caseName(line) ?? '')),
  )
  return destinations.reduce((sum, f) => sum + count(f.added, ASSERTION), 0)
}

type Retitles = { removed: string[]; gone: string[]; retitled: number; newNames: string[] }

/**
 * Splits the names a file lost into removed cases and retitled ones. The guard knows a case only by its
 * title, and a title that carries a value the change must update (a count, a version) cannot be kept, so a
 * name that leaves a file is not proof that its case went. Each name the file gains, and that no file in
 * the diff lost, may stand for one name the file lost: as many retitles as there are such new names, never
 * more, and never across files. A deletion therefore hides behind a rename only when a new case replaces
 * it in the same file, and the body of that case is still held by the file's assertion count, which this
 * pairing does not touch. Which lost name went with which new one cannot be read from the diff, so the
 * removed cases are counted, not named one by one.
 */
function retitles(
  file: FilePatch,
  gone: string[],
  removedNames: ReadonlySet<string | undefined>,
): Retitles {
  const added = file.added.map(caseName).filter((name): name is string => name !== undefined)
  const newNames = [...new Set(added.filter((name) => !removedNames.has(name)))]
  const retitled = Math.min(gone.length, newNames.length)
  return { removed: gone.slice(retitled), gone, retitled, newNames }
}

function quoted(names: string[]): string {
  return names.map((n) => `"${n}"`).join(', ')
}

/** What the guard says about the cases a file lost: the ones that went, then the ones only retitled. */
function caseFacts(r: Retitles): { removes: string[]; retitle: string | undefined } {
  const removes =
    r.removed.length === 0
      ? []
      : r.retitled === 0
        ? [`removes ${plural(r.removed.length, 'test case')} (${quoted(r.removed)})`]
        : [
            `removes ${plural(r.removed.length, 'test case')} (${quoted(r.gone)} left the file and ${r.newNames.length} new ${r.newNames.length === 1 ? 'name' : 'names'} came in, ${quoted(r.newNames)})`,
          ]
  const retitle =
    r.retitled > 0 && r.removed.length === 0
      ? `retitles ${plural(r.retitled, 'test case')} (the file lost ${quoted(r.gone)} and gained ${quoted(r.newNames)})`
      : undefined
  return { removes, retitle }
}

type Issue = { labels: string[]; title: string; body: string }

/** The issue asks for it: its text names the file, or one of the tests the change removes. */
function issueNames(issue: Issue, path: string, removedCases: string[]): boolean {
  const text = `${issue.title}\n${issue.body}`
  const base = path.slice(path.lastIndexOf('/') + 1)
  return (
    text.includes(path) ||
    text.includes(base) ||
    removedCases.some((name) => name.length >= 6 && text.includes(name))
  )
}

/**
 * What a change took away from test files that were there before it: test cases whose names are not added
 * back anywhere in the diff, a net loss of assertions, and a skip, an `only` or a todo it added. In a bug
 * fix that is a blocker, in other work major: a green check means little when the test was made easier.
 * When the issue names the file or the test, removing it may be the point, and the reviewer judges.
 */
export function testWeakening(input: { patch: string; issue: Issue }): Finding[] {
  const files = parsePatch(input.patch)
  const addedCases = new Set(files.flatMap((f) => f.added.map(caseName)))
  const removedNames = new Set(files.flatMap((f) => f.removed.map(caseName)))
  const isBugFix = input.issue.labels.some((label) => label.toLowerCase() === 'bug')
  const findings: Finding[] = []
  for (const file of files.filter((f) => !f.isNew && TEST_FILE.test(f.path))) {
    const cases = file.removed.map(caseName).filter((name): name is string => name !== undefined)
    const removedCases = cases.filter((name) => !addedCases.has(name))
    const { removes, retitle } = caseFacts(retitles(file, removedCases, removedNames))
    const fewer =
      count(file.removed, ASSERTION) -
      count(file.added, ASSERTION) -
      movedAssertions(files, file, cases)
    const skips = count(file.added, SKIP) - count(file.removed, SKIP)
    const facts = [
      ...removes,
      ...(fewer > 0 ? [`leaves ${fewer} ${fewer === 1 ? 'assertion' : 'assertions'} fewer`] : []),
      ...(skips > 0
        ? [
            `adds ${file.added
              .map((l) => l.match(SKIP)?.[0])
              .filter(Boolean)
              .join(', ')}`,
          ]
        : []),
    ]
    if (facts.length === 0) {
      // A retitle on its own weakens nothing, so it is a fact for the reviewer to weigh, never a stop.
      if (retitle)
        findings.push({
          severity: 'minor',
          file: file.path,
          issue: `the change ${retitle}, and the file keeps its assertions; judge whether the new title still says what the test checks`,
        })
      continue
    }
    const named = issueNames(input.issue, file.path, removedCases)
    findings.push({
      severity: named ? 'minor' : isBugFix ? 'blocker' : 'major',
      file: file.path,
      issue: `the change weakens a test that was there before it: it ${[...facts, ...(retitle ? [retitle] : [])].join('; ')}${
        named ? '; the issue names it, so judge whether the issue asks for this' : ''
      }`,
    })
  }
  return findings
}
