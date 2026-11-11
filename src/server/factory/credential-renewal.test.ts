import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CREDENTIAL_RENEWAL_MS, githubEgress, renewGithubCredential } from './credential-renewal'
import type { EgressRule, IsolatedSandbox } from './sandbox'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const basic = (token: string) =>
  `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`

function sandbox() {
  const updates: EgressRule[][] = []
  const stopped = { count: 0 }
  const box: IsolatedSandbox = {
    backend: {} as IsolatedSandbox['backend'],
    stop: async () => {
      stopped.count += 1
    },
    updateEgress: async (egress) => {
      updates.push(egress)
    },
  }
  return { box, updates, stopped }
}

const egress: EgressRule[] = [githubEgress('first'), { domain: 'registry.npmjs.org' }]

describe('renewing the GitHub credential of a running sandbox', () => {
  it('attaches a new token to github.com, keeps the other rules, and hands the token to the run', async () => {
    const { box, updates } = sandbox()
    const tokens: string[] = []
    const renewing = renewGithubCredential(box, egress, {
      mint: async () => 'second',
      onToken: (token) => tokens.push(token),
    })

    await vi.advanceTimersByTimeAsync(CREDENTIAL_RENEWAL_MS)

    expect(updates).toEqual([[githubEgress('second'), { domain: 'registry.npmjs.org' }]])
    expect(updates[0]![0]!.headers!.authorization).toBe(basic('second'))
    expect(tokens).toEqual(['second'])
    await renewing.stop()
  })

  it('renews again at each interval, for as long as the sandbox runs', async () => {
    const { box, updates } = sandbox()
    let n = 0
    const renewing = renewGithubCredential(box, egress, {
      mint: async () => `token-${++n}`,
      onToken: () => {},
    })

    await vi.advanceTimersByTimeAsync(3 * CREDENTIAL_RENEWAL_MS)

    expect(updates.map((u) => u[0]!.headers!.authorization)).toEqual([
      basic('token-1'),
      basic('token-2'),
      basic('token-3'),
    ])
    await renewing.stop()
  })

  it('stops renewing once the sandbox is stopped, and stops the sandbox', async () => {
    const { box, updates, stopped } = sandbox()
    const renewing = renewGithubCredential(box, egress, {
      mint: async () => 'x',
      onToken: () => {},
    })

    await renewing.stop()
    await vi.advanceTimersByTimeAsync(2 * CREDENTIAL_RENEWAL_MS)

    expect(stopped.count).toBe(1)
    expect(updates).toEqual([])
  })

  it('keeps the token it has and says so when a renewal fails, and tries again at the next interval', async () => {
    const { box, updates } = sandbox()
    const tokens: string[] = []
    const failures: unknown[] = []
    let calls = 0
    const renewing = renewGithubCredential(box, egress, {
      mint: async () => {
        calls += 1
        if (calls === 1) throw new Error('GitHub answered 502')
        return 'after-failure'
      },
      onToken: (token) => tokens.push(token),
      onFailure: (error) => failures.push(error),
    })

    await vi.advanceTimersByTimeAsync(CREDENTIAL_RENEWAL_MS)
    expect(String(failures[0])).toMatch(/GitHub answered 502/)
    expect(tokens).toEqual([])

    await vi.advanceTimersByTimeAsync(CREDENTIAL_RENEWAL_MS)
    expect(tokens).toEqual(['after-failure'])
    expect(updates).toHaveLength(1)
    await renewing.stop()
  })

  it('does not hand the run a token the firewall did not take', async () => {
    const { box } = sandbox()
    box.updateEgress = async () => {
      throw new Error('proxy gone')
    }
    const tokens: string[] = []
    const renewing = renewGithubCredential(box, egress, {
      mint: async () => 'new',
      onToken: (token) => tokens.push(token),
      onFailure: () => {},
    })

    await vi.advanceTimersByTimeAsync(CREDENTIAL_RENEWAL_MS)

    expect(tokens).toEqual([])
    await renewing.stop()
  })

  it('refuses a sandbox that cannot renew its credentials, since its run would outlive them', () => {
    const { box } = sandbox()
    delete box.updateEgress

    expect(() =>
      renewGithubCredential(box, egress, { mint: async () => 'x', onToken: () => {} }),
    ).toThrow(/cannot renew the credentials of a running sandbox/)
  })
})
