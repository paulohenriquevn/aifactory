import { route } from 'theokit/server/define'
import { z } from 'zod'

import { resolveFinding } from '../../../../panel/actions'
import { actionDeps, refusal } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'

export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .body(z.object({ action: z.enum(['retry', 'resume', 'delete_snapshot', 'mark_revert_unknown']) }))
  .handler(async ({ params, body }) => {
    try {
      return await resolveFinding(actionDeps(), params.id, body.action)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
