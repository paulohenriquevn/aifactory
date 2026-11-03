import type { StorageConfig } from 'theokit/server/storage'
import { z } from 'zod'

const databaseEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
})

/** Thrown when `DATABASE_URL` is set but is not a usable postgres:// URL. */
export class DatabaseConfigError extends Error {
  constructor(detail: string) {
    super(`DATABASE_URL is missing or not a postgres:// URL: ${detail}`)
    this.name = 'DatabaseConfigError'
  }
}

/** Reads and validates the database URL, failing before any connection is attempted. */
export function readDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = databaseEnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new DatabaseConfigError(z.prettifyError(parsed.error))
  }
  return parsed.data.DATABASE_URL
}

/** The name `usePostgres` takes, and the key of the database in `theo.config.ts`. */
export const DATABASE_NAME = 'main'

/**
 * TheoKit's `storage` block takes credentials as fields and reads no connection string, so the
 * URL the rest of the tooling shares (`drizzle-kit`, `.env`) is split here, once.
 */
export function storageFromUrl(url: string): StorageConfig {
  const parsed = new URL(url)
  return {
    servers: {
      primary: {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 5432,
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      },
    },
    databases: {
      [DATABASE_NAME]: {
        server: 'primary',
        database: decodeURIComponent(parsed.pathname.slice(1)),
      },
    },
  }
}

/**
 * The `storage` block for `theo.config.ts`. A missing `DATABASE_URL` yields no block, so a build
 * that never touches the database still works and readiness reports the gap; a URL that is set
 * but malformed fails here, at startup.
 */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig | undefined {
  if (!env.DATABASE_URL) return undefined
  return storageFromUrl(readDatabaseUrl(env))
}
