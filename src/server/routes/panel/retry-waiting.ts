import { route } from 'theokit/server/define'

import { actionDeps } from '../../panel/deps'
import { ownerOnly } from '../../panel/policy'
import { retryWaiting } from '../../panel/retry-waiting'

/** Starts again the tasks that were waiting for something that has passed, such as an agent's usage limit. */
export const POST = route()
  .policy(ownerOnly)
  .handler(async () => retryWaiting(actionDeps()))
  .build()
