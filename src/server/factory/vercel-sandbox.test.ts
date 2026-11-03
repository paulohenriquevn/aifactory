import { describe, expect, it } from 'vitest'

import { networkPolicyFor } from './vercel-sandbox'

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
