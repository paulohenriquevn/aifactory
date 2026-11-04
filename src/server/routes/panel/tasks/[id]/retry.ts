import { route } from 'theokit/server/define'
import { z } from 'zod'

import { retry } from '../../../../panel/actions'
import { actionDeps, refusal } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'

export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .handler(async ({ params }) => {
    try {
      return await retry(actionDeps(), params.id)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
