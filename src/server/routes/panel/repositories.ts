import { route } from 'theokit/server/define'

import { ownerOnly } from '../../panel/policy'
import { workDeps } from '../../panel/deps'
import { listRepositories } from '../../panel/work'

export const GET = route()
  .policy(ownerOnly)
  .handler(async () => listRepositories(workDeps()))
  .build()
