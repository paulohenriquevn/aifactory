import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CHANGESET_CHECK_SCRIPT } from '../factory/changeset-check'
import { CHANGESET_CHECK_PATH, withChangesetCheck } from '../factory/changesets'
import { FakeSandbox, type Reply } from '../factory/fake-sandbox'
import type { CodingHarness, HarnessInput, HarnessResult } from '../factory/harness'

import type { EvalCase } from './cases'
import { failedForEnvironment } from './compare'
import { runCase } from './run-case'
import { writeJson } from './suite'

const BASE = 'a'.repeat(40)

const evalCase: EvalCase = {
  id: 'o/r#7',
  repository: 'o/r',
  issueNumber: 7,
  title: 'Add a flag',
  body: 'The CLI needs --dry-run.',
  labels: ['factory', 'bug'],
  kind: 'bug',
  integrationBranch: 'workspace',
  baseSha: BASE,
  checks: [{ name: 'tests', command: 'pnpm test' }],
  egress: ['example.org'],
  original: { taskId: 1, costUsd: 0.4, durationMs: 600_000, attempts: 1, mergedSha: 'm' },
}

const APPROVE = '{"verdict":"approve","summary":"good","findings":[]}'
const CHANGES =
  '{"verdict":"changes","summary":"no test","findings":[{"severity":"major","issue":"add a test"}]}'
const PLAN = JSON.stringify({
  files: [{ path: 'src/cli.ts', why: 'the flag' }],
  order: ['add the flag'],
  risks: [],
  proof: ['pnpm test'],
  outOfScope: [],
})
/** The builder's planning turn, which every case with a builder that can resume starts with. */
const planned = (...answers: HarnessResult[]): HarnessResult[] => [
  { ok: true, summary: PLAN, sessionId: 's1' },
  ...answers,
]
const built = (summary = 'done', costUsd?: number): HarnessResult => ({
  ok: true,
  summary,
  sessionId: 's1',
  ...(costUsd === undefined ? {} : { costUsd }),
})

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
  /** Whether the planning turn left edits in the checkout, which the run then throws away. */
  plannedEdits?: boolean
  /** What `git status --porcelain` says after the builder worked. */
  dirty?: boolean
  /** Exit code of each run of the check command, in order. */
  checkExits?: number[]
  /** Exit code of each run of the check command on the case's base, in order; it passes there when none is left. */
  baseExits?: number[]
  /** `git diff --name-status` between the base and the commit. */
  nameStatus?: string
  /** `git diff --name-status` for each commit in turn, when it changes from round to round. */
  nameStatusPerCommit?: string[]
  /** `git diff -U0` of the test files between the base and the commit. */
  testPatch?: string
  /** Whether the builder committed by itself (a merge does), leaving one commit the run did not make. */
  agentCommitted?: boolean
  /** Whether the checkout is clean once a commit was made, as a real one is. */
  cleanAfterCommit?: boolean
  /** What a fix command answers (the command contains `fix-it`). */
  fix?: { exitCode?: number; timedOut?: boolean }
  /** Whether a fix command leaves a change in the checkout. */
  fixChanges?: boolean
  /** What the install check answers (the command ends with `&& pnpm install`). */
  install?: Reply[]
  /** What `git status --porcelain` says right after an install: what it changed in the checkout. */
  installChanges?: string
}

