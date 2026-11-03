import { describe, expect, it } from 'vitest'

import { DatabaseConfigError, storageFromEnv, storageFromUrl } from './config'

describe('storageFromUrl', () => {
  it('splits the URL into the server and database TheoKit expects', () => {
    expect(storageFromUrl('postgres://factory:s3cret@db.internal:54329/factory')).toEqual({
      servers: {
        primary: { host: 'db.internal', port: 54329, user: 'factory', password: 's3cret' },
      },
      databases: { main: { server: 'primary', database: 'factory' } },
    })
  })

  it('defaults the port and decodes escaped credentials', () => {
    const { servers } = storageFromUrl('postgresql://us%40er:p%2Fw%3Ad@localhost/factory')
    expect(servers?.primary).toMatchObject({ port: 5432, user: 'us@er', password: 'p/w:d' })
  })
})

describe('storageFromEnv', () => {
  it('yields no block without DATABASE_URL, so a build that never queries still loads', () => {
    expect(storageFromEnv({})).toBeUndefined()
  })

  it('fails at startup when DATABASE_URL is set but is not a postgres URL', () => {
    expect(() => storageFromEnv({ DATABASE_URL: 'mysql://localhost/factory' })).toThrow(
      DatabaseConfigError,
    )
  })
})
