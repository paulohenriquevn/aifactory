// The CRAP gate. CRAP of a function is comp^2 * (1 - coverage)^3 + comp: a complicated function that
// the tests do not reach is the riskiest kind of code, and one number says how bad it is.
//
//   pnpm coverage && node scripts/crap.mjs          fail on a new or a worse offender
//   node scripts/crap.mjs --list                    the worst functions, whatever the verdict
//   node scripts/crap.mjs --update                  rewrite the baseline (after a real improvement)
//
// A function above THRESHOLD is allowed only if it is in quality/crap-baseline.json and has not got
// worse. So the code that is already complicated is a debt that can only shrink, and new code has to
// be under the line. Coverage is read from coverage/coverage-final.json; a function's coverage is the
// share of the statements inside it (nested functions included) that ran.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const THRESHOLD = 30
/** How much a baseline score may grow before it counts as worse: rounding noise, not new code. */
const SLACK = 0.5
const BASELINE = resolve(ROOT, 'quality/crap-baseline.json')
const COVERAGE = resolve(ROOT, 'coverage/coverage-final.json')

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
])

/** Cyclomatic complexity of one function body: 1, plus a point for every way the flow can branch. */
export function complexityOf(fn) {
  let points = 1
  const visit = (node) => {
    if (node !== fn && FUNCTION_KINDS.has(node.kind)) return // a nested function is its own
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        points += 1
        break
      case ts.SyntaxKind.CaseClause:
        points += 1
        break
      case ts.SyntaxKind.BinaryExpression: {
        const op = node.operatorToken.kind
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) {
          points += 1
        }
        break
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn, visit)
  return points
}

export const crap = (complexity, coverage) =>
  complexity * complexity * (1 - coverage) ** 3 + complexity

/** `parent > child` for a function, from the names around it, so a score has a stable address. */
function nameOf(node, sourceFile) {
  if (node.name) return node.name.getText(sourceFile)
  const parent = node.parent
  if (
    parent &&
    (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
    parent.name
  ) {
    return parent.name.getText(sourceFile)
  }
  if (parent && ts.isExportAssignment(parent)) return 'default'
  return undefined
}

export function functionsIn(path, text) {
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const found = []
  const visit = (node, trail) => {
    let next = trail
    if (FUNCTION_KINDS.has(node.kind)) {
      let name = nameOf(node, sourceFile)
      if (name === undefined) {
        // Anonymous callbacks are told apart by their position among their siblings of the same parent.
        const key = trail.join(' > ')
        const seen = (visit.anon.get(key) ?? 0) + 1
        visit.anon.set(key, seen)
        name = `(anonymous ${seen})`
      }
      next = [...trail, name]
      found.push({
        name: next.join(' > '),
        complexity: complexityOf(node),
        start: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        end: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      })
    }
    ts.forEachChild(node, (child) => visit(child, next))
  }
  visit.anon = new Map()
  visit(sourceFile, [])
  return found
}

/** The share of the statements in `[start, end]` that ran. A file the tests never loaded is 0. */
export function coverageOf(entry, start, end) {
  if (!entry) return 0
  let total = 0
  let hit = 0
  for (const [id, location] of Object.entries(entry.statementMap)) {
    if (location.start.line < start || location.start.line > end) continue
    total += 1
    if (entry.s[id] > 0) hit += 1
  }
  return total === 0 ? 1 : hit / total
}

export function scoreAll(coverage, files) {
  const scores = {}
  for (const file of files) {
    const rel = relative(ROOT, file)
    const entry = coverage[file]
    for (const fn of functionsIn(file, readFileSync(file, 'utf8'))) {
      const cov = coverageOf(entry, fn.start, fn.end)
      scores[`${rel}#${fn.name}`] = {
        crap: Math.round(crap(fn.complexity, cov) * 10) / 10,
        complexity: fn.complexity,
        coverage: Math.round(cov * 100),
      }
    }
  }
  return scores
}

/** What breaks the rule: an offender that is new, or one that got worse than the baseline allows. */
export function judge(scores, baseline) {
  const failures = []
  for (const [key, s] of Object.entries(scores)) {
    if (s.crap <= THRESHOLD) continue
    const known = baseline[key]
    if (known === undefined) failures.push({ key, ...s, why: `new, over ${THRESHOLD}` })
    else if (s.crap > known + SLACK) failures.push({ key, ...s, why: `worse than ${known}` })
  }
  return failures
}

import { globSync } from 'node:fs'

function main() {
  const args = new Set(process.argv.slice(2))
  if (!existsSync(COVERAGE)) {
    console.error('no coverage/coverage-final.json: run `pnpm coverage` first')
    process.exit(2)
  }
  const coverage = JSON.parse(readFileSync(COVERAGE, 'utf8'))
  const files = globSync('src/**/*.{ts,tsx}', { cwd: ROOT })
    .filter((f) => !/\.test\.tsx?$|\.d\.ts$|^src\/test\/|fake-sandbox\.ts$/.test(f))
    .map((f) => resolve(ROOT, f))
  const scores = scoreAll(coverage, files)
  const ranked = Object.entries(scores).sort((a, b) => b[1].crap - a[1].crap)

  if (args.has('--list')) {
    for (const [key, s] of ranked.slice(0, 25)) {
      console.log(
        `${String(s.crap).padStart(9)}  comp ${String(s.complexity).padStart(3)}  cov ${String(s.coverage).padStart(3)}%  ${key}`,
      )
    }
    return
  }

  const over = Object.fromEntries(
    ranked.filter(([, s]) => s.crap > THRESHOLD).map(([k, s]) => [k, s.crap]),
  )
  if (args.has('--update')) {
    mkdirSync(dirname(BASELINE), { recursive: true })
    writeFileSync(BASELINE, `${JSON.stringify(over, null, 2)}\n`)
    console.log(`baseline written: ${Object.keys(over).length} functions over ${THRESHOLD}`)
    return
  }

  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
  const failures = judge(scores, baseline)
  const better = Object.entries(baseline).filter(([k, v]) => (scores[k]?.crap ?? 0) < v - SLACK)
  console.log(
    `${Object.keys(scores).length} functions, ${Object.keys(over).length} over ${THRESHOLD} (baseline ${Object.keys(baseline).length})`,
  )
  for (const f of failures) {
    console.error(
      `FAIL  crap ${f.crap} (complexity ${f.complexity}, coverage ${f.coverage}%)  ${f.key}  [${f.why}]`,
    )
  }
  if (better.length > 0) {
    console.log(
      `${better.length} baseline function(s) improved or are gone: run \`node scripts/crap.mjs --update\` to lock it in`,
    )
  }
  if (failures.length > 0) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
