import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../../../../db'
import { proofStartDeps, refusal } from '../../../../../../panel/deps'
import { ownerOnly } from '../../../../../../panel/policy'
import { readProof, startProof } from '../../../../../../panel/prove'
import { checksSchema } from '../../../../../../panel/repository-schema'

const params = z.object({ owner: z.string().max(100), name: z.string().max(100) })

/**
 * Starts the proof of proposed checks: they run in a sandbox on the head of the integration branch, and
 * only the ones that pass are saved. The answer is the proof while it runs; `GET` reads how it ended.
 */
export const POST = route()
  .policy(ownerOnly)
  .params(params)
  .body(z.object({ checks: checksSchema }))
  .handler(async ({ params, body, ctx }) => {
    try {
      return await startProof(
        proofStartDeps(ctx.queue),
        `${params.owner}/${params.name}`,
        body.checks,
      )
    } catch (error) {
      return refusal(error)
    }
  })
  .build()

/** The last proof of the repository: running, done with a result for each check, or failed with the reason. */
export const GET = route()
  .policy(ownerOnly)
  .params(params)
  .handler(async ({ params }) => {
    try {
      return { proof: await readProof(getDb(), `${params.owner}/${params.name}`, new Date()) }
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
