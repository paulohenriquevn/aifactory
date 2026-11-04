import { PostgresJobBackend } from 'theokit/server/jobs'
import { getStorageManager } from 'theokit/server/storage'

import { createPool } from '../db'
import { DATABASE_NAME } from '../db/config'

let backend: PostgresJobBackend | undefined

/**
 * The one job backend, shared by `theo.config.ts` and by code that has to queue a job without a
 * request: a job or a cron has no `ctx.queue` (usetheokit/theokit#1150), so it writes through
 * the backend itself.
 */
export function jobBackend(): PostgresJobBackend {
  return (backend ??= PostgresJobBackend.fromStorageManager(
    getStorageManager(),
    DATABASE_NAME,
    createPool,
  ))
}
