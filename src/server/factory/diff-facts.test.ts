import { describe, expect, it } from 'vitest'

import {
  commit,
  divergedRepository,
  PLANNED_CHANGE,
  readsHistory,
  WEAKENED_TEST,
} from '../../test/diverged-repository'

import { diffFacts } from './diff-facts'
import { FakeBackend } from './fake-sandbox'

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

    expect(facts).toEqual({ guards: [], unplanned: [], required: [] })
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

    /** A task whose first commit failed the check and whose second added a changeset and a file. */
    function repaired() {
      const repo = divergedRepository({ behind: false })
      const headSha = commit(
        repo.dir,
        { [CHANGESET]: '---\n---\n', 'src/extra.js': 'export {}\n', 'package.json': '{}\n' },
        'add a changeset',
      )
      const backend = new FakeBackend(readsHistory(repo.dir, repo.dir))
      return { repo, headSha, backend }
    }

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
