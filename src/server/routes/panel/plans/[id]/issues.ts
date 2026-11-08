import { route } from 'theokit/server/define'
import { z } from 'zod'

import { refusal, workDeps } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'
import { createPlanIssues } from '../../../../panel/work'

export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .body(z.object({ start: z.boolean() }))
  .handler(async ({ params, body }) => {
    try {
      return await createPlanIssues(workDeps(), params.id, body)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
