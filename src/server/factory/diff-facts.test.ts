import { describe, expect, it } from 'vitest'

import {
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

    expect(facts).toEqual({ guards: [], unplanned: [] })
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
})
