import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../../db'
import { refusal } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'
import { savePlanItems } from '../../../../panel/work'

export const PUT = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .body(
    z.object({
      items: z
        .array(
          z.object({
            id: z.number().int().positive().optional(),
            title: z.string().max(300),
            body: z.string().max(12_000),
            selected: z.boolean(),
          }),
        )
        .max(30),
    }),
  )
  .handler(async ({ params, body }) => {
    try {
      await savePlanItems(getDb(), params.id, body.items)
      return { ok: true }
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
