import { route } from 'theokit/server/define'

import { getDb } from '../../db'
import { agentsView } from '../../factory/agent-view'
import { ownerOnly } from '../../panel/policy'

/** Every agent of the factory with its prompts and what it may do, read from the code that runs them. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => agentsView(getDb()))
  .build()
