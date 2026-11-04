import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../db'
import { ownerOnly } from '../../../panel/policy'
import { getPlan } from '../../../panel/work'

export const GET = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .handler(async ({ params }) => {
    const found = await getPlan(getDb(), params.id)
    return found ?? Response.json({ error: 'not_found' }, { status: 404 })
  })
  .build()
