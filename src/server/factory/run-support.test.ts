import type { SandboxBackend } from '@theokit/agents/sandbox'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { retryableFailure } from '../../shared/panel'

import type { CodingHarness, HarnessResult } from './harness'
import { passRenewing, pushWithRetry, resolvedComment, runContinuation } from './run-support'

const failing = (times: number) => {
  let calls = 0
  const backend = {
    execute: async () => {
      calls += 1
      return calls <= times
        ? { exitCode: 1, stdout: '', stderr: 'remote: Internal Server Error' }
        : { exitCode: 0, stdout: 'ok', stderr: '' }
    },
  } as unknown as SandboxBackend
  return { backend, calls: () => calls }
}

afterEach(() => vi.restoreAllMocks())

describe('pushWithRetry', () => {
  it('waits twice as long after each failure, so a GitHub incident of a few minutes is outlasted', async () => {
    const delays: number[] = []
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      fn()
      return 0
    }) as unknown as typeof setTimeout)
    const { backend, calls } = failing(5)

    await pushWithRetry(backend, 'git push', 5_000)

    expect(calls()).toBe(6)
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000])
  })

  it('gives up after six tries with the last error', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn()
      return 0
    }) as unknown as typeof setTimeout)
    const { backend, calls } = failing(99)

    await expect(pushWithRetry(backend, 'git push', 1)).rejects.toThrow(/Internal Server Error/)
    expect(calls()).toBe(6)
  })

  it('does not wait when the first push works', async () => {
    const wait = vi.spyOn(globalThis, 'setTimeout')
    const { backend, calls } = failing(0)
    await pushWithRetry(backend, 'git push', 5_000)
    expect(calls()).toBe(1)
    expect(wait).not.toHaveBeenCalled()
  })
})

describe('resolvedComment', () => {
  const input = {
    sha: 'abc1234def',
    claim: 'truncate is in src/truncate.js',
    reviewer: 'claude-code',
    review: 'src/truncate.js does it, test/truncate.test.js covers it',
    rows: [{ name: 'tests', command: 'npm test', passed: true, durationMs: 1500, output: '' }],
  }

  it('says where the issue is resolved, what passed there and who confirmed it', () => {
    const text = resolvedComment(input)
    expect(text.split('\n')[0]).toBe(
      'The factory found this already resolved at abc1234def, so it changed nothing and is closing the issue.',
    )
    expect(text).toContain('Checks the factory ran on `abc1234`:\n\n- passed: `npm test` (1.5 s)')
    expect(text).toContain(
      'Independent review by claude-code: src/truncate.js does it, test/truncate.test.js covers it',
    )
    expect(text).toContain('truncate is in src/truncate.js')
    expect(text).toContain('reopen it and say what')
  })

  it('keeps a long answer of the agent short', () => {
    const text = resolvedComment({ ...input, claim: 'x'.repeat(5_000) })
    expect(text).toContain('x'.repeat(3_000))
    expect(text).not.toContain('x'.repeat(3_001))
  })
})

describe('runContinuation', () => {
  it('continues on the branch with the note of a request for changes', () => {
    expect(runContinuation({ kind: 'request_changes', note: 'rename it' }, undefined)).toEqual({
      feedback: 'rename it',
    })
  })

  it('continues on the branch with the feedback the factory queued, when no person decided', () => {
    expect(runContinuation(undefined, 'CI failed')).toEqual({
      feedback: 'CI failed',
      fromChecks: true,
    })
  })

  it('starts from the beginning for any other decision, or none', () => {
    expect(runContinuation({ kind: 'retry', note: '' }, undefined)).toBeUndefined()
    expect(runContinuation(undefined, undefined)).toBeUndefined()
  })
})

describe('passRenewing', () => {
  const refusedPass: HarnessResult = {
    ok: false,
    summary: 'codex failed: HTTP 401 token_expired',
    unauthorized: true,
  }
  const good: HarnessResult = { ok: true, summary: 'done' }
  const setup = (reauthorize: CodingHarness['reauthorize'], answers: HarnessResult[]) => {
    const who = {
      name: 'codex',
      egress: async () => [],
      run: vi.fn(),
      reauthorize,
    } as CodingHarness
    const updates: unknown[] = []
    const egress = [
      { domain: 'github.com', headers: { authorization: 'old' } },
      { domain: 'chatgpt.com', headers: { authorization: 'Bearer old' } },
    ]
    const pass = vi.fn(async () => answers.shift()!)
    const run = () =>
      passRenewing(who, pass, {
        backend: {} as SandboxBackend,
        egress,
        githubToken: () => 'gh',
        updateEgress: async (rules) => void updates.push(structuredClone(rules)),
      })
    return { run, pass, updates, egress }
  }

  it('renews once on a 401 and runs the pass again with the new credential', async () => {
    const t = setup(
      async () => [{ domain: 'chatgpt.com', headers: { authorization: 'Bearer new' } }],
      [refusedPass, good],
    )
    await expect(t.run()).resolves.toBe(good)
    expect(t.pass).toHaveBeenCalledTimes(2)
    expect(t.updates).toHaveLength(1)
    expect(t.egress.find((r) => r.domain === 'chatgpt.com')?.headers).toEqual({
      authorization: 'Bearer new',
    })
  })

  it('fails as an environment failure that names the login when the renewal fails', async () => {
    const t = setup(async () => {
      throw new Error('refresh token rejected')
    }, [refusedPass])
    const error = (await t.run().catch((e: Error) => e)) as Error
    expect(error.message).toMatch(/codex login was refused and could not be renewed/)
    expect(t.pass).toHaveBeenCalledTimes(1)
    expect(retryableFailure({ error: error.message })).toBe('environment')
  })

  it('does not renew twice when the second pass is refused too', async () => {
    const reauthorize = vi.fn(async () => [])
    const t = setup(reauthorize, [refusedPass, refusedPass])
    await expect(t.run()).rejects.toThrow(/was refused/)
    expect(reauthorize).toHaveBeenCalledTimes(1)
  })

  it('leaves a refusal alone when the agent cannot renew', async () => {
    const t = setup(undefined, [refusedPass])
    await expect(t.run()).resolves.toBe(refusedPass)
  })
})