function sandbox(world: World = {}) {
  const exits = [...(world.checkExits ?? [0])]
  const baseExits = [...(world.baseExits ?? [])]
  let statuses = 0
  let commits = 0
  let fixed = false
  let installedLast = false
  return new FakeSandbox((command): Reply | undefined => {
    const afterInstall = installedLast
    installedLast = command.endsWith('&& pnpm install')
    if (command.includes('commit -F')) commits += 1
    if (command.endsWith('&& fix-it') && world.fixChanges) fixed = true
    if (command.endsWith('&& pnpm install') && world.install?.length) return world.install.shift()
    if (afterInstall && command.includes('status --porcelain'))
      return { stdout: world.installChanges ?? '' }
    if (command.includes('write-tree')) return { stdout: 'tree0\n' }
    if (command.includes('status --porcelain')) {
      const afterPlan = statuses++ === 0
      const changed = afterPlan
        ? world.plannedEdits === true
        : world.fixChanges
          ? fixed && commits === 0
          : world.cleanAfterCommit
          ? commits === 0
          : world.dirty !== false
      return { stdout: changed ? ' M src/cli.ts\n' : '' }
    }
    if (command.endsWith('&& fix-it')) return { ...world.fix } as Reply
    if (command.startsWith('cd /tmp/aifactory-base') && command.includes('pnpm test'))
      return { exitCode: baseExits.shift() ?? 0, stdout: 'ran' }
    if (command.includes('pnpm test')) return { exitCode: exits.shift() ?? 0, stdout: 'ran' }
    if (command.includes('diff --name-status'))
      return {
        stdout:
          world.nameStatusPerCommit?.[Math.max(commits, 1) - 1] ??
          world.nameStatus ??
          'M\tsrc/cli.ts\n',
      }
    if (command.includes('diff -U0')) return { stdout: world.testPatch ?? '' }
    if (command.includes('rev-list --count')) return { stdout: world.agentCommitted ? '1\n' : '0\n' }
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runCase', () => {
  it("plans the sandbox and the agent's pass against the limits of the repository", async () => {
    const provider = sandbox()
    const given: number[] = []
    const builder = agent('builder', planned(built()))
    const run = builder.resume!
    builder.resume = (backend, session, input) => {
      given.push(input.timeoutMs ?? 0)
      return run(backend, session, input)
    }
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])
    const MIN = 60_000

    await runCase(
      { ...deps(provider, builder, reviewer), timeouts: { sandboxMs: 150 * MIN, agentMs: 200 * MIN } },
      evalCase,
    )

    expect(provider.specs[0]!.timeoutMs).toBe(150 * MIN)
    // 150 minutes less the 25 kept for the checks and the review.
    expect(given[0]).toBeLessThanOrEqual(125 * MIN)
    expect(given[0]).toBeGreaterThan(124 * MIN)
  })

  it('stops the sandbox of a case that hangs once it is abandoned', async () => {
    const provider = sandbox()
    const builder = agent('builder', [])
    builder.run = () => new Promise<never>(() => {})
    builder.resume = () => new Promise<never>(() => {})
    const reviewer = agent('reviewer', [])
    const controller = new AbortController()

    const pending = runCase(deps(provider, builder, reviewer), evalCase, controller.signal)
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()
    const result = await pending

    expect(result.passed).toBe(false)
    expect(result.reason).toContain('abandoned')
    expect(provider.stopped).toBe(1)
  })

  it('starts nothing for a case abandoned before it begins', async () => {
    const provider = sandbox()
    const builder = agent('builder', planned(built()))
    const reviewer = agent('reviewer', [])
    const controller = new AbortController()
    controller.abort()

    const result = await runCase(deps(provider, builder, reviewer), evalCase, controller.signal)

    expect(result.reason).toContain('abandoned')
    expect(provider.specs).toHaveLength(0)
    expect(builder.prompts).toHaveLength(0)
  })

  it('starts no agent for a case abandoned during its setup', async () => {
    const provider = sandbox()
    const builder = agent('builder', planned(built()))
    const controller = new AbortController()
    builder.prepare = async () => controller.abort()
    const reviewer = agent('reviewer', [])

    const result = await runCase(deps(provider, builder, reviewer), evalCase, controller.signal)

    expect(result.reason).toContain('abandoned')
    expect(builder.prompts).toHaveLength(0)
    expect(provider.stopped).toBe(1)
  })

  it('stops a sandbox that comes up after the case was abandoned', async () => {
    const provider = sandbox()
    const create = provider.create.bind(provider)
    const controller = new AbortController()
    provider.create = async (spec) => {
      controller.abort()
      await new Promise((r) => setTimeout(r, 20))
      return create(spec)
    }
    const builder = agent('builder', planned(built()))
    const reviewer = agent('reviewer', [])

    const pending = runCase(deps(provider, builder, reviewer), evalCase, controller.signal)
    expect((await pending).reason).toContain('abandoned')
    await new Promise((r) => setTimeout(r, 60))

    expect(provider.stopped).toBe(1)
    expect(builder.prompts).toHaveLength(0)
  })

  it('starts no further agent call when an agent answers after its case was abandoned', async () => {
    const provider = sandbox()
    const builder = agent('builder', [built()])
    let answerPlan: (result: HarnessResult) => void = () => {}
    const run = builder.run
    builder.run = (backend, input) => {
      builder.run = run
      builder.prompts.push(input.prompt)
      return new Promise((resolve) => (answerPlan = resolve))
    }
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])
    const controller = new AbortController()

    const pending = runCase(deps(provider, builder, reviewer), evalCase, controller.signal)
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()
    expect((await pending).reason).toContain('abandoned')
    answerPlan({ ok: true, summary: PLAN, sessionId: 's1' })
    await new Promise((r) => setTimeout(r, 50))

    expect(builder.prompts).toHaveLength(1)
    expect(reviewer.prompts).toHaveLength(0)
  })

  it('sends no rework when the review answers after its case was abandoned', async () => {
    const provider = sandbox()
    const builder = agent('builder', planned(built(), built()))
    const reviewer = agent('reviewer', [])
    let answerReview: (result: HarnessResult) => void = () => {}
    reviewer.run = (_backend, input) => {
      reviewer.prompts.push(input.prompt)
      return new Promise((resolve) => (answerReview = resolve))
    }
    const controller = new AbortController()

    const pending = runCase(deps(provider, builder, reviewer), evalCase, controller.signal)
    await vi.waitFor(() => expect(reviewer.prompts).toHaveLength(1))
    controller.abort()
    expect((await pending).reason).toContain('abandoned')
    answerReview({ ok: true, summary: CHANGES })
    await new Promise((r) => setTimeout(r, 50))

    expect(builder.prompts).toHaveLength(2)
    expect(reviewer.prompts).toHaveLength(1)
  })

  it('does not stop a finished case again when a later case is abandoned', async () => {
    const provider = sandbox()
    const builder = agent('builder', planned(built('done', 0.3)))
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])
    const controller = new AbortController()

    await runCase(deps(provider, builder, reviewer), evalCase, controller.signal)
    controller.abort()

    expect(provider.stopped).toBe(1)
  })

  it('lets a planner apart from the builder write the plan, and gives the builder that plan in a session of its own', async () => {
    const provider = sandbox()
    const planner = agent('codex', [{ ok: true, summary: PLAN, sessionId: 'p1' }])
    const builder = agent('builder', [built()])
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])

    const result = await runCase({ ...deps(provider, builder, reviewer), planner }, evalCase)

    expect(result.passed).toBe(true)
    expect(planner.prompts[0]).toContain('# This turn: plan only')
    expect(builder.prompts).toHaveLength(1)
    expect(builder.prompts[0]).toContain('codex read the code and wrote this plan')
    expect(builder.prompts[0]).toContain('`src/cli.ts`')
  })

  it('passes a case whose checks pass and whose review approves, with its cost and rounds', async () => {
    const provider = sandbox()
    const builder = agent('builder', planned(built('done', 0.3)))
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

  it("runs the repository's fixes before the checks and commits what they changed as its own commit", async () => {
    const provider = sandbox()
    const builder = agent('builder', planned(built()))
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])

    const result = await runCase(deps(provider, builder, reviewer), {
      ...evalCase,
      fixes: ['prettier --write .'],
    })

    const commands = provider.backend.commands
    const fix = commands.findIndex((c) => c.endsWith('prettier --write .'))
    expect(fix).toBeGreaterThan(-1)
    expect(commands.filter((c) => c.includes('commit -F'))).toHaveLength(2)
    expect(commands.findIndex((c) => c.includes('pnpm test'))).toBeGreaterThan(fix)
    expect(result.passed).toBe(true)
  })

  it.each([
    ['fails', { exitCode: 1 }],
    ['runs past its limit', { exitCode: 0, timedOut: true }],
  ])('leaves the work as it was and still checks it when a fix %s', async (_what, fix) => {
    const provider = sandbox({ cleanAfterCommit: true, fix })
    const builder = agent('builder', planned(built()))
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])

    const result = await runCase(deps(provider, builder, reviewer), {
      ...evalCase,
      fixes: ['fix-it'],
    })

    const commands = provider.backend.commands
    const fixAt = commands.findIndex((c) => c.endsWith('&& fix-it'))
    expect(fixAt).toBeGreaterThan(-1)
    // The work is put back, no commit holds the fix, and the checks ran after it.
    expect(commands.slice(fixAt).some((c) => c.includes('checkout-index'))).toBe(true)
    expect(commands.filter((c) => c.includes('commit -F'))).toHaveLength(1)
    expect(commands.findIndex((c) => c.includes('pnpm test'))).toBeGreaterThan(fixAt)
    expect(result.passed).toBe(true)
  })

  it('does not keep what a fix left when the work could not be put back', async () => {
    const provider = sandbox({ cleanAfterCommit: true, fix: { exitCode: 1 } })
    const real = provider.backend.execute.bind(provider.backend)
    provider.backend.execute = async (command: string) =>
      command.includes('checkout-index') ? { stdout: '', stderr: '', exitCode: 1, timedOut: false } : real(command)
    const builder = agent('builder', planned(built()))
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])

    await runCase(deps(provider, builder, reviewer), { ...evalCase, fixes: ['fix-it'] })

    const commands = provider.backend.commands
    expect(commands.some((c) => c.includes('reset -q --hard'))).toBe(true)
    expect(commands.filter((c) => c.includes('commit -F'))).toHaveLength(1)
  })

  it('reports the cost of the plan when no time is left for the next pass', async () => {
    const MIN = 60_000
    const plan = planned()[0]!
    const builder = agent('builder', [{ ...plan, costUsd: 0.3 }])
    const run = builder.run
    const real = Date.now()
    let now = real
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    builder.run = async (backend, input) => {
      now += 30 * MIN
      return run(backend, input)
    }
    const reviewer = agent('reviewer', [])

    const result = await runCase(
      { ...deps(sandbox(), builder, reviewer), timeouts: { sandboxMs: 45 * MIN, agentMs: 30 * MIN } },
      evalCase,
    )

    expect(result.passed).toBe(false)
    expect(result.reason).toContain('no time left for another agent pass')
    expect(result.costUsd).toBeCloseTo(0.3)
    expect(builder.prompts).toHaveLength(1)
  })

  it('writes the script of the changeset check into the sandbox for a case that runs it', async () => {
    const provider = sandbox()
    const builder = agent('builder', planned(built()))
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])
    const checks = withChangesetCheck(evalCase.checks, true, 'workspace')

    const result = await runCase(deps(provider, builder, reviewer), { ...evalCase, checks })

    expect(result).toMatchObject({ passed: true })
    expect(provider.backend.files.get(CHANGESET_CHECK_PATH)).toBe(CHANGESET_CHECK_SCRIPT)
  })

  it('has the script of the changeset check in the sandbox before the builder runs', async () => {
    const provider = sandbox()
    const inner = agent('builder', planned(built()))
    const seen: Array<string | undefined> = []
    const builder = {
      ...inner,
      run: (b: Parameters<typeof inner.run>[0], input: Parameters<typeof inner.run>[1]) => {
        seen.push(provider.backend.files.get(CHANGESET_CHECK_PATH))
        return inner.run(b, input)
      },
    }
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])
    const checks = withChangesetCheck(evalCase.checks, true, 'workspace')

    await runCase(deps(provider, builder, reviewer), { ...evalCase, checks })

    expect(seen[0]).toBe(CHANGESET_CHECK_SCRIPT)
  })

  it('starts from the base commit of the case, with the same prompt a task gets', async () => {
    const provider = sandbox()
    const builder = agent('builder', planned(built()))

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

  it('plans before it builds, and builds in the session that wrote the plan', async () => {
    const builder = agent('builder', planned(built()))

    await runCase(
      deps(sandbox(), builder, agent('reviewer', [{ ok: true, summary: APPROVE }])),
      evalCase,
    )

    expect(builder.prompts[0]).toContain('# This turn: plan only')
    expect(builder.prompts[1]).toContain('Implement the plan you wrote')
    expect(builder.prompts[1]).not.toContain('was discarded')
  })

  it('throws away what the planning turn changed, and tells the builder so', async () => {
    const provider = sandbox({ plannedEdits: true })
    const builder = agent('builder', planned(built()))

    await runCase(
      deps(provider, builder, agent('reviewer', [{ ok: true, summary: APPROVE }])),
      evalCase,
    )

    expect(provider.backend.commands.some((c) => c.endsWith(`reset --hard ${BASE}`))).toBe(true)
    expect(builder.prompts[1]).toContain('what you changed in it was discarded')
  })

  it('asks for the plan once more when the first answer had none', async () => {
    const builder = agent('builder', [
      { ok: true, summary: 'I read the code.', sessionId: 's1' },
      { ok: true, summary: PLAN, sessionId: 's1' },
      built(),
    ])

    const result = await runCase(
      deps(sandbox(), builder, agent('reviewer', [{ ok: true, summary: APPROVE }])),
      evalCase,
    )

    expect(result.passed).toBe(true)
    expect(builder.prompts[1]).toContain('Your answer had no plan that could be read')
  })

  it('fails a case whose builder writes no plan even when asked again', async () => {
    const builder = agent('builder', [
      { ok: true, summary: 'I read the code.', sessionId: 's1' },
      { ok: true, summary: 'Still reading.', sessionId: 's1' },
    ])

    const result = await runCase(deps(sandbox(), builder, agent('reviewer', [])), evalCase)

    expect(result).toMatchObject({ passed: false, reason: 'the agent wrote no plan: Still reading.' })
  })

  it('shows the reviewer the plan and the files the diff changed outside it', async () => {
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])

    await runCase(
      deps(
        sandbox({ nameStatus: 'M\tsrc/cli.ts\nM\tREADME.md\n' }),
        agent('builder', planned(built('changed the flag and the readme'))),
        reviewer,
      ),
      evalCase,
    )

    expect(reviewer.prompts[0]).toContain("# The builder's plan")
    expect(reviewer.prompts[0]).toContain('- `README.md`')
    expect(reviewer.prompts[0]).toContain('changed the flag and the readme')
  })

  it('writes nothing outside the sandbox: no push, and GitHub is reachable without a credential', async () => {
    const provider = sandbox()

    await runCase(
      deps(
        provider,
        agent('builder', planned(built())),
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

  it('lets a planner apart from the builder and the reviewer reach its service and prepares it in the sandbox', async () => {
    const provider = sandbox()
    const planner = agent('planner', [])
    let prepared = false
    planner.prepare = async () => {
      prepared = true
    }

    await runCase(
      {
        ...deps(
          provider,
          agent('builder', planned(built())),
          agent('reviewer', [{ ok: true, summary: APPROVE }]),
        ),
        planner,
      },
      evalCase,
    )

    expect(provider.specs[0].egress.map((r) => r.domain)).toContain('planner.example.com')
    expect(prepared).toBe(true)
  })

  it('sends failed checks back to the builder and passes when the rework fixes them', async () => {
    const provider = sandbox({ checkExits: [1, 1, 0] })
    const builder = agent('builder', planned(built('done', 0.2), built('fixed', 0.1)))

    const result = await runCase(
      deps(provider, builder, agent('reviewer', [{ ok: true, summary: APPROVE }])),
      evalCase,
    )

    expect(result).toMatchObject({ passed: true, attempts: 2, reviewRounds: 1 })
    expect(builder.prompts[2]).toContain('These checks failed on your commit')
  })

  it('tells the reviewer what a failed check required, and never sends that file back as outside the plan', async () => {
    const [first, second] = ['c'.repeat(40), 'd'.repeat(40)]
    const exits = [1, 1, 0]
    let commits = 0
    let statuses = 0
    const provider = new FakeSandbox((command): Reply | undefined => {
      if (command.includes('status --porcelain'))
        return { stdout: statuses++ === 0 ? '' : ' M src/cli.ts\n' }
      if (command.includes('commit -F')) commits += 1
      if (command.includes('pnpm test'))
        return { exitCode: exits.shift() ?? 0, stdout: 'error no changesets were found' }
      if (command.includes('rev-parse HEAD')) return { stdout: commits <= 1 ? first : second }
      if (command.includes('rev-list')) return { stdout: `${second}\n${first}\n` }
      if (command.includes('diff --name-status'))
        return { stdout: 'M\tsrc/cli.ts\nA\t.changeset/calm-owls.md\nM\tsrc/other.ts\n' }
      if (command.includes('diff --name-only --diff-filter=A'))
        return { stdout: '.changeset/calm-owls.md\n' }
      if (command.includes(`show ${second}:.changeset/calm-owls.md`))
        return { stdout: '---\n"app": patch\n---\n' }
      return undefined
    })
    const builder = agent('builder', planned(built(), built('added a changeset'), built('again')))
    const reviewer = agent('reviewer', [
      { ok: true, summary: CHANGES },
      { ok: true, summary: APPROVE },
    ])

    const result = await runCase(deps(provider, builder, reviewer), evalCase)

    expect(result).toMatchObject({ passed: true, attempts: 3, reviewRounds: 2 })
    expect(reviewer.prompts[0]).toContain("# What the factory's checks required")
    expect(reviewer.prompts[0]).toContain('The check `tests` (`pnpm test`) failed on ccccccc')
    expect(reviewer.prompts[0]).toContain('> error no changesets were found')
    expect(reviewer.prompts[0]).toContain('- `.changeset/calm-owls.md`')
    expect(builder.prompts[3]).toContain('`src/other.ts`: changed outside the plan')
    expect(builder.prompts[3]).not.toContain('.changeset/calm-owls.md')
  })

  const changesWith = (n: number) =>
    JSON.stringify({
      verdict: 'changes',
      summary: 'wrong',
      findings: Array.from({ length: n }, (_, i) => ({ severity: 'major', issue: `problem ${i}` })),
    })
  const rounds = (...sizes: number[]) =>
    sizes.map((n): HarnessResult => ({ ok: true, summary: changesWith(n) }))

  it('gives a fourth review round when the blocking findings fall: 4, 3, 2', async () => {
    const builder = agent('builder', planned(built(), built(), built(), built()))
    const reviewer = agent('reviewer', [...rounds(4, 3, 2), { ok: true, summary: APPROVE }])

    const result = await runCase(deps(sandbox(), builder, reviewer), evalCase)

    expect(result).toMatchObject({ passed: true, reviewRounds: 4 })
  })

  it('stops after three rounds when the blocking findings do not fall: 5, 6, 7', async () => {
    const builder = agent('builder', planned(built(), built(), built()))
    const reviewer = agent('reviewer', rounds(5, 6, 7))

    const result = await runCase(deps(sandbox(), builder, reviewer), evalCase)

    expect(result).toMatchObject({ passed: false, reviewRounds: 3 })
  })

  it('stops at the higher limit while the findings still fall', async () => {
    const builder = agent('builder', planned(built(), built(), built(), built(), built(), built()))
    const reviewer = agent('reviewer', rounds(9, 8, 7, 6, 5, 4))

    const result = await runCase(deps(sandbox(), builder, reviewer), evalCase)

    expect(result).toMatchObject({ passed: false, reviewRounds: 6 })
  })

  const deletedTests = (n: number) =>
    'M\tsrc/cli.ts\n' + Array.from({ length: n }, (_, i) => `D\tsrc/old${i}.test.ts\n`).join('')

  it('counts the factory\'s own guards: blocking guards that fall give another round, 4, 3, 2', async () => {
    const provider = sandbox({
      nameStatusPerCommit: [deletedTests(4), deletedTests(3), deletedTests(2), deletedTests(0)],
    })
    const builder = agent('builder', planned(built(), built(), built(), built()))
    const reviewer = agent('reviewer', [
      ...[0, 0, 0].map((n): HarnessResult => ({ ok: true, summary: changesWith(n) })),
      { ok: true, summary: APPROVE },
    ])

    const result = await runCase(deps(provider, builder, reviewer), evalCase)

    expect(result).toMatchObject({ passed: true, reviewRounds: 4 })
  })

  it('counts guards that block an approval, and stops when they do not fall', async () => {
    const approving = (): HarnessResult => ({ ok: true, summary: APPROVE })
    const rising = sandbox({
      nameStatusPerCommit: [deletedTests(5), deletedTests(6), deletedTests(7)],
    })
    const stopped = await runCase(
      deps(
        rising,
        agent('builder', planned(built(), built(), built())),
        agent('reviewer', [approving(), approving(), approving()]),
      ),
      evalCase,
    )
    expect(stopped).toMatchObject({ passed: false, reviewRounds: 3 })

    const falling = sandbox({
      nameStatusPerCommit: [deletedTests(4), deletedTests(3), deletedTests(2), deletedTests(0)],
    })
    const continued = await runCase(
      deps(
        falling,
        agent('builder', planned(built(), built(), built(), built())),
        agent('reviewer', [approving(), approving(), approving(), approving()]),
      ),
      evalCase,
    )
    expect(continued).toMatchObject({ passed: true, reviewRounds: 4 })
  })

  it('says nothing to the reviewer about the checks when none failed', async () => {
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])

    await runCase(deps(sandbox(), agent('builder', planned(built())), reviewer), evalCase)

    expect(reviewer.prompts[0]).not.toContain("# What the factory's checks required")
  })

  it('sends a review that asks for changes back and passes when the next review approves', async () => {
    const builder = agent('builder', planned(built(), built('added the test')))
    const reviewer = agent('reviewer', [
      { ok: true, summary: CHANGES },
      { ok: true, summary: APPROVE },
    ])

    const result = await runCase(deps(sandbox(), builder, reviewer), evalCase)

    expect(result).toMatchObject({ passed: true, attempts: 2, reviewRounds: 2 })
    expect(builder.prompts[2]).toContain('add a test')
  })

  it('tells the builder of a review rework where its whole change starts, as the factory does', async () => {
    const builder = agent('builder', planned(built(), built('added the test')))
    const reviewer = agent('reviewer', [
      { ok: true, summary: CHANGES },
      { ok: true, summary: APPROVE },
    ])

    await runCase(deps(sandbox(), builder, reviewer), evalCase)

    expect(builder.prompts[2]).toContain(`read your whole change again with \`git diff ${BASE}\``)
  })

  it('gives the second review round the findings of the first, as the factory does', async () => {
    const builder = agent('builder', planned(built(), built('added the test')))
    const reviewer = agent('reviewer', [
      { ok: true, summary: CHANGES },
      { ok: true, summary: APPROVE },
    ])

    await runCase(deps(sandbox(), builder, reviewer), evalCase)

    expect(reviewer.prompts[0]).not.toContain('# Your earlier review')
    expect(reviewer.prompts[1]).toContain('# Your earlier review')
    expect(reviewer.prompts[1]).toContain('add a test')
  })

  it('keeps the builder\'s answer to a review for the next review, past a rework for failing checks', async () => {
    const provider = sandbox({ checkExits: [0, 1, 1, 0] })
    const builder = agent(
      'builder',
      planned(built(), built('declined: out of scope'), built('fixed the check')),
    )
    const reviewer = agent('reviewer', [
      { ok: true, summary: CHANGES },
      { ok: true, summary: APPROVE },
    ])

    await runCase(deps(provider, builder, reviewer), evalCase)

    expect(reviewer.prompts[1]).toContain('declined: out of scope')
    expect(reviewer.prompts[1]).not.toContain('fixed the check')
  })

  it('runs the checks again on the same commit when the rework after them changes nothing, as the factory does', async () => {
    const provider = sandbox({ cleanAfterCommit: true, checkExits: [1, 1, 0] })
    const builder = agent('builder', planned(built(), built('the failure was a timeout')))

    const result = await runCase(
      deps(provider, builder, agent('reviewer', [{ ok: true, summary: APPROVE }])),
      evalCase,
    )

    expect(result).toMatchObject({ passed: true, attempts: 2, reviewRounds: 1 })
    expect(provider.backend.commands.filter((c) => c.includes('commit -F'))).toHaveLength(1)
  })

  it('leaves unmeasured a case whose failing checks, left unchanged by the builder, fail on its base too', async () => {
    const provider = sandbox({ cleanAfterCommit: true, checkExits: [1, 1], baseExits: [1, 1] })
    const builder = agent('builder', planned(built(), built('the failure is not my change')))

    const result = await runCase(deps(provider, builder, agent('reviewer', [])), evalCase)

    expect(result).toMatchObject({ passed: false, attempts: 2 })
    expect(result.reason).toContain('so the case measures its base, not the agents')
    expect(failedForEnvironment(result)).toBe(true)
    expect(provider.backend.commands.some((c) => c.startsWith('cd /tmp/aifactory-base &&'))).toBe(
      true,
    )
  })

  it('ends a case as handed over when the reviewer still blocks after judging the reasons of a rework that changed nothing', async () => {
    const builder = agent('builder', planned(built(), built('the finding is outside the issue')))
    const reviewer = agent('reviewer', [{ ok: true, summary: CHANGES }])

    const result = await runCase(
      deps(sandbox({ cleanAfterCommit: true }), builder, reviewer),
      evalCase,
    )

    expect(result).toMatchObject({ passed: false, attempts: 2, reviewRounds: 2 })
    expect(reviewer.prompts[1]).toContain('the finding is outside the issue')
  })

  it('passes a case whose reviewer approves after judging the reasons of a rework that changed nothing', async () => {
    const builder = agent('builder', planned(built(), built('the finding is outside the issue')))
    const reviewer = agent('reviewer', [
      { ok: true, summary: CHANGES },
      { ok: true, summary: APPROVE },
    ])

    const result = await runCase(
      deps(sandbox({ cleanAfterCommit: true }), builder, reviewer),
      evalCase,
    )

    expect(result).toMatchObject({ passed: true, reviewRounds: 2 })
  })

  it('ends as the factory hands it over when the last rework breaks the checks of a reviewed commit, restored', async () => {
    // The review's rework breaks the checks, and so do both reworks the checks get after it.
    const provider = sandbox({ checkExits: [0, 1, 1, 1, 1, 1, 1, 0] })
    const builder = agent(
      'builder',
      planned(built(), built('first rework'), built('second rework'), built('third rework')),
    )
    const reviewer = agent('reviewer', [{ ok: true, summary: CHANGES }])

    const result = await runCase(deps(provider, builder, reviewer), evalCase)

    expect(result).toMatchObject({ passed: false, reason: 'the reviewer asked for changes' })
    expect(reviewer.prompts).toHaveLength(1)
    expect(provider.backend.commands.some((c) => c.includes(`restore --source=${'b'.repeat(40)}`))).toBe(
      true,
    )
  })

  it('still gives the review its own rounds after two reworks for failing checks', async () => {
    const provider = sandbox({ checkExits: [1, 1, 1, 1, 0, 0] })
    const builder = agent(
      'builder',
      planned(built(), built('first rework'), built('second rework'), built('review rework')),
    )
    const reviewer = agent('reviewer', [
      { ok: true, summary: CHANGES },
      { ok: true, summary: APPROVE },
    ])

    const result = await runCase(deps(provider, builder, reviewer), evalCase)

    expect(result).toMatchObject({ passed: true })
    expect(reviewer.prompts).toHaveLength(2)
  })

  it('fails on the checks when they fail on the restored commit too', async () => {
    const provider = sandbox({ checkExits: [0, 1, 1, 1, 1, 1, 1, 1, 1] })
    const builder = agent(
      'builder',
      planned(built(), built('first rework'), built('second rework'), built('third rework')),
    )
    const reviewer = agent('reviewer', [{ ok: true, summary: CHANGES }])

    const result = await runCase(deps(provider, builder, reviewer), evalCase)

    expect(result).toMatchObject({ passed: false, reason: 'checks failed: tests' })
  })

  it('leaves unmeasured a case whose checks fail again after a rework that changed code, when they fail on its base too', async () => {
    const builder = agent('builder', planned(built(), built('try 2'), built('try 3')))
    const provider = sandbox({ checkExits: [1, 1, 1, 1], baseExits: [1, 1] })

    const result = await runCase(deps(provider, builder, agent('reviewer', [])), evalCase)

    expect(result).toMatchObject({ passed: false, attempts: 2 })
    expect(failedForEnvironment(result)).toBe(true)
  })

  it('fails a case whose checks still fail after the last attempt', async () => {
    const builder = agent('builder', planned(built(), built('try 2'), built('try 3')))

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
    const builder = agent('builder', planned(built(), built('again'), built('again')))

    const result = await runCase(
      deps(sandbox({ nameStatus: 'M\t.github/workflows/ci.yml\n' }), builder, reviewer),
      evalCase,
    )

    expect(result.passed).toBe(false)
    expect(result.reason).toContain('outside the rules: the change touches .github/')
  })

  it('fails an approved bug fix that removed an assertion from a test that was there', async () => {
    const reviewer = agent('reviewer', [
      { ok: true, summary: APPROVE },
      { ok: true, summary: APPROVE },
      { ok: true, summary: APPROVE },
    ])
    const builder = agent('builder', planned(built(), built('again'), built('again')))
    const testPatch = [
      'diff --git a/src/cli.test.ts b/src/cli.test.ts',
      '--- a/src/cli.test.ts',
      '+++ b/src/cli.test.ts',
      '@@ -3 +2,0 @@',
      '-  expect(parse(["--dry-run"])).toEqual({ dryRun: true })',
      '',
    ].join('\n')

    const result = await runCase(deps(sandbox({ testPatch }), builder, reviewer), evalCase)

    expect(result.passed).toBe(false)
    expect(result.reason).toContain('the change weakens a test that was there before it')
  })

  it('checks and reviews the fix commit when the builder changed nothing and the fixes did', async () => {
    const provider = sandbox({ fixChanges: true })

    const result = await runCase(
      deps(
        provider,
        agent('builder', planned(built('nothing to do'))),
        agent('reviewer', [{ ok: true, summary: APPROVE }]),
      ),
      { ...evalCase, fixes: ['fix-it'] },
    )

    const commands = provider.backend.commands
    expect(commands.filter((c) => c.endsWith('&& fix-it'))).toHaveLength(1)
    expect(commands.filter((c) => c.includes('commit -F'))).toHaveLength(1)
    expect(commands.findIndex((c) => c.includes('pnpm test'))).toBeGreaterThan(
      commands.findIndex((c) => c.includes('commit -F')),
    )
    expect(result.passed).toBe(true)
  })

  it('fails a case where the builder changed nothing, and still stops the sandbox', async () => {
    const provider = sandbox({ dirty: false })

    const result = await runCase(
      deps(provider, agent('builder', planned(built('nothing to do'))), agent('reviewer', [])),
      evalCase,
    )

    expect(result).toMatchObject({ passed: false, reason: 'the agent made no change' })
    expect(provider.stopped).toBe(1)
  })

  it('goes on with a commit the builder made by itself, adding none of its own', async () => {
    const provider = sandbox({ dirty: false, agentCommitted: true })
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])

    const result = await runCase(
      deps(provider, agent('builder', planned(built('merged the base'))), reviewer),
      evalCase,
    )

    expect(result).toMatchObject({ passed: true })
    expect(provider.backend.commands.some((c) => c.includes('commit -F'))).toBe(false)
  })

  it('fails a case whose builder asked a question nobody will answer', async () => {
    const result = await runCase(
      deps(
        sandbox(),
        agent('builder', planned(built('QUESTION: which flag name?'))),
        agent('reviewer', []),
      ),
      evalCase,
    )

    expect(result).toMatchObject({ passed: false, reason: 'the agent asked a question' })
  })

  it('fails a case whose builder did not finish the plan, with what it said', async () => {
    const result = await runCase(
      deps(
        sandbox(),
        agent('builder', [{ ok: false, summary: 'timed out' }]),
        agent('reviewer', []),
      ),
      evalCase,
    )

    expect(result).toMatchObject({
      passed: false,
      reason: 'the agent did not finish the plan: timed out',
    })
  })

  it('fails a case whose builder did not finish the work, with what it said', async () => {
    const result = await runCase(
      deps(
        sandbox(),
        agent('builder', planned({ ok: false, summary: 'out of time' })),
        agent('reviewer', []),
      ),
      evalCase,
    )

    expect(result).toMatchObject({
      passed: false,
      reason: 'the agent did not finish: out of time',
    })
  })

  it('builds without a plan when the builder cannot continue a session, as a task does', async () => {
    const builder = { ...agent('builder', [built()]), resume: undefined }
    // With no planning turn, the first look at the checkout is the one before the commit.
    const provider = sandbox({ plannedEdits: true })

    const result = await runCase(
      deps(provider, builder, agent('reviewer', [{ ok: true, summary: APPROVE }])),
      evalCase,
    )

    expect(result).toMatchObject({ passed: true, reason: 'approved' })
    expect(builder.prompts[0]).not.toContain('# This turn: plan only')
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

describe('runCase install', () => {
  const withInstall = {
    ...evalCase,
    checks: [{ name: 'install', command: 'pnpm install' }, ...evalCase.checks],
  }
  const installs = (provider: FakeSandbox) =>
    provider.backend.commands.filter((c) => c.endsWith('&& pnpm install'))

  it('installs the project before the builder runs, and again for the checks', async () => {
    const provider = sandbox()
    const inner = agent('builder', planned(built()))
    const seen: number[] = []
    const builder = {
      ...inner,
      run: (b: Parameters<typeof inner.run>[0], input: Parameters<typeof inner.run>[1]) => {
        seen.push(installs(provider).length)
        return inner.run(b, input)
      },
    }

    await runCase(deps(provider, builder, agent('reviewer', [{ ok: true, summary: APPROVE }])), withInstall)

    expect(seen[0]).toBe(1)
    // The checks clean and install on their own: one for the builder, one for the commit.
    expect(installs(provider)).toHaveLength(2)
    expect(builder.prompts[0]).not.toContain('before your pass to install')
  })

  it('tells the builder a failed install and goes on', async () => {
    const provider = sandbox({ install: [{ exitCode: 1, stderr: 'tarball missing' }] })
    const builder = agent('builder', planned(built()))

    const result = await runCase(
      deps(provider, builder, agent('reviewer', [{ ok: true, summary: APPROVE }])),
      withInstall,
    )

    expect(builder.prompts[0]).toContain('before your pass to install')
    expect(builder.prompts[0]).toContain('tarball missing')
    // Only the preparatory install failed: the work went on, in the same session, and the checks installed again.
    expect(builder.prompts).toHaveLength(2)
    expect(installs(provider)).toHaveLength(2)
    expect(result).toMatchObject({ passed: true, reason: 'approved' })
  })

  it('gives the failure to the builder call that does the work, when another agent planned', async () => {
    const provider = sandbox({ install: [{ exitCode: 1, stderr: 'tarball missing' }] })
    const planner = agent('codex', [{ ok: true, summary: PLAN, sessionId: 'p1' }])
    const builder = agent('builder', [built()])
    const reviewer = agent('reviewer', [{ ok: true, summary: APPROVE }])

    const result = await runCase({ ...deps(provider, builder, reviewer), planner }, withInstall)

    expect(result).toMatchObject({ passed: true, reason: 'approved' })
    expect(builder.prompts).toHaveLength(1)
    expect(builder.prompts[0]).toContain('tarball missing')
    expect(installs(provider)).toHaveLength(2)
  })

  it('puts back what the install changed in the checkout before the builder runs', async () => {
    const provider = sandbox({ installChanges: ' M pnpm-lock.yaml\n' })
    const inner = agent('builder', planned(built()))
    const restoredBefore: boolean[] = []
    const builder = {
      ...inner,
      run: (b: Parameters<typeof inner.run>[0], input: Parameters<typeof inner.run>[1]) => {
        restoredBefore.push(
          provider.backend.commands.some((c) => c.endsWith(' clean -fdq')) &&
            provider.backend.commands.some((c) => c.includes('restore --staged --worktree :/')),
        )
        return inner.run(b, input)
      },
    }

    await runCase(
      deps(provider, builder, agent('reviewer', [{ ok: true, summary: APPROVE }])),
      withInstall,
    )

    expect(restoredBefore[0]).toBe(true)
  })

  it('runs no install for a case with no install check', async () => {
    const provider = sandbox()
    await runCase(
      deps(provider, agent('builder', planned(built())), agent('reviewer', [{ ok: true, summary: APPROVE }])),
      evalCase,
    )
    expect(installs(provider)).toEqual([])
  })
})

describe('runCase review record', () => {
  const round = (n: number) => ({
    verdict: 'changes',
    summary: `round ${n}`,
    findings: [{ severity: n === 2 ? 'minor' : 'major', file: `src/f${n}.ts`, issue: `problem ${n}` }],
  })
  const answer = (n: number): HarnessResult => ({ ok: true, summary: JSON.stringify(round(n)) })

  it('keeps the distinct verdict of every review round in the run file', async () => {
    const builder = agent('builder', planned(built(), built(), built()))
    const reviewer = agent('reviewer', [answer(1), answer(2), answer(3)])
    const result = await runCase(deps(sandbox(), builder, reviewer), evalCase)
    expect(result.passed).toBe(false)

    const dir = mkdtempSync(join(tmpdir(), 'evals-'))
    const path = join(dir, 'run.json')
    writeJson(path, { results: [result] })
    const written = JSON.parse(readFileSync(path, 'utf8'))

    expect(written.results[0].reviews).toEqual([round(1), round(2), round(3)])
    rmSync(dir, { recursive: true })
  })

  it('keeps the completed reviews of a case that is abandoned during a later review', async () => {
    const builder = agent('builder', planned(built(), built()))
    const reviewer = agent('reviewer', [answer(1)])
    const first = reviewer.run
    const controller = new AbortController()
    reviewer.run = (backend, input) => {
      reviewer.run = () => new Promise(() => {})
      return first(backend, input)
    }
    const pending = runCase(deps(sandbox(), builder, reviewer), evalCase, controller.signal)
    await vi.waitFor(() => expect(builder.prompts.length).toBeGreaterThanOrEqual(3))
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()

    const result = await pending
    expect(result.reason).toContain('abandoned')
    expect(result.reviews).toEqual([round(1)])
  })

  it('keeps the completed reviews of a case that fails with an error after a review', async () => {
    const builder = agent('builder', planned(built(), built()))
    const reviewer = agent('reviewer', [answer(1)])
    const first = reviewer.run
    reviewer.run = (backend, input) => {
      reviewer.run = () => Promise.reject(new Error('boom'))
      return first(backend, input)
    }
    const result = await runCase(deps(sandbox(), builder, reviewer), evalCase)
    expect(result.reason).toContain('boom')
    expect(result.reviews).toEqual([round(1)])
  })
})
