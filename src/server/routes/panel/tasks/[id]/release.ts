import { route } from 'theokit/server/define'
import { z } from 'zod'

import { releaseTask } from '../../../../panel/actions'
import { actionDeps, refusal } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'

export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .body(z.object({ bump: z.enum(['patch', 'minor', 'major']).default('patch') }))
  .handler(async ({ params, body }) => {
    try {
      return await releaseTask(actionDeps(), params.id, body.bump)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
