import { defineJob } from 'theokit/server/jobs'
import { z } from 'zod'

import { runPlan } from '../factory/plan'
import { getDb } from '../db'
import { planDeps } from '../factory/plan-deps'
import { effectiveEnv } from '../factory/settings'
import { withLeaseHeartbeat } from '../factory/lease'

export default defineJob('plan-run', {
  input: z.object({ planId: z.number().int().positive() }),
  // A plan that fails says so on the plan. Running it again would spend the agent's budget on the
  // same goal, so the owner asks again from the panel instead.
  maxAttempts: 1,
  async handler({ input, extendLease }) {
    await withLeaseHeartbeat(extendLease, async () => {
      await runPlan(planDeps(await effectiveEnv(getDb())), input.planId)
      console.log(JSON.stringify({ event: 'plan_finished', planId: input.planId }))
    })
  },
})
