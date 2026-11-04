import pg from 'pg'

/**
 * The suites that write to Postgres truncate their tables, and the factory's own database holds real
 * tasks. So they never run against it: this points `DATABASE_URL` at `<name>_test` on the same server,
 * creates that database when it is missing, and refuses anything else.
 */
const raw = process.env.DATABASE_URL
if (raw) {
  const url = new URL(raw)
  const name = decodeURIComponent(url.pathname.slice(1))
  const testName = name.endsWith('_test') ? name : `${name}_test`

  const admin = new pg.Client({ connectionString: raw })
  await admin.connect()
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [testName])
    if (exists.rowCount === 0)
      await admin.query(`create database "${testName.replace(/"/g, '""')}"`)
  } finally {
    await admin.end()
  }

  url.pathname = `/${encodeURIComponent(testName)}`
  process.env.DATABASE_URL = url.toString()
  if (!new URL(process.env.DATABASE_URL).pathname.slice(1).endsWith('_test')) {
    throw new Error('a test must run against a database whose name ends in _test')
  }
}
