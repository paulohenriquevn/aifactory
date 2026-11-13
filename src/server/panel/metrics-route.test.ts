import { evaluateRoutePolicy, type RoutePolicy } from 'theokit/server/define'
import { describe, expect, it } from 'vitest'

import { GET } from '../routes/panel/metrics'

// The route reads no query, body or params, so its policy is typed for none.
const policy = GET.policy as RoutePolicy<unknown, unknown, unknown>
const input = (subject: { id: string } | null) => ({ subject, query: {}, body: {}, params: {} })

describe('GET /api/panel/metrics', () => {
  it('refuses a caller without the owner session', async () => {
    expect(await evaluateRoutePolicy(policy, input(null))).toEqual({
      allowed: false,
      reason: 'sign in to the panel',
    })
    expect(await evaluateRoutePolicy(policy, input({ id: 'someone' }))).toMatchObject({
      allowed: false,
    })
  })

  it('lets the owner in', async () => {
    expect(await evaluateRoutePolicy(policy, input({ id: 'owner' }))).toEqual({ allowed: true })
  })
})
