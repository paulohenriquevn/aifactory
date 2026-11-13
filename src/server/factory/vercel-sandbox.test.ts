import { Sandbox } from '@vercel/sandbox'
import { describe, expect, it, vi } from 'vitest'

import { networkPolicyFor, vercelCredentials, vercelSandboxProvider } from './vercel-sandbox'

describe('networkPolicyFor', () => {
  it('lists exactly the destinations of the spec, with credentials only where given', () => {
    const policy = networkPolicyFor({
      timeoutMs: 1,
      egress: [
        { domain: 'github.com', headers: { authorization: 'Basic abc' } },
        { domain: 'registry.npmjs.org' },
      ],
    })

    expect(policy).toEqual({
      allow: {
        'github.com': [{ transform: [{ headers: { authorization: 'Basic abc' } }] }],
        'registry.npmjs.org': [],
      },
    })
  })

  it('never adds a catch-all', () => {
    const policy = networkPolicyFor({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })
    expect(Object.keys((policy as { allow: object }).allow)).not.toContain('*')
  })
})

describe('vercelCredentials', () => {
  it('uses the access token only when team and project come with it', () => {
    expect(
      vercelCredentials({ VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 'team', VERCEL_PROJECT_ID: 'prj' }),
    ).toEqual({ token: 't', teamId: 'team', projectId: 'prj' })
    expect(vercelCredentials({ VERCEL_TOKEN: 't' })).toBeUndefined()
    expect(vercelCredentials({ VERCEL_OIDC_TOKEN: 'oidc' })).toBeUndefined()
  })
})

describe('vercelSandboxProvider', () => {
  it('creates a sandbox that does not snapshot its disk when it stops', async () => {
    const create = vi
      .spyOn(Sandbox, 'create')
      .mockResolvedValue({ stop: async () => {} } as unknown as Awaited<
        ReturnType<typeof Sandbox.create>
      >)

    await vercelSandboxProvider().create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ persistent: false }))
    create.mockRestore()
  })

  it('renews the credentials of a running sandbox through its network policy', async () => {
    const updateNetworkPolicy = vi.fn(async () => ({}))
    const create = vi
      .spyOn(Sandbox, 'create')
      .mockResolvedValue({ stop: async () => {}, updateNetworkPolicy } as unknown as Awaited<
        ReturnType<typeof Sandbox.create>
      >)
    const sandbox = await vercelSandboxProvider().create({
      timeoutMs: 1,
      egress: [{ domain: 'github.com', headers: { authorization: 'Basic FIRST' } }],
    })

    await sandbox.updateEgress!([
      { domain: 'github.com', headers: { authorization: 'Basic RENEWED' } },
    ])

    expect(updateNetworkPolicy).toHaveBeenCalledWith({
      allow: { 'github.com': [{ transform: [{ headers: { authorization: 'Basic RENEWED' } }] }] },
    })
    create.mockRestore()
  })

  it('refuses new egress rules that would leave a running sandbox without a policy', async () => {
    const updateNetworkPolicy = vi.fn(async () => ({}))
    const create = vi
      .spyOn(Sandbox, 'create')
      .mockResolvedValue({ stop: async () => {}, updateNetworkPolicy } as unknown as Awaited<
        ReturnType<typeof Sandbox.create>
      >)
    const sandbox = await vercelSandboxProvider().create({
      timeoutMs: 1,
      egress: [{ domain: 'github.com' }],
    })

    await expect(sandbox.updateEgress!([])).rejects.toThrow(/refusing to run without isolation/)
    expect(updateNetworkPolicy).not.toHaveBeenCalled()
    create.mockRestore()
  })
})
