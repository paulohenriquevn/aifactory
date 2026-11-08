import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import { knowledgeDeps } from '../../knowledge/deps'
import { KnowledgeRefused, knowledgeStatus, saveKnowledge } from '../../knowledge/sync'
import { ownerOnly } from '../../panel/policy'

const refused = (error: unknown) => {
  if (error instanceof KnowledgeRefused) {
    return Response.json({ error: 'refused', message: error.message }, { status: 409 })
  }
  throw error
}

/** The knowledge repository, where the mirror is, and what is waiting to be written. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => knowledgeStatus(getDb()))
  .build()

/** Chooses the knowledge repository (and the branch of its rules), or clears it with a null. */
export const PUT = route()
  .policy(ownerOnly)
  .body(
    z.object({
      repository: z.string().max(200).nullable(),
      branch: z.string().max(200).nullable().optional(),
    }),
  )
  .handler(async ({ body }) => {
    try {
      return await saveKnowledge(knowledgeDeps(), body)
    } catch (error) {
      return refused(error)
    }
  })
  .build()
