import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { retryableFailure } from '../../shared/panel'
import { GET } from '../routes/panel/codex/login'

import { CREDENTIAL_RENEWAL_MS, githubEgress } from './credential-renewal'
import { FakeBackend, FakeSandbox } from './fake-sandbox'
import { codexHarness } from './harness-codex'
import { heldFor, Run } from './run'
import { StageFailure } from './run-support'
import { Preparation } from './sandbox-prepared'
import type { EgressRule } from './sandbox'

vi.mock('./stages', async (original) => ({
  ...(await original<typeof import('./stages')>()),
  enterRunStage: async () => {},
}))

const NOW = 1_800_000_000_000
const jwt = (claims: object) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
const access = (hours: number) => jwt({ exp: NOW / 1000 + hours * 3600, n: hours })
const INSTALLED = access(66)

const line = (event: object) => JSON.stringify(event)
const REFUSED = line({
  type: 'turn.failed',
  error: { message: 'HTTP 401 "code": "token_expired"' },
})
const DONE = [
  line({ type: 'item.completed', item: { type: 'agent_message', text: 'APPROVE' } }),
  line({ type: 'turn.completed' }),
].join('\n')

let home: string
const saved = process.env.FACTORY_CODEX_HOME
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'run-codex-'))
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: jwt({ email: 'a@b.c' }),
        access_token: INSTALLED,
        refresh_token: 'refresh-real',
        account_id: 'acct',
      },
    }),
    { mode: 0o600 },
  )
  process.env.FACTORY_CODEX_HOME = home
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (saved === undefined) delete process.env.FACTORY_CODEX_HOME
  else process.env.FACTORY_CODEX_HOME = saved
})

