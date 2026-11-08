import { route } from 'theokit/server/define'
import { z } from 'zod'

import { refusal, workDeps } from '../../panel/deps'
import { ownerOnly } from '../../panel/policy'
import { createJob } from '../../panel/work'

export const POST = route()
  .policy(ownerOnly)
  .body(
    z.object({
      repository: z.string().max(200),
      title: z.string().max(300),
      body: z.string().max(12_000),
      start: z.boolean(),
      harness: z.string().max(40).optional(),
      reviewer: z.string().max(40).optional(),
    }),
  )
  .handler(async ({ body }) => {
    try {
      return await createJob(workDeps(), body)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
