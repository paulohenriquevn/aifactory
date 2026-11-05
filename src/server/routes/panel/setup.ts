import { route } from 'theokit/server/define'

import { ownerOnly } from '../../panel/policy'
import { readSetup } from '../../panel/setup-live'

export const GET = route()
  .policy(ownerOnly)
  .handler(async () => readSetup())
  .build()
