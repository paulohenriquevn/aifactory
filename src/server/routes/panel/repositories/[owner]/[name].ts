import { route } from 'theokit/server/define'
import { z } from 'zod'

import { refusal, workDeps } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'
import { repositoryPatchSchema } from '../../../../panel/repository-schema'
import { saveRepository } from '../../../../panel/work'

export const PUT = route()
  .policy(ownerOnly)
  .params(z.object({ owner: z.string().max(100), name: z.string().max(100) }))
  .body(repositoryPatchSchema)
  .handler(async ({ params, body }) => {
    try {
      return await saveRepository(workDeps(), `${params.owner}/${params.name}`, body)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
