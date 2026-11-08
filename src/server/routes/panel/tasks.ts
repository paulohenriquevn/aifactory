import { route } from 'theokit/server/define'

import { getDb } from '../../db'
import { ownerOnly } from '../../panel/policy'
import { listTasks } from '../../panel/queries'

export const GET = route()
  .policy(ownerOnly)
  .handler(async () => ({ tasks: await listTasks(getDb()) }))
  .build()
