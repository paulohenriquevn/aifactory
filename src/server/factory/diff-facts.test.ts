import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  commit,
  divergedRepository,
  PLANNED_CHANGE,
  readsHistory,
  WEAKENED_TEST,
} from '../../test/diverged-repository'

import { diffFacts, reviewBase, samePatch } from './diff-facts'
import { FakeBackend } from './fake-sandbox'
import { changedSinceCommand } from './review'

const plan = {
  files: [{ path: 'src/truncate.js', why: 'the function' }],
  order: [],
  risks: [],
  proof: [],
  outOfScope: [],
}
const issue = { labels: ['bug'], title: 'Add truncate', body: 'Write truncate(text, max).' }

/** The facts of the task branch of a real repository, the way a run reads them. */
function factsOf(repo: { dir: string; baseSha: string }) {
  const backend = new FakeBackend(readsHistory(repo.dir, repo.dir))
  return diffFacts(backend, repo.dir, { baseSha: repo.baseSha, plan, issue })
}

describe('diffFacts', () => {
  it('finds nothing in a branch behind the integration branch that changed only what it planned', async () => {
    const facts = await factsOf(divergedRepository({ behind: true }))

    expect(facts).toEqual({ guards: [], unplanned: [], required: [], touched: ['src/truncate.js'] })
  })

  it('still reports what the branch itself did when the integration branch moved past it', async () => {
    const repo = divergedRepository({
      behind: true,
      branch: {
        ...PLANNED_CHANGE,
        'src/extra.js': 'export {}\n',
        'src/shared.test.js': WEAKENED_TEST,
      },
    })

    const facts = await factsOf(repo)

    expect(facts).toEqual({
      guards: [
        {
          severity: 'blocker',
          file: 'src/shared.test.js',
          issue: 'the change weakens a test that was there before it: it leaves 1 assertion fewer',
        },
      ],
      unplanned: ['src/extra.js', 'src/shared.test.js'],
      required: [],
      // Only what the branch itself changed, not what the integration branch did after it.
      touched: ['src/extra.js', 'src/shared.test.js', 'src/truncate.js'],
    })
  })

  it('reads a first run from where its branch starts', async () => {
    const repo = divergedRepository({
      behind: false,
      branch: { ...PLANNED_CHANGE, 'package.json': '{"scripts":{"test":"true"}}\n' },
    })

    const facts = await factsOf(repo)

    expect(facts.guards).toEqual([
      {
        severity: 'blocker',
        file: 'package.json',
        issue:
          'the "test" script was changed (from "vitest run" to "true"); the checks now run something else',
      },
    ])
    expect(facts.unplanned).toEqual(['package.json'])
  })

  it('lists no file outside a plan when there is no plan', async () => {
    const repo = divergedRepository({ behind: false, branch: { 'src/extra.js': 'export {}\n' } })
    const backend = new FakeBackend(readsHistory(repo.dir, repo.dir))

    const facts = await diffFacts(backend, repo.dir, {
      baseSha: repo.baseSha,
      plan: undefined,
      issue,
    })

    expect(facts.unplanned).toEqual([])
  })

  describe('after a factory check failed on an earlier commit of the task', () => {
    const CHANGESET = '.changeset/quiet-pens-wave.md'
    const check = { name: 'changeset', command: 'pnpm exec changeset status' }
    const failure = 'error Some packages have been changed but no changesets were found.'

    const NAMED = '---\n"app": patch\n---\n\nAdds truncate.\n'

    /** A task whose first commit failed the check and whose second added a changeset and a file. */
    function repaired(changeset = NAMED) {
      const repo = divergedRepository({ behind: false })
      const headSha = commit(
        repo.dir,
        { [CHANGESET]: changeset, 'src/extra.js': 'export {}\n', 'package.json': '{}\n' },
        'add a changeset',
      )
      const backend = new FakeBackend(readsHistory(repo.dir, repo.dir))
      return { repo, headSha, backend }
    }

    it('does not take an empty changeset as what a check required: it stays outside the plan', async () => {
      const { repo, headSha, backend } = repaired('---\n---\n\nA private app changed.\n')

      const facts = await diffFacts(backend, repo.dir, {
        baseSha: repo.baseSha,
        plan,
        issue,
        checkRuns: [
          { ...check, sha: repo.taskSha, passed: false, output: failure },
          { ...check, sha: headSha, passed: true, output: '' },
        ],
      })

      expect(facts.unplanned).toEqual([CHANGESET, 'package.json'])
      expect(facts.required.map((r) => r.files)).toEqual([['src/extra.js']])
    })

    it('does not take a changeset whose name it will not hand to a shell as required', async () => {
      const odd = '.changeset/$(id).md'
      const repo = divergedRepository({ behind: false })
      const headSha = commit(repo.dir, { [odd]: NAMED }, 'add a changeset')
      const backend = new FakeBackend(readsHistory(repo.dir, repo.dir))

      const facts = await diffFacts(backend, repo.dir, {
        baseSha: repo.baseSha,
        plan,
        issue,
        checkRuns: [
          { ...check, sha: repo.taskSha, passed: false, output: failure },
          { ...check, sha: headSha, passed: true, output: '' },
        ],
      })

      expect(facts.unplanned).toEqual([odd])
      expect(facts.required.map((r) => r.files)).toEqual([[]])
      expect(backend.commands.some((c) => c.includes('$(id)'))).toBe(false)
    })

    it('does not list a file added between the failed check and the passing one', async () => {
      const { repo, headSha, backend } = repaired()

      const facts = await diffFacts(backend, repo.dir, {
        baseSha: repo.baseSha,
        plan,
        issue,
        checkRuns: [
          { ...check, sha: repo.taskSha, passed: false, output: failure },
          { ...check, sha: headSha, passed: true, output: '' },
        ],
      })

      // `package.json` was there before: changing it is still outside the plan.
      expect(facts.unplanned).toEqual(['package.json'])
      expect(facts.required).toEqual([
        {
          ...check,
          error: failure,
          failedSha: repo.taskSha,
          passedSha: headSha,
          files: [CHANGESET, 'src/extra.js'],
        },
      ])
    })

    it('keeps every guard on what the repairing commit changed', async () => {
      const repo = divergedRepository({ behind: false })
      const headSha = commit(repo.dir, { 'package.json': '{"scripts":{"test":"true"}}\n' }, 'fix')
      const backend = new FakeBackend(readsHistory(repo.dir, repo.dir))

      const facts = await diffFacts(backend, repo.dir, {
        baseSha: repo.baseSha,
        plan,
        issue,
        checkRuns: [
          { ...check, sha: repo.taskSha, passed: false, output: failure },
          { ...check, sha: headSha, passed: true, output: '' },
        ],
      })

      expect(facts.guards.map((g) => g.file)).toEqual(['package.json'])
    })

    it('lists every file outside the plan, as before, when the checks never failed', async () => {
      const { repo, headSha, backend } = repaired()

      const facts = await diffFacts(backend, repo.dir, {
        baseSha: repo.baseSha,
        plan,
        issue,
        checkRuns: [
          { ...check, sha: repo.taskSha, passed: true, output: '' },
          { ...check, sha: headSha, passed: true, output: '' },
        ],
      })

      expect(facts.unplanned).toEqual([CHANGESET, 'package.json', 'src/extra.js'])
      expect(facts.required).toEqual([])
      expect(backend.commands.some((c) => c.includes('rev-list'))).toBe(false)
    })

    it('ignores a failure on a commit that is not part of the change', async () => {
      const { repo, headSha, backend } = repaired()

      const facts = await diffFacts(backend, repo.dir, {
        baseSha: repo.baseSha,
        plan,
        issue,
        checkRuns: [
          { ...check, sha: repo.baseSha, passed: false, output: failure },
          { ...check, sha: headSha, passed: true, output: '' },
        ],
      })

      expect(facts.required).toEqual([])
      expect(facts.unplanned).toEqual([CHANGESET, 'package.json', 'src/extra.js'])
    })
  })
})

