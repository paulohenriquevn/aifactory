import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { storageFromUrl } from './config'
import { getDb, readDatabaseUrl } from './index'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})

afterAll(async () => {
  await getStorageManager().dispose()
})

describe('the database the factory runs on', () => {
  // JIT compiled the board's card query on every poll: 7.6 of its 8.3 seconds (2026-11-19).
  it('runs a new connection without JIT', async () => {
    const fresh = new pg.Client({ connectionString: readDatabaseUrl() })
    await fresh.connect()
    try {
      const { rows } = await fresh.query<{ jit: string }>('show jit')
      expect(rows[0].jit).toBe('off')
    } finally {
      await fresh.end()
    }
  })

  it('has an index on the task and the order of its events', async () => {
    const fresh = new pg.Client({ connectionString: readDatabaseUrl() })
    await fresh.connect()
    try {
      const { rows } = await fresh.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where indexname = 'stage_event_task_id_id'",
      )
      expect(rows.map((r) => r.indexdef)).toEqual([
        'CREATE INDEX stage_event_task_id_id ON public.stage_event USING btree (task_id, id)',
      ])
    } finally {
      await fresh.end()
    }
  })
})
