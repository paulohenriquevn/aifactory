import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import { refusal, workDeps } from '../../panel/deps'
import { ownerOnly } from '../../panel/policy'
import { createPlan, listPlans } from '../../panel/work'

export const GET = route()
  .policy(ownerOnly)
  .handler(async () => ({ plans: await listPlans(getDb()) }))
  .build()

export const POST = route()
  .policy(ownerOnly)
  .body(z.object({ repository: z.string().max(200), goal: z.string().max(5_000) }))
  .handler(async ({ body }) => {
    try {
      return await createPlan(workDeps(), body)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
