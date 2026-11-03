import { defineConfig } from 'drizzle-kit'

import { readDatabaseUrl } from './src/server/db/config'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: readDatabaseUrl() },
})
