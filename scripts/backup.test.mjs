import { describe, expect, it } from 'vitest'

import { dumpName, latest, prune } from './backup.mjs'

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
