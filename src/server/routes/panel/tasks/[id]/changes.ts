import { route } from 'theokit/server/define'
import { z } from 'zod'

import { requestChanges } from '../../../../panel/actions'
import { actionDeps, refusal } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'

export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .body(z.object({ note: z.string().min(1).max(4000) }))
  .handler(async ({ params, body }) => {
    try {
      return await requestChanges(actionDeps(), params.id, body.note)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
