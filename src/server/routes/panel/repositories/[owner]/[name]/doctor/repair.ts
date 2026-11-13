import { route } from 'theokit/server/define'
import { z } from 'zod'

import { DOCTOR_ITEMS } from '../../../../../../factory/doctor'
import { doctorDeps, refusal } from '../../../../../../panel/deps'
import { repairRepository } from '../../../../../../panel/doctor'
import { ownerOnly } from '../../../../../../panel/policy'

/** Makes the repair of one item, when it is one the factory can make, and answers with the new report. */
export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ owner: z.string().max(100), name: z.string().max(100) }))
  .body(z.object({ item: z.enum(DOCTOR_ITEMS) }))
  .handler(async ({ params, body }) => {
    try {
      return await repairRepository(doctorDeps(), `${params.owner}/${params.name}`, body.item)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
