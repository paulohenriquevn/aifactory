import { describe, expect, it } from 'vitest'

import {
  AGENT_CONFIGURATION,
  agentConfigurationChanged,
  kindOf,
  markQuick,
  selectCandidates,
  type Candidate,
  type EvalCase,
} from './cases'

const candidate = (taskId: number, repository: string, durationMs = 600_000): Candidate => ({
  taskId,
  repository,
  issueNumber: taskId,
  firstSha: `sha${taskId}`,
  mergedSha: `merged${taskId}`,
  costUsd: 0.4,
  durationMs,
  attempts: 1,
  checks: [{ name: 'tests', command: 'pnpm test' }],
})

describe('selectCandidates', () => {
  it('takes cases from every repository in turn, the most recent of each first', () => {
    const pool = [
      candidate(1, 'o/a'),
      candidate(2, 'o/a'),
      candidate(3, 'o/a'),
      candidate(4, 'o/b'),
      candidate(5, 'o/c'),
      candidate(6, 'o/c'),
    ]

    const chosen = selectCandidates(pool, { count: 5, maxDurationMs: 3_600_000 })

    expect(chosen.map((c) => c.taskId)).toEqual([3, 4, 6, 2, 5])
  })

  it('leaves out runs longer than the limit, runs with no check and runs with no recorded cost', () => {
    const pool = [
      candidate(1, 'o/a', 3_600_001),
      { ...candidate(2, 'o/a'), checks: [] },
      { ...candidate(3, 'o/a'), costUsd: 0 },
      candidate(4, 'o/a', 3_600_000),
    ]

    const chosen = selectCandidates(pool, { count: 10, maxDurationMs: 3_600_000 })

    expect(chosen.map((c) => c.taskId)).toEqual([4])
  })

  it('stops at the count asked for', () => {
    const pool = [candidate(1, 'o/a'), candidate(2, 'o/b'), candidate(3, 'o/c')]

    expect(selectCandidates(pool, { count: 2, maxDurationMs: 3_600_000 })).toHaveLength(2)
  })
})

const evalCase = (id: string, repository: string, durationMs: number): EvalCase => ({
  id,
  repository,
  issueNumber: 1,
  title: 't',
  body: 'b',
  labels: [],
  kind: 'feature',
  integrationBranch: 'workspace',
  baseSha: 'base',
  checks: [{ name: 'tests', command: 'pnpm test' }],
  egress: [],
  original: { taskId: 1, costUsd: 0.4, durationMs, attempts: 1, mergedSha: 'm' },
})

describe('markQuick', () => {
  it('marks the shortest case of each repository in turn, so the quick set is cheap and still varied', () => {
    const cases = [
      evalCase('a1', 'o/a', 500),
      evalCase('a2', 'o/a', 100),
      evalCase('b1', 'o/b', 300),
      evalCase('c1', 'o/c', 900),
      evalCase('c2', 'o/c', 200),
    ]

    const marked = markQuick(cases, 4)

    // c1 is left out: the fourth turn goes back to o/a, whose next shortest is a1.
    expect(marked.filter((c) => c.quick).map((c) => c.id)).toEqual(['a1', 'a2', 'b1', 'c2'])
    expect(marked.map((c) => c.id)).toEqual(cases.map((c) => c.id))
  })

  it('clears a quick mark a case had before', () => {
    const cases = [evalCase('a1', 'o/a', 500), { ...evalCase('b1', 'o/b', 100), quick: true }]

    expect(markQuick(cases, 1).map((c) => c.quick)).toEqual([true, false])
  })
})

describe('kindOf', () => {
  it('calls an issue labelled bug a bug, in any case', () => {
    expect(kindOf(['factory', 'Bug'])).toBe('bug')
  })

  it('calls anything else a feature', () => {
    expect(kindOf(['factory', 'enhancement'])).toBe('feature')
  })
})

describe('agentConfigurationChanged', () => {
  it('names the changed files that steer the agents', () => {
    expect(
      agentConfigurationChanged([
        'src/server/factory/review.ts',
        'src/app/page.tsx',
        'ops/sandbox/Dockerfile',
      ]),
    ).toEqual(['src/server/factory/review.ts', 'ops/sandbox/Dockerfile'])
  })

  it('counts a skill or a prompt anywhere under the agents folder', () => {
    expect(agentConfigurationChanged(['src/server/agents/skills/plan/SKILL.md'])).toEqual([
      'src/server/agents/skills/plan/SKILL.md',
    ])
  })

  it('does not count a test of one of those files', () => {
    expect(
      agentConfigurationChanged([
        'src/server/agents/hooks/only-tools.test.ts',
        'src/server/agents/tools/search.test.mts',
      ]),
    ).toEqual([])
  })

  it('lists the prompts, the harnesses, the models and the sandbox image', () => {
    expect(AGENT_CONFIGURATION).toEqual(
      expect.arrayContaining([
        'src/server/factory/harness.ts',
        'src/server/factory/review.ts',
        'src/server/factory/engine-models.ts',
        'ops/sandbox/Dockerfile',
      ]),
    )
  })
})
