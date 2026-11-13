import { route } from 'theokit/server/define'
import { z } from 'zod'

import { doctorDeps, refusal } from '../../../../../panel/deps'
import { repositoryDoctor } from '../../../../../panel/doctor'
import { ownerOnly } from '../../../../../panel/policy'

/** Examines the repository now: what blocks it, why, the repair and where it is made. The report is kept. */
export const GET = route()
  .policy(ownerOnly)
  .params(z.object({ owner: z.string().max(100), name: z.string().max(100) }))
  .handler(async ({ params }) => {
    try {
      return await repositoryDoctor(doctorDeps(), `${params.owner}/${params.name}`)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
