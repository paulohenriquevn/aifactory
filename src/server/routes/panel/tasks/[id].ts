import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../db'
import { ownerOnly } from '../../../panel/policy'
import { taskDetail } from '../../../panel/queries'

export const GET = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .handler(async ({ params }) => {
    const detail = await taskDetail(getDb(), params.id)
    return detail ?? Response.json({ error: 'not_found' }, { status: 404 })
  })
  .build()
