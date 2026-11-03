import { route } from 'theokit/server/define'

import { getPool } from '../db'
import { checkDatabase } from '../db/health'

export const GET = route()
  // Readiness carries no data beyond up/down and a latency, so it is open like liveness.
  .policy('public')
  .handler(async () => {
    // The pool is resolved inside the probe, so a missing or unknown database is reported as
    // `down` with its reason (503) instead of throwing out of the handler.
    const database = await checkDatabase({ query: (sql) => getPool().query(sql) })
    const ready = database.status === 'up'
    if (database.status === 'down') {
      console.error(JSON.stringify({ event: 'readiness_failed', database }))
    }
    return Response.json(
      { status: ready ? 'ready' : 'not_ready', database },
      { status: ready ? 200 : 503 },
    )
  })
  .build()
