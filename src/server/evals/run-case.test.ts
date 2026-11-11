import { describe, expect, it } from 'vitest'

import { FakeSandbox, type Reply } from '../factory/fake-sandbox'
import type { CodingHarness, HarnessInput, HarnessResult } from '../factory/harness'

import type { EvalCase } from './cases'
import { runCase } from './run-case'

const BASE = 'a'.repeat(40)

const evalCase: EvalCase = {
  id: 'o/r#7',
  repository: 'o/r',
  issueNumber: 7,
  title: 'Add a flag',
  body: 'The CLI needs --dry-run.',
  labels: ['factory'],
  kind: 'feature',
  integrationBranch: 'workspace',
  baseSha: BASE,
  checks: [{ name: 'tests', command: 'pnpm test' }],
  egress: ['example.org'],
  original: { taskId: 1, costUsd: 0.4, durationMs: 600_000, attempts: 1, mergedSha: 'm' },
}

const APPROVE = '{"verdict":"approve","summary":"good","findings":[]}'
const CHANGES =
  '{"verdict":"changes","summary":"no test","findings":[{"severity":"major","issue":"add a test"}]}'

/** An agent that answers each call from a list and remembers the prompts it was given. */
function agent(name: string, answers: HarnessResult[]): CodingHarness & { prompts: string[] } {
  const prompts: string[] = []
  const next = (input: HarnessInput) => {
    prompts.push(input.prompt)
    return Promise.resolve(answers.shift() ?? { ok: false, summary: 'no answer left' })
  }
  return {
    name,
    prompts,
    egress: async () => [{ domain: `${name}.example.com` }],
    run: (_backend, input) => next(input),
    resume: (_backend, _session, input) => next(input),
  }
}

type World = {
  /** What `git status --porcelain` says after the builder ran. */
  dirty?: boolean
  /** Exit code of each run of the check command, in order. */
  checkExits?: number[]
  /** `git diff --name-status` between the base and the commit. */
  nameStatus?: string
}

function sandbox(world: World = {}) {
  const exits = [...(world.checkExits ?? [0])]
  return new FakeSandbox((command): Reply | undefined => {
    if (command.includes('status --porcelain'))
      return { stdout: world.dirty === false ? '' : ' M src/cli.ts\n' }
    if (command.includes('pnpm test')) return { exitCode: exits.shift() ?? 0, stdout: 'ran' }
    if (command.includes('diff --name-status'))
      return { stdout: world.nameStatus ?? 'M\tsrc/cli.ts\n' }
    if (command.includes('rev-parse HEAD')) return { stdout: 'b'.repeat(40) }
    return undefined
  })
}

const deps = (provider: FakeSandbox, builder: CodingHarness, reviewer: CodingHarness) => ({
  sandbox: provider,
  builder,
  reviewer,
  author: { name: 'aifactory', email: 'factory@example.com' },
})

