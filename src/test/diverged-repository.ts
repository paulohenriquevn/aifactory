import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Reply } from '../server/factory/fake-sandbox'

type Files = Record<string, string>

const AUTHOR = [
  '-c',
  'user.name=test',
  '-c',
  'user.email=test@example.com',
  '-c',
  'commit.gpgsign=false',
]

function git(dir: string, ...args: string[]): string {
  const run = spawnSync('git', ['-C', dir, ...AUTHOR, ...args], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
  return run.stdout.trim()
}

/** Commits `files` on the branch checked out in `dir`, and answers the commit. */
export function commit(dir: string, files: Files, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

const TEST_SCRIPT = (script: string) => `${JSON.stringify({ scripts: { test: script } })}\n`

const SHARED_TEST = `it('keeps short text', () => {
  expect(1).toBe(1)
  expect(2).toBe(2)
})
`

/** What the task branch changes, when the test says nothing else: the file the plan names. */
export const PLANNED_CHANGE: Files = { 'src/truncate.js': 'export const truncate = (t) => t\n' }

/** The shared test with one assertion fewer, as a change that weakens it leaves it. */
export const WEAKENED_TEST = `it('keeps short text', () => {
  expect(1).toBe(1)
})
`

/**
 * What the integration branch changed after the task branch was cut, as a release does: a package, its
 * changelog, the command the checks run, a workflow, a test case added to a test nobody on the task
 * touched, and a new test file. None of it is the task's. Read from the integration branch to the task's,
 * the test case and the file are gone, which is what a weakened test and a deleted one look like.
 */
export const INTEGRATION_CHANGES: Files = {
  'package.json': TEST_SCRIPT('vitest run --passWithNoTests'),
  'packages/agents/package.json': '{"version":"16.5.0"}\n',
  'CHANGELOG.md': '# 16.5.0\n',
  '.github/workflows/ci.yml': 'on: push\n',
  'src/shared.test.js': `${SHARED_TEST}
it('cuts long text', () => {
  expect(3).toBe(3)
})
`,
  'src/release.test.js': `it('releases', () => {\n  expect(4).toBe(4)\n})\n`,
}

/**
 * A real repository with the task branch `factory/7` checked out. The branch was cut from `workspace` and
 * made `branch`; when `behind`, `workspace` then moved on with `INTEGRATION_CHANGES`, as it does while a
 * task waits to be sent back. `baseSha` is `workspace` as a run clones it.
 */
export function divergedRepository(options: { behind: boolean; branch?: Files }): {
  dir: string
  baseSha: string
  /** The commit of the task branch. */
  taskSha: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'diverged-'))
  git(dir, 'init', '-q', '-b', 'workspace')
  commit(
    dir,
    { 'package.json': TEST_SCRIPT('vitest run'), 'src/shared.test.js': SHARED_TEST },
    'start',
  )
  git(dir, 'switch', '-q', '-c', 'factory/7')
  const taskSha = commit(dir, options.branch ?? PLANNED_CHANGE, 'the task')
  git(dir, 'switch', '-q', 'workspace')
  if (options.behind) commit(dir, INTEGRATION_CHANGES, 'release 16.5.0')
  const baseSha = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'switch', '-q', 'factory/7')
  return { dir, baseSha, taskSha }
}

/**
 * Answers the commands that read history (`merge-base`, `rev-list`, `diff`, `show`) addressed to `repoDir` from the real
 * repository in `dir`, and leaves every other command to the caller.
 */
export function readsHistory(dir: string, repoDir: string): (command: string) => Reply | undefined {
  const prefix = `git -C ${repoDir} `
  return (command) => {
    if (
      !/^git -C \S+ (merge-base|rev-list|diff|show) /.test(command) ||
      !command.startsWith(prefix)
    )
      return undefined
    const run = spawnSync('sh', ['-c', `git -C ${dir} ${command.slice(prefix.length)}`], {
      encoding: 'utf8',
    })
    return { stdout: run.stdout, stderr: run.stderr, exitCode: run.status ?? 1 }
  }
}
