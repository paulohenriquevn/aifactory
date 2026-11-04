import { describe, expect, it } from 'vitest'

import { networkPolicyFor, vercelCredentials } from './vercel-sandbox'

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
