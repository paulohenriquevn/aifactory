// Daily backup of the factory's database, and the check that a backup can be restored.
//
//   node scripts/backup.mjs              dump, verify pg_restore reads all of it, prune old ones
//   node scripts/backup.mjs --check      restore the latest dump into a scratch database and compare counts
//
// The dump is made inside the Postgres container (so the client always matches the server), written to
// BACKUP_DIR with mode 600, and kept for KEEP_DAYS. Rows only ever get added to the tables that are
// counted, so a restore is right when each count lies between the count taken just before the dump and
// the one taken just after it.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const NAME = /^factory-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.dump$/
export const COUNTED = ['task', 'evidence', 'stage_event', 'ingress', 'question', 'decision']

export const dumpName = (now) => {
  const p = (n) => String(n).padStart(2, '0')
  return `factory-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}.dump`
}

/** The dumps to delete: older than `keepDays` by the date in their name. Files that are not dumps are left alone. */
export function prune(files, now, keepDays) {
  const limit = now.getTime() - keepDays * 86_400_000
  return files.filter((f) => {
    const m = NAME.exec(f)
    return m && Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) < limit
  })
}

/** The newest dump in a list, by the date in its name. */
export const latest = (files) =>
  files
    .filter((f) => NAME.test(f))
    .sort()
    .at(-1)

const cfg = () => ({
  container: process.env.BACKUP_CONTAINER ?? 'aifactory-postgres-1',
  user: process.env.BACKUP_PG_USER ?? 'factory',
  db: process.env.BACKUP_DB ?? 'factory',
  dir: process.env.BACKUP_DIR ?? join(homedir(), 'backups', 'aifactory'),
  keepDays: Number(process.env.KEEP_DAYS ?? 14),
})

const docker = (c, args, input) =>
  execFileSync('docker', ['exec', ...(input ? ['-i'] : []), c.container, ...args], {
    input,
    maxBuffer: 1 << 30,
  })

const sql = (c, db, query) =>
  docker(c, ['psql', '-U', c.user, '-d', db, '-tAc', query]).toString().trim()

export function countsOf(c, db) {
  const parts = COUNTED.map((t) => `select '${t}', count(*) from ${t}`).join(' union all ')
  return Object.fromEntries(
    sql(c, db, parts)
      .split('\n')
      .map((line) => line.split('|'))
      .map(([t, n]) => [t, Number(n)]),
  )
}

/**
 * Throws unless pg_restore reads the whole dump. `--list` was not enough: it reads only the table of contents,
 * so it took a truncated dump for a good one, and it exits before reading the rest of stdin, which broke the
 * pipe once a dump outgrew it (paulohenriquevn/aifactory#3). Restoring to /dev/null reads every block.
 */
export function verifyDump(c, path) {
  const read = spawnSync('docker', ['exec', '-i', c.container, 'pg_restore', '-f', '/dev/null'], {
    input: readFileSync(path),
    maxBuffer: 1 << 30,
  })
  if (read.error) throw new Error(`${path} could not be checked: ${read.error.message}`)
  if (read.status !== 0) {
    throw new Error(`${path} cannot be restored: ${read.stderr.toString().trim()}`)
  }
}

export function backup(c = cfg(), now = new Date()) {
  mkdirSync(c.dir, { recursive: true, mode: 0o700 })
  const name = dumpName(now)
  const path = join(c.dir, name)
  const before = countsOf(c, c.db)
  writeFileSync(path, docker(c, ['pg_dump', '-U', c.user, '-Fc', c.db]), { mode: 0o600 })
  chmodSync(path, 0o600)
  const after = countsOf(c, c.db)
  verifyDump(c, path)
  writeFileSync(`${path}.counts.json`, JSON.stringify({ before, after }), { mode: 0o600 })
  const gone = prune(readdirSync(c.dir), now, c.keepDays)
  for (const f of gone) {
    unlinkSync(join(c.dir, f))
    if (existsSync(join(c.dir, `${f}.counts.json`))) unlinkSync(join(c.dir, `${f}.counts.json`))
  }
  return { path, pruned: gone }
}

/** Restores the newest dump into a scratch database and says whether the counts are the ones it was made from. */
export function restoreCheck(c = cfg()) {
  const newest = latest(readdirSync(c.dir))
  if (!newest) throw new Error(`no dump in ${c.dir}`)
  const path = join(c.dir, newest)
  const { before, after } = JSON.parse(readFileSync(`${path}.counts.json`, 'utf8'))
  const scratch = `${c.db}_restore_check`
  sql(c, 'postgres', `drop database if exists ${scratch}`)
  sql(c, 'postgres', `create database ${scratch}`)
  try {
    const restored = spawnSync(
      'docker',
      ['exec', '-i', c.container, 'pg_restore', '-U', c.user, '-d', scratch, '--no-owner'],
      { input: readFileSync(path), maxBuffer: 1 << 30 },
    )
    if (restored.status !== 0) throw new Error(`pg_restore failed: ${restored.stderr}`)
    const counts = countsOf(c, scratch)
    const wrong = COUNTED.filter((t) => counts[t] < before[t] || counts[t] > after[t])
    return { dump: newest, counts, expected: { before, after }, ok: wrong.length === 0, wrong }
  } finally {
    sql(c, 'postgres', `drop database if exists ${scratch}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--check')) {
    const result = restoreCheck()
    console.log(JSON.stringify(result))
    process.exit(result.ok ? 0 : 1)
  }
  const result = backup()
  console.log(JSON.stringify({ event: 'backup', ...result }))
}
