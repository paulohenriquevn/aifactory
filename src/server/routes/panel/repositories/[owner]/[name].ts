import { route } from 'theokit/server/define'
import { z } from 'zod'

import { refusal, workDeps } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'
import { saveRepository } from '../../../../panel/work'

const check = z.object({ name: z.string().max(40), command: z.string().max(600) })

export const PUT = route()
  .policy(ownerOnly)
  .params(z.object({ owner: z.string().max(100), name: z.string().max(100) }))
  .body(
    z.object({
      enabled: z.boolean().optional(),
      checks: z.array(check).max(20).nullable().optional(),
      egress: z.array(z.string().max(253)).max(50).optional(),
      baseBranch: z.string().max(100).nullable().optional(),
      releaseBranch: z.string().max(100).nullable().optional(),
      askQuestions: z.boolean().optional(),
      harness: z.string().max(40).nullable().optional(),
      reviewer: z.string().max(40).nullable().optional(),
      releaseMode: z.enum(['manual', 'trial', 'auto']).nullable().optional(),
    }),
  )
  .handler(async ({ params, body }) => {
    try {
      return await saveRepository(workDeps(), `${params.owner}/${params.name}`, body)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
