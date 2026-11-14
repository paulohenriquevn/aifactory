import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { retryableFailure } from '../../shared/panel'
import { GET } from '../routes/panel/codex/login'

import { CREDENTIAL_RENEWAL_MS, githubEgress } from './credential-renewal'
import { FakeSandbox } from './fake-sandbox'
import { codexHarness } from './harness-codex'
import { Run } from './run'
import { StageFailure } from './run-support'
import type { EgressRule } from './sandbox'

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
