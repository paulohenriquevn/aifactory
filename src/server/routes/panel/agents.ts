import { route } from 'theokit/server/define'

import { agentCatalog } from '../../factory/agent-catalog'
import { ownerOnly } from '../../panel/policy'

/** Every agent of the factory with its prompts and what it may do, read from the code that runs them. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => agentCatalog())
  .build()
