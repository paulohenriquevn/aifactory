import { route } from 'theokit/server/define'

import { knowledgeDeps } from '../../../knowledge/deps'
import { KnowledgeRefused, proposeTemplate } from '../../../knowledge/sync'
import { ownerOnly } from '../../../panel/policy'

/** Opens a pull request that puts the knowledge repository in the format the factory reads. */
export const POST = route()
  .policy(ownerOnly)
  .handler(async () => {
    try {
      return await proposeTemplate(knowledgeDeps())
    } catch (error) {
      if (error instanceof KnowledgeRefused) {
        return Response.json({ error: 'refused', message: error.message }, { status: 409 })
      }
      throw error
    }
  })
  .build()