describe('runCase', () => {
  it('passes a case whose checks pass and whose review approves, with its cost and rounds', async () => {
    const provider = sandbox()
    const builder = agent('builder', [{ ok: true, summary: 'done', costUsd: 0.3, sessionId: 's1' }])
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE, costUsd: 0.1 }])

    const result = await runCase(deps(provider, builder, reviewer), evalCase)

    expect(result).toMatchObject({
      id: 'o/r#7',
      passed: true,
      reason: 'approved',
      attempts: 1,
      reviewRounds: 1,
    })
    expect(result.costUsd).toBeCloseTo(0.4)
    expect(provider.stopped).toBe(1)
  })

  it('starts from the base commit of the case, with the same prompt a task gets', async () => {
    const provider = sandbox()
    const builder = agent('builder', [{ ok: true, summary: 'done', sessionId: 's1' }])

    await runCase(
      deps(provider, builder, agent('reviewer', [{ ok: true, summary: APPROVE }])),
      evalCase,
    )

    const commands = provider.backend.commands
    expect(commands.some((c) => c.endsWith(` fetch origin ${BASE}`))).toBe(true)
    expect(commands.some((c) => c.endsWith(` checkout -B factory/7 ${BASE}`))).toBe(true)
    expect(builder.prompts[0]).toContain('# Add a flag (#7)')
    expect(builder.prompts[0]).toContain('`pnpm test`')
    // Nobody answers a question during an evaluation.
    expect(builder.prompts[0]).toContain('do not ask one')
  })

  it('writes nothing outside the sandbox: no push, and GitHub is reachable without a credential', async () => {
    const provider = sandbox()

    await runCase(
      deps(
        provider,
        agent('builder', [{ ok: true, summary: 'done', sessionId: 's1' }]),
        agent('reviewer', [{ ok: true, summary: APPROVE }]),
      ),
      evalCase,
    )

    expect(provider.backend.commands.filter((c) => /\bpush\b|\bgh\b/.test(c))).toEqual([])
    const github = provider.specs[0].egress.find((rule) => rule.domain === 'github.com')
    expect(github).toEqual({ domain: 'github.com' })
    expect(provider.specs[0].egress.map((r) => r.domain)).toEqual([
      'github.com',
      'builder.example.com',
      'reviewer.example.com',
      'registry.npmjs.org',
      'example.org',
    ])
  })

  it('sends failed checks back to the builder and passes when the rework fixes them', async () => {
    const provider = sandbox({ checkExits: [1, 1, 0] })
    const builder = agent('builder', [
      { ok: true, summary: 'done', sessionId: 's1', costUsd: 0.2 },
      { ok: true, summary: 'fixed', sessionId: 's1', costUsd: 0.1 },
    ])

    const result = await runCase(
      deps(provider, builder, agent('reviewer', [{ ok: true, summary: APPROVE }])),
      evalCase,
    )

    expect(result).toMatchObject({ passed: true, attempts: 2, reviewRounds: 1 })
    expect(builder.prompts[1]).toContain('These checks failed on your commit')
  })

  it('sends a review that asks for changes back and passes when the next review approves', async () => {
    const builder = agent('builder', [
      { ok: true, summary: 'done', sessionId: 's1' },
      { ok: true, summary: 'added the test', sessionId: 's1' },
    ])
    const reviewer = agent('reviewer', [
      { ok: true, summary: CHANGES },
      { ok: true, summary: APPROVE },
    ])

    const result = await runCase(deps(sandbox(), builder, reviewer), evalCase)

    expect(result).toMatchObject({ passed: true, attempts: 2, reviewRounds: 2 })
    expect(builder.prompts[1]).toContain('add a test')
  })

  it('fails a case whose checks still fail after the last attempt', async () => {
    const builder = agent('builder', [
      { ok: true, summary: 'done', sessionId: 's1' },
      { ok: true, summary: 'try 2', sessionId: 's1' },
      { ok: true, summary: 'try 3', sessionId: 's1' },
    ])

    const result = await runCase(
      deps(sandbox({ checkExits: [1, 1, 1, 1, 1, 1] }), builder, agent('reviewer', [])),
      evalCase,
    )

    expect(result).toMatchObject({ passed: false, reason: 'checks failed: tests', attempts: 3 })
  })

  it('fails an approved case whose diff touches .github/, as the factory would', async () => {
    const reviewer = agent('reviewer', [
      { ok: true, summary: APPROVE },
      { ok: true, summary: APPROVE },
      { ok: true, summary: APPROVE },
    ])
    const builder = agent('builder', [
      { ok: true, summary: 'done', sessionId: 's1' },
      { ok: true, summary: 'again', sessionId: 's1' },
      { ok: true, summary: 'again', sessionId: 's1' },
    ])

    const result = await runCase(
      deps(sandbox({ nameStatus: 'M\t.github/workflows/ci.yml\n' }), builder, reviewer),
      evalCase,
    )

    expect(result.passed).toBe(false)
    expect(result.reason).toContain('outside the rules: the change touches .github/')
  })

  it('fails a case where the builder changed nothing, and still stops the sandbox', async () => {
    const provider = sandbox({ dirty: false })

    const result = await runCase(
      deps(
        provider,
        agent('builder', [{ ok: true, summary: 'nothing to do' }]),
        agent('reviewer', []),
      ),
      evalCase,
    )

    expect(result).toMatchObject({ passed: false, reason: 'the agent made no change' })
    expect(provider.stopped).toBe(1)
  })

  it('fails a case whose builder asked a question nobody will answer', async () => {
    const result = await runCase(
      deps(
        sandbox(),
        agent('builder', [{ ok: true, summary: 'QUESTION: which flag name?' }]),
        agent('reviewer', []),
      ),
      evalCase,
    )

    expect(result).toMatchObject({ passed: false, reason: 'the agent asked a question' })
  })

  it('fails a case whose builder did not finish, with what it said', async () => {
    const result = await runCase(
      deps(
        sandbox(),
        agent('builder', [{ ok: false, summary: 'timed out' }]),
        agent('reviewer', []),
      ),
      evalCase,
    )

    expect(result).toMatchObject({ passed: false, reason: 'the agent did not finish: timed out' })
  })

  it('refuses a base that is not a full commit hash before a sandbox starts', async () => {
    const provider = sandbox()

    const result = await runCase(deps(provider, agent('builder', []), agent('reviewer', [])), {
      ...evalCase,
      baseSha: 'HEAD; rm -rf /',
    })

    expect(result).toMatchObject({ passed: false })
    expect(result.reason).toContain('is not a commit hash')
    expect(provider.specs).toEqual([])
  })
})
