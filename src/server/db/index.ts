import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { getStorageManager } from 'theokit/server/storage'

import { DATABASE_NAME } from './config'
import * as schema from './schema'

export { DatabaseConfigError, readDatabaseUrl } from './config'

export type Database = NodePgDatabase<typeof schema>

/**
 * The process-wide pool, owned by TheoKit's storage manager so that it is drained on shutdown
 * and survives Postgres dropping an idle connection (usetheokit/theokit#1019). Created on first
 * use, so importing this module never connects.
 */
export function getPool(): pg.Pool {
  return getStorageManager().usePostgres(DATABASE_NAME, (server, db) => {
    const { host, port, user, password } = server
    return new pg.Pool({ host, port, user, password, database: db.database, ...db.pool })
  }) as pg.Pool
}

export function getDb(): Database {
  return drizzle(getPool(), { schema })
}