const refreshing = (token: string | undefined) =>
  (async () =>
    token
      ? new Response(
          JSON.stringify({ access_token: token, refresh_token: 'rotated', expires_in: 864_000 }),
        )
      : new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch

/** A Run with only what `settle` touches, so the real settle runs against a real Codex harness. */
function reviewerRun(answers: string[], fetchLike: typeof fetch) {
  const sandbox = new FakeSandbox((command) =>
    command.includes(' exec ') ? { stdout: answers.shift() ?? DONE } : {},
  )
  const rules: EgressRule[] = [
    githubEgress('github-1'),
    { domain: 'chatgpt.com', headers: { authorization: `Bearer ${INSTALLED}` } },
  ]
  const updates: EgressRule[][] = []
  const rows: unknown[] = []
  const chain: Record<string, unknown> = {
    values: async (row: unknown) => void rows.push(row),
    set: () => chain,
    where: async () => undefined,
  }
  const state = { current: 'review' }
  const run = Object.create(Run.prototype) as Record<string, unknown>
  const c = {
    deps: {
      db: { insert: () => chain, update: () => chain },
      github: { installationToken: async () => ({ token: 'github-2' }) },
    },
    row: { repository: 'o/r' },
    taskId: 1,
    state,
    token: 'github-1',
  }
  run.c = c
  run.cost = 0
  run.spec = { egress: rules }
  // The run's own wrapper, so a renewal of the GitHub token and a Codex one share the firewall as they do live.
  run.sandbox = (
    Run as unknown as {
      withCredentials: (c: unknown, s: unknown, e: EgressRule[]) => unknown
    }
  ).withCredentials(
    c,
    {
      backend: sandbox.backend,
      stop: async () => {},
      updateEgress: async (next: EgressRule[]) => void updates.push([...next]),
    },
    rules,
  )
  run.transcript = { sink: () => () => {}, drain: async () => {}, flush: async () => {} }
  const reviewer = codexHarness(
    { kind: 'subscription', home },
    { fetch: fetchLike, now: () => NOW },
  )
  const settle = () =>
    (
      run as unknown as {
        settle: (...a: unknown[]) => Promise<{ ok: boolean; summary: string }>
      }
    ).settle(reviewer, 'reviewer', 1, (onEvent: unknown) =>
      reviewer.run(sandbox.backend, {
        prompt: 'P',
        cwd: '/work/repo',
        timeoutMs: 5,
        onEvent,
      } as never),
    )
  return { settle, rules, c, updates, rows, state, sandbox }
}

const panel = async () =>
  (await (GET.handler as (c: unknown) => Promise<unknown>)({})) as {
    account: { connected: boolean; problem?: string }
  }

describe('a reviewer pass the provider refused with a 401', () => {
  it('renews the login, gives the firewall the new token, runs again and stays in its stage', async () => {
    const renewed = access(240)
    const { settle, rules, updates, state, sandbox } = reviewerRun([REFUSED], refreshing(renewed))

    const result = await settle()

    expect(result).toMatchObject({ ok: true, summary: 'APPROVE' })
    expect(rules[1]!.headers!.authorization).toBe(`Bearer ${renewed}`)
    expect(updates).toHaveLength(1)
    expect(sandbox.backend.commands.filter((c) => c.includes(' exec '))).toHaveLength(2)
    expect(state.current).toBe('review')
    expect((await panel()).account.connected).toBe(true)
  })

  it('ends as an environment failure that retries, naming the Codex login, when the renewal fails', async () => {
    const { settle } = reviewerRun([REFUSED], refreshing(undefined))

    const error = await settle().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StageFailure)
    expect((error as Error).message).toMatch(/Codex login was refused and could not be renewed/)
    expect(retryableFailure({ error: (error as Error).message })).toBe('environment')
  })

  it('says the login was refused in the panel after a refused pass whose renewal fails', async () => {
    const { settle } = reviewerRun([REFUSED], refreshing(undefined))
    await settle().catch(() => {})
    const { account } = await panel()
    expect(account.connected).toBe(false)
    expect(account.problem).toMatch(/refused/)
  })

  it('marks the renewed token refused when the second pass is refused too, without renewing again', async () => {
    const { settle, sandbox } = reviewerRun([REFUSED, REFUSED], refreshing(access(240)))

    const error = await settle().catch((e: unknown) => e)

    expect((error as Error).message).toMatch(/refused again/)
    expect(retryableFailure({ error: (error as Error).message })).toBe('environment')
    expect(sandbox.backend.commands.filter((c) => c.includes(' exec '))).toHaveLength(2)
    const { account } = await panel()
    expect(account.connected).toBe(false)
    expect(account.problem).toMatch(/refused/)
  })

  it('keeps the renewed GitHub token when the Codex token is replaced later', async () => {
    vi.useFakeTimers()
    try {
      const renewed = access(240)
      const { settle, updates, c } = reviewerRun([REFUSED], refreshing(renewed))
      await vi.advanceTimersByTimeAsync(CREDENTIAL_RENEWAL_MS)
      expect(c.token).toBe('github-2')

      await settle()

      const last = updates.at(-1)!
      expect(last).toEqual([
        githubEgress('github-2'),
        { domain: 'chatgpt.com', headers: { authorization: `Bearer ${renewed}` } },
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('approved work the factory holds for its owner', () => {
  it('names the evaluation for agent configuration and the reading for a quality gate', () => {
    const held = heldFor(['src/server/factory/review.ts'], ['quality/crap-baseline.json'])
    expect(held?.cause).toBe('agent_configuration')
    expect(held?.reason).toContain(
      '`pnpm evals:check` against the recorded baseline for the agent configuration (src/server/factory/review.ts)',
    )
    expect(held?.reason).toContain(
      'read the change to the quality gates (quality/crap-baseline.json)',
    )
  })

  it('asks for no evaluation when only a gate changed', () => {
    const held = heldFor([], ['stryker.config.json'])
    expect(held?.reason).not.toContain('evals:check')
    expect(held?.reason).toContain('stryker.config.json')
  })

  it('holds nothing when neither changed', () => {
    expect(heldFor([], [])).toBeUndefined()
  })
})

describe('the install before the builder', () => {
  class Stop extends Error {}
  const PLAN = JSON.stringify({
    files: [{ path: 'a.ts', why: 'x' }],
    order: [],
    risks: [],
    proof: [],
    outOfScope: [],
  })

  /**
   * A Run with the real `start`, `planChange`, `firstPass` and `buildInput`; only the database, the transcript
   * and the stop after the first pass are faked. The builder records what it was told and how many installs had run.
   */
  function starting(
    checks: { name: string; command: string }[],
    install: { exitCode?: number },
    opts: { planFirst?: boolean; resuming?: object; dirtyAfterInstall?: boolean } = {},
  ) {
    const head = { sha: '' }
    const backend: FakeBackend = new FakeBackend((command) => {
      if (command.endsWith('rev-parse HEAD')) return { stdout: head.sha }
      if (command.endsWith('status --porcelain')) {
        const installed = backend.commands.some((c) => c.endsWith('&& pnpm install'))
        const restored = backend.commands.some((c) => c.includes('restore --staged'))
        return {
          stdout: opts.dirtyAfterInstall && installed && !restored ? ' M pnpm-lock.yaml\n' : '',
        }
      }
      return command.endsWith('&& pnpm install')
        ? { ...install, stderr: 'tarball missing' }
        : undefined
    })
    const calls: { how: string; installs: number; restoresBefore: number; prompt: string }[] = []
    const installs = () => backend.commands.filter((c) => c.endsWith('&& pnpm install')).length
    const restores = () => backend.commands.filter((c) => c.includes('restore --staged')).length
    const answer = (how: string, prompt: string) => {
      calls.push({ how, installs: installs(), restoresBefore: restores(), prompt })
      return Promise.resolve({ ok: true, summary: `${PLAN}`, sessionId: 's1' })
    }
    const builder = {
      name: 'fake-builder',
      run: (_b: unknown, o: { prompt: string }) => answer('run', o.prompt),
      resume: (_b: unknown, _s: string, o: { prompt: string }) => answer('resume', o.prompt),
    }
    const chain = { values: async () => {}, set: () => ({ where: async () => {} }) }
    const db = {
      insert: () => chain,
      update: () => chain,
      transaction: async () => {},
    }
    const run = Object.create(Run.prototype) as Record<string, unknown>
    run.c = {
      taskId: 1,
      deps: { checks, sandbox: {}, db, planFirst: opts.planFirst },
      repo: {},
      row: { repository: 'o/r', issueNumber: 7 },
      issue: { title: 'T', body: 'B' },
      branch: 'factory/7',
      state: { current: 'start' },
      resuming: opts.resuming,
    }
    run.builder = builder
    run.sandbox = { backend }
    run.repoDir = '/work/repo'
    run.baseSha = 'a'.repeat(40)
    run.startedAt = Date.now()
    run.sessionStartedAt = Date.now()
    run.cost = 0
    run.transcript = { sink: () => () => {}, drain: async () => {}, flush: async () => {} }
    run.storedPlan = async () => undefined
    run.failUnfinished = async () => {
      throw new Stop()
    }
    run.keepLearned = async () => {
      throw new Stop()
    }
    const start = () => (run as unknown as { start: () => Promise<unknown> }).start()
    return { start, backend, calls, run, head }
  }

  const checks = [
    { name: 'install', command: 'pnpm install' },
    { name: 'test', command: 'pnpm test' },
  ]

  it('runs the install in the checkout once, before the builder is called, and not again for the session', async () => {
    const { start, backend, calls } = starting(checks, {})
    await expect(start()).rejects.toBeInstanceOf(Stop)
    expect(backend.commands.filter((c) => c.includes('pnpm install'))).toEqual([
      'cd /work/repo && pnpm install',
    ])
    expect(calls.map((c) => [c.how, c.installs])).toEqual([
      ['run', 1],
      ['resume', 1],
    ])
    expect(calls[0]!.prompt).not.toContain('before your pass to install')
    // The factory's own clean is the checks' business, never the preparation's.
    expect(backend.commands.some((c) => c.includes('git clean'))).toBe(false)
  })

  it('tells the builder a failed install, in the prompt it is called with, and goes on', async () => {
    const { start, calls } = starting(checks, { exitCode: 1 })
    await expect(start()).rejects.toBeInstanceOf(Stop)
    expect(calls.map((c) => c.how)).toEqual(['run', 'resume'])
    expect(calls[0]!.prompt).toContain('before your pass to install')
    expect(calls[0]!.prompt).toContain('tarball missing')
  })

  it('gives the failure to a builder that is not planned first', async () => {
    const { start, calls } = starting(checks, { exitCode: 1 }, { planFirst: false })
    await expect(start()).rejects.toBeInstanceOf(Stop)
    expect(calls.map((c) => c.how)).toEqual(['run'])
    expect(calls[0]!.prompt).toContain('tarball missing')
  })

  it('does not install again a session resumed from a snapshot, whose checkout may hold uncommitted work', async () => {
    const resuming = { sessionId: 's0', attempt: 2, body: 'q', answer: 'a', answeredBy: 'x' }
    const { start, backend, calls } = starting(checks, { exitCode: 1 }, { resuming })
    await expect(start()).rejects.toBeInstanceOf(Stop)
    expect(calls.map((c) => [c.how, c.installs])).toEqual([['resume', 0]])
    expect(calls[0]!.prompt).not.toContain('before your pass to install')
    expect(backend.commands.some((c) => c.includes('restore') || c.includes('clean'))).toBe(false)
  })

  it('puts back what the install changed in the checkout before the builder is called', async () => {
    const { start, backend, calls } = starting(checks, {}, { dirtyAfterInstall: true })
    await expect(start()).rejects.toBeInstanceOf(Stop)
    const at = (needle: string) => backend.commands.findIndex((c) => c.includes(needle))
    expect(at('git -C /work/repo restore --staged --worktree :/')).toBeGreaterThan(
      at('pnpm install'),
    )
    expect(backend.commands).toContain('git -C /work/repo clean -fdq')
    // What git ignores, the dependencies, stays: never `clean -x` here.
    expect(backend.commands.some((c) => c.includes('clean -fdxq'))).toBe(false)
    expect(calls[0]!.restoresBefore).toBe(1)
  })

  it('lets the checks clean and install on their own after the preparatory install', async () => {
    const SHA = 'a'.repeat(40)
    const { start, backend, run, head } = starting(checks, {})
    await expect(start()).rejects.toBeInstanceOf(Stop)
    const r = run as Record<string, unknown>
    r.checkRuns = async () => []
    ;(r.c as { api: unknown }).api = { createCheckRun: async () => {} }
    ;(r.c as { token: string }).token = 't'
    const sentinel = backend.commands.length
    head.sha = SHA
    await (r as unknown as { verify: (sha: string, attempt: number) => Promise<unknown> }).verify(
      SHA,
      1,
    )
    const after = backend.commands.slice(sentinel)
    const clean = after.findIndex((c) => c.includes('git -C /work/repo clean -fdxq'))
    const install = after.findIndex((c) => c.endsWith('&& pnpm install'))
    expect(clean).toBeGreaterThanOrEqual(0)
    expect(install).toBeGreaterThan(clean)
  })

  it('times the install as the last step of the preparation and logs it before the builder runs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { start, run, calls } = starting(checks, {})
    let at = 0
    run.preparation = new Preparation(1, () => (at += 100))
    const loggedBeforeBuilder: boolean[] = []
    const builder = run.builder as { run: (b: unknown, o: { prompt: string }) => Promise<unknown> }
    const inner = builder.run
    builder.run = (b, o) => {
      loggedBeforeBuilder.push(
        log.mock.calls.some(([line]) => String(line).includes('sandbox_prepared')),
      )
      return inner(b, o)
    }
    await expect(start()).rejects.toBeInstanceOf(Stop)
    const lines = log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('sandbox_prepared'))
      .map((line) => JSON.parse(line))
    log.mockRestore()
    expect(lines).toEqual([expect.objectContaining({ taskId: 1, steps: { install: 100 } })])
    expect(loggedBeforeBuilder).toEqual([true])
    expect(calls.length).toBeGreaterThan(0)
  })

  it('runs nothing extra for a repository with no install check', async () => {
    const { start, backend, calls } = starting([{ name: 'test', command: 'pnpm test' }], {})
    await expect(start()).rejects.toBeInstanceOf(Stop)
    expect(backend.commands.some((c) => c.includes('install'))).toBe(false)
    expect(calls.length).toBeGreaterThan(0)
  })
})
