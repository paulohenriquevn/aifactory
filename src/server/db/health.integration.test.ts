import pg from 'pg'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { storageFromUrl } from './config'
import { checkDatabase } from './health'
import { getPool, readDatabaseUrl } from './index'

// Runs against a real Postgres. `pnpm test:integration` fails fast when DATABASE_URL is unset,
// because a skipped integration suite reads as a passing one.
const admin = new pg.Pool({ connectionString: readDatabaseUrl() })

beforeAll(() => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
})

afterAll(async () => {
  await getStorageManager().dispose()
  await admin.end()
})

describe('checkDatabase against Postgres', () => {
  it('reports up for the pool the app uses', async () => {
    const result = await checkDatabase(getPool())
    expect(result.status).toBe('up')
  })

  it('keeps the process alive when the server drops an idle pooled connection', async () => {
    const pool = getPool()
    const { rows } = await pool.query<{ pid: number }>('select pg_backend_pid() as pid')
    const gone = new Promise<void>((resolve) => {
      const watch = setInterval(() => {
        if (pool.totalCount === 0) {
          clearInterval(watch)
          resolve()
        }
      }, 25)
    })

    await admin.query('select pg_terminate_backend($1)', [rows[0].pid])
    await gone

    expect((await checkDatabase(pool)).status).toBe('up')
  })

  it('reports down for a port nobody listens on', async () => {
    const unreachable = new pg.Pool({
      connectionString: 'postgres://factory:factory@127.0.0.1:1/factory',
      connectionTimeoutMillis: 500,
    })
    try {
      const result = await checkDatabase(unreachable)
      expect(result.status).toBe('down')
    } finally {
      await unreachable.end()
    }
  })
})