/** Runs git in `dir` with a fixed identity, and answers what it printed. */
function gitIn(dir: string, ...args: string[]): string {
  const run = spawnSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
  return run.stdout.trim()
}

/**
 * A clone whose task branch was cut from `workspace` at W1 and then merged `origin/workspace` at W2, which
 * another task's `src/x.ts` reached after the clone. `baseSha` is W1, the head the run cloned.
 */
function branchThatMergedAMovedBase(
  merge: (dir: string) => void = (dir) =>
    gitIn(dir, 'merge', '-q', '--no-edit', 'origin/workspace'),
): { dir: string; baseSha: string; approved: string; head: string } {
  const origin = mkdtempSync(join(tmpdir(), 'origin-'))
  gitIn(origin, 'init', '-q', '-b', 'workspace')
  const baseSha = commit(origin, { 'src/shared.js': 'export {}\n' }, 'W1')
  const dir = mkdtempSync(join(tmpdir(), 'clone-'))
  gitIn(dir, 'clone', '-q', '-b', 'workspace', origin, '.')
  gitIn(dir, 'switch', '-q', '-c', 'factory/7')
  const approved = commit(dir, PLANNED_CHANGE, 'the task')
  commit(origin, { 'src/x.ts': 'export const x = 1\n' }, 'W2: another task')
  gitIn(dir, 'fetch', '-q', 'origin', 'workspace')
  merge(dir)
  return { dir, baseSha, approved, head: gitIn(dir, 'rev-parse', 'HEAD') }
}

