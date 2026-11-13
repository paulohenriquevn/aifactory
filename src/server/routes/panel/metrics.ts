import { route } from 'theokit/server/define'

import { getDb } from '../../db'
import { metricsReport } from '../../panel/metrics'
import { ownerOnly } from '../../panel/policy'

export const GET = route()
  .policy(ownerOnly)
  .handler(async () => metricsReport(getDb()))
  .build()
