import { route } from 'theokit/server/define'

import { getDb } from '../../db'
import { ownerOnly } from '../../panel/policy'
import { stageStream } from '../../panel/stream'

export const GET = route()
  .policy(ownerOnly)
  .handler(({ request }) => stageStream(getDb(), request.signal))
  .build()