/** A backend that runs every git command addressed to `dir` there, as the sandbox would. */
const gitBackend = (dir: string) =>
  new FakeBackend((command) => {
    const run = spawnSync('sh', ['-c', command], { encoding: 'utf8', cwd: dir })
    return { stdout: run.stdout, stderr: run.stderr, exitCode: run.status ?? 1 }
  })

describe('reviewBase', () => {
  it('measures the change from the integration branch it fetches, so a file another task merged in is not listed', async () => {
    const repo = branchThatMergedAMovedBase()
    const backend = gitBackend(repo.dir)

    const stale = await diffFacts(backend, repo.dir, { baseSha: repo.baseSha, plan, issue })
    const base = await reviewBase(backend, repo.dir, {
      baseSha: repo.baseSha,
      integration: 'workspace',
    })
    const facts = await diffFacts(backend, repo.dir, { baseSha: base, plan, issue })

    // From the head the run cloned, the other task's file looks like this task's change.
    expect(stale.unplanned).toEqual(['src/x.ts'])
    expect(facts.touched).toEqual(['src/truncate.js'])
    expect(facts.unplanned).toEqual([])
  })

  it('keeps the base the run cloned when the fetched head has no common commit with the work', async () => {
    const backend = new FakeBackend(() => ({ stdout: '' }))

    expect(await reviewBase(backend, '/w', { baseSha: 'abc', integration: 'workspace' })).toBe(
      'abc',
    )
  })

  it('refuses an integration branch name a shell would read as more than a name', async () => {
    const backend = new FakeBackend(() => ({}))

    await expect(
      reviewBase(backend, '/w', { baseSha: 'abc', integration: 'workspace; rm -rf /' }),
    ).rejects.toThrow('not a plain branch name')
    expect(backend.commands).toEqual([])
  })
})

describe('what a later review reads as changed since the earlier one', () => {
  it('is the rework of the task, without what a merge of the integration branch brought in', async () => {
    const repo = branchThatMergedAMovedBase((dir) => {
      gitIn(dir, 'merge', '-q', '--no-edit', 'origin/workspace')
      commit(dir, { 'src/rework.js': 'export const rework = 1\n' }, 'address feedback')
    })
    const backend = gitBackend(repo.dir)
    const base = await reviewBase(backend, repo.dir, {
      baseSha: repo.baseSha,
      integration: 'workspace',
    })
    const inRepo = (command: string) =>
      spawnSync('sh', ['-c', command], { encoding: 'utf8', cwd: repo.dir }).stdout

    const since = inRepo(changedSinceCommand(repo.approved, base))

    expect(since).toContain('src/rework.js')
    expect(since).not.toContain('src/x.ts')
    // The plain diff between the two commits holds the other task's file the merge brought in.
    expect(inRepo(`git diff ${repo.approved} HEAD`)).toContain('src/x.ts')
  })
})

describe('samePatch', () => {
  it('finds the task patch unchanged by a clean merge of the integration branch', async () => {
    const repo = branchThatMergedAMovedBase()

    const same = await samePatch(gitBackend(repo.dir), repo.dir, {
      integration: 'workspace',
      approved: repo.approved,
      head: repo.head,
    })

    expect(same).toBe(true)
  })

  it('finds the task patch changed when the merge also changed what the task wrote', async () => {
    const repo = branchThatMergedAMovedBase((dir) => {
      gitIn(dir, 'merge', '-q', '--no-edit', '--no-commit', 'origin/workspace')
      commit(
        dir,
        { 'src/truncate.js': 'export const truncate = (t, max) => t.slice(0, max)\n' },
        'merge',
      )
    })

    const same = await samePatch(gitBackend(repo.dir), repo.dir, {
      integration: 'workspace',
      approved: repo.approved,
      head: repo.head,
    })

    expect(same).toBe(false)
  })

  it('never finds two empty patches the same', async () => {
    const backend = new FakeBackend(() => ({ stdout: '' }))

    const same = await samePatch(backend, '/w', {
      integration: 'workspace',
      approved: 'a'.repeat(40),
      head: 'b'.repeat(40),
    })

    expect(same).toBe(false)
  })

  it('refuses a commit that is not a hash, before any shell', async () => {
    const backend = new FakeBackend(() => ({}))

    await expect(
      samePatch(backend, '/w', {
        integration: 'workspace',
        approved: 'HEAD; rm -rf /',
        head: 'b'.repeat(40),
      }),
    ).rejects.toThrow('not a commit hash')
    expect(backend.commands).toEqual([])
  })
})
