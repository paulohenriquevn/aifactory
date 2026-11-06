import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../db'
import { changeAgentSettings } from '../../../panel/agent-settings'
import { refusal } from '../../../panel/deps'
import { ownerOnly } from '../../../panel/policy'

const agent = z.string().max(40).nullable().optional()
const perRole = z.object({ builder: agent, planner: agent, reviewer: agent }).optional()

/** Which coding agent builds, plans and reviews. A null goes back to the default. */
export const PUT = route()
  .policy(ownerOnly)
  .body(
    z.object({
      builder: agent,
      planner: agent,
      reviewer: agent,
      models: perRole,
      efforts: perRole,
    }),
  )
  .handler(async ({ body }) => {
    try {
      return await changeAgentSettings(getDb(), body)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
