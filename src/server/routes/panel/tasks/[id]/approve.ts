import { route } from 'theokit/server/define'
import { z } from 'zod'

import { actionDeps, refusal } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'
import { approve } from '../../../../panel/actions'

export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .handler(async ({ params }) => {
    try {
      return await approve(actionDeps(), params.id)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
