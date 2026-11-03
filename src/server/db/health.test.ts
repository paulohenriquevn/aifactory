import { describe, expect, it } from 'vitest'

import { checkDatabase } from './health'
import { DatabaseConfigError, getPool, readDatabaseUrl } from './index'

describe('checkDatabase', () => {
  it('reports up when the query resolves', async () => {
    const result = await checkDatabase({ query: async () => ({ rows: [{ '?column?': 1 }] }) })
    expect(result.status).toBe('up')
  })

  it('reports down with the driver message when the query rejects', async () => {
    const result = await checkDatabase({
      query: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
      },
    })
    expect(result).toEqual({ status: 'down', error: 'connect ECONNREFUSED 127.0.0.1:5432' })
  })

  it('reports down when the query never answers within the timeout', async () => {
    const result = await checkDatabase({ query: () => new Promise(() => {}) }, 20)
    expect(result).toEqual({ status: 'down', error: 'database did not answer within 20 ms' })
  })
})

describe('readiness without a configured database', () => {
  // The same shape `routes/ready.ts` passes: the pool is resolved inside the probe.
  it('reports down with the reason instead of throwing', async () => {
    const result = await checkDatabase({ query: (sql) => getPool().query(sql) })
    expect(result).toEqual({
      status: 'down',
      error: expect.stringContaining('Database "main" not configured'),
    })
  })
})

describe('readDatabaseUrl', () => {
  it('returns a postgres URL unchanged', () => {
    const url = 'postgres://factory:factory@localhost:5432/factory'
    expect(readDatabaseUrl({ DATABASE_URL: url })).toBe(url)
  })

  it('rejects a missing DATABASE_URL with a typed error', () => {
    expect(() => readDatabaseUrl({})).toThrow(DatabaseConfigError)
  })

  it('rejects a URL for another database engine', () => {
    expect(() => readDatabaseUrl({ DATABASE_URL: 'mysql://localhost/factory' })).toThrow(
      DatabaseConfigError,
    )
  })
})
