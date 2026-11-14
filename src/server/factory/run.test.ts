import { describe, expect, it, vi } from 'vitest'

import type { CodingHarness, HarnessResult } from './harness'
import { Run } from './run'
import { StageFailure } from './run-support'
import type { EgressRule } from './sandbox'

const refused: HarnessResult = { ok: false, summary: 'codex failed: HTTP 401', unauthorized: true }
const good: HarnessResult = { ok: true, summary: 'APPROVE' }

function setup(reauthorize: CodingHarness['reauthorize'], results: HarnessResult[]) {
  const rules: EgressRule[] = [
    { domain: 'github.com' },
    { domain: 'chatgpt.com', headers: { authorization: 'Bearer old' } },
  ]
  const updates: EgressRule[][] = []
  const run = Object.create(Run.prototype) as Record<string, unknown>
  run.spec = { egress: rules }
  run.sandbox = {
    backend: {},
    updateEgress: async (next: EgressRule[]) => void updates.push([...next]),
  }
  run.transcript = { sink: () => () => {} }
  const who = { name: 'codex', reauthorize } as unknown as CodingHarness
  const call = vi.fn(async () => results.shift()!)
  const afterRefusal = (
    run as unknown as {
      afterRefusal: (
        w: CodingHarness,
        r: string,
        a: number,
        c: typeof call,
      ) => Promise<HarnessResult>
    }
  ).afterRefusal.bind(run)
  return { rules, updates, who, call, afterRefusal }
}

describe('a Codex pass the provider refused (401)', () => {
  it('renews the login once, gives the firewall the new token and runs the pass again', async () => {
    const renewed: EgressRule[] = [
      { domain: 'chatgpt.com', headers: { authorization: 'Bearer new' } },
    ]
    const reauthorize = vi.fn(async () => renewed)
    const { rules, updates, who, call, afterRefusal } = setup(reauthorize, [good])

    await expect(afterRefusal(who, 'reviewer', 1, call)).resolves.toEqual(good)

    expect(reauthorize).toHaveBeenCalledWith(expect.anything(), 'old')
    expect(rules[1]!.headers!.authorization).toBe('Bearer new')
    expect(updates).toHaveLength(1)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('fails as an environment failure that names the Codex login when the renewal fails', async () => {
    const { who, call, afterRefusal } = setup(async () => {
      throw new Error('invalid_grant')
    }, [])
    const error = await afterRefusal(who, 'reviewer', 1, call).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StageFailure)
    expect((error as Error).message).toMatch(/Codex login was refused and could not be renewed/)
    expect(call).not.toHaveBeenCalled()
    const { retryableFailure } = await import('../../shared/panel')
    expect(retryableFailure({ error: (error as Error).message })).toBe('environment')
  })

  it('fails the same way when the renewed login is refused too', async () => {
    const { who, call, afterRefusal } = setup(async () => [], [refused])
    await expect(afterRefusal(who, 'reviewer', 1, call)).rejects.toThrow(/refused again/)
  })
})
