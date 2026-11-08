import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dumpName, latest, prune, verifyDump } from './backup.mjs'

const at = (iso) => new Date(iso)

describe('dump names', () => {
  it('carry the UTC date and minute, and sort by time', () => {
    expect(dumpName(at('2026-11-04T09:05:00Z'))).toBe('factory-20261104-0905.dump')
    const names = [dumpName(at('2026-11-04T09:05:00Z')), dumpName(at('2026-10-30T23:59:00Z'))]
    expect(latest(names)).toBe('factory-20261104-0905.dump')
  })

  it('leave out files that are not dumps when asked for the newest', () => {
    expect(latest(['notes.txt', 'factory-20261104-0905.dump.counts.json'])).toBeUndefined()
  })
})

describe('prune', () => {
  const now = at('2026-11-20T12:00:00Z')

  it('removes a dump older than the days kept and keeps a newer one', () => {
    const files = [
      'factory-20261105-1200.dump',
      'factory-20261107-1200.dump',
      'factory-20261120-0300.dump',
    ]
    expect(prune(files, now, 14)).toEqual(['factory-20261105-1200.dump'])
  })

  it('keeps a dump exactly at the limit, and removes one a minute past it', () => {
    expect(prune(['factory-20261106-1200.dump'], now, 14)).toEqual([])
    expect(prune(['factory-20261106-1159.dump'], now, 14)).toEqual(['factory-20261106-1159.dump'])
  })

  it('leaves alone anything that is not a dump', () => {
    expect(
      prune(['notes.txt', 'factory-20200101-0000.dump.counts.json', 'x.dump'], now, 14),
    ).toEqual([])
  })
})

describe('the check that a dump can be restored', () => {
  // A `docker` that behaves as `docker exec -i <container> pg_restore` does on the archive it reads from stdin:
  // `--list` reads only the table of contents and exits, and anything else reads the whole archive and fails
  // on one that ends early. A real archive here would need a real container, which these suites never start.
  const FAKE = `#!/bin/sh
case " $* " in
  *" --list "*) head -c 64 >/dev/null; echo "; toc"; exit 0 ;;
esac
size=$(wc -c)
if [ "$size" -lt "$(cat "$WHOLE")" ]; then echo "pg_restore: error: could not read from input file: end of file" >&2; exit 1; fi
exit 0
`
  let dir
  let path
  const saved = process.env.PATH
  const c = { container: 'pg', user: 'factory' }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backup-check-'))
    writeFileSync(join(dir, 'docker'), FAKE)
    chmodSync(join(dir, 'docker'), 0o755)
    process.env.PATH = `${dir}:${saved}`
    process.env.WHOLE = join(dir, 'whole')
    path = join(dir, 'factory.dump')
  })

  afterEach(() => {
    process.env.PATH = saved
    delete process.env.WHOLE
  })

  const dump = (bytes, whole = bytes) => {
    writeFileSync(path, Buffer.alloc(bytes, 7))
    writeFileSync(process.env.WHOLE, String(whole))
  }

  it('accepts a dump larger than a pipe holds', () => {
    dump(4 * 1024 * 1024)
    expect(() => verifyDump(c, path)).not.toThrow()
  })

  it('refuses a dump that ends before the archive does, with what pg_restore said', () => {
    dump(1000, 5000)
    expect(() => verifyDump(c, path)).toThrow(/factory\.dump cannot be restored: .*end of file/)
  })
})
