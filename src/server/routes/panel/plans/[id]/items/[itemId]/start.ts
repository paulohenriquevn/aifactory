import { route } from 'theokit/server/define'
import { z } from 'zod'

import { refusal, workDeps } from '../../../../../../panel/deps'
import { ownerOnly } from '../../../../../../panel/policy'
import { startPlanItem } from '../../../../../../panel/work'

export const POST = route()
  .policy(ownerOnly)
  .params(
    z.object({
      id: z.coerce.number().int().positive(),
      itemId: z.coerce.number().int().positive(),
    }),
  )
  .handler(async ({ params }) => {
    try {
      await startPlanItem(workDeps(), params.id, params.itemId)
      return { ok: true }
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
