import { describe, expect, it } from 'vitest'

import { quotaResumesAt } from './quota-reset'

const at = (iso: string) => new Date(iso)

describe('when an agent says its quota comes back', () => {
  it('reads a bare clock time in UTC, the clock of the sandbox that printed it', () => {
    expect(quotaResumesAt('3:39 AM', at('2026-11-06T00:13:00Z'))?.toISOString()).toBe(
      '2026-11-06T03:39:00.000Z',
    )
    expect(quotaResumesAt('12:30 PM', at('2026-11-06T09:32:00Z'))?.toISOString()).toBe(
      '2026-11-06T12:30:00.000Z',
    )
  })

  it('takes the first such time after the failure, the next day when the hour already went by', () => {
    expect(quotaResumesAt('7:38 PM', at('2026-11-05T21:00:00Z'))?.toISOString()).toBe(
      '2026-11-06T19:38:00.000Z',
    )
  })

  it('counts from the failure, so a stale stop does not move to the next day', () => {
    // The feeder read this stop hours after it happened and paused until the next morning.
    const resumes = quotaResumesAt('3:39 AM', at('2026-11-06T00:13:00Z'))!
    expect(resumes.getTime()).toBeLessThan(at('2026-11-06T14:08:00Z').getTime())
  })

  it('reads an hour with no minutes, and a time zone in parentheses', () => {
    expect(
      quotaResumesAt('3pm (America/Sao_Paulo)', at('2026-11-06T12:00:00Z'))?.toISOString(),
    ).toBe('2026-11-06T18:00:00.000Z')
    expect(quotaResumesAt('6am (UTC)', at('2026-11-06T12:00:00Z'))?.toISOString()).toBe(
      '2026-11-07T06:00:00.000Z',
    )
  })

  it('reads midnight and noon as 12 AM and 12 PM', () => {
    expect(quotaResumesAt('12:00 AM', at('2026-11-06T10:00:00Z'))?.toISOString()).toBe(
      '2026-11-07T00:00:00.000Z',
    )
    expect(quotaResumesAt('12pm', at('2026-11-06T10:00:00Z'))?.toISOString()).toBe(
      '2026-11-06T12:00:00.000Z',
    )
  })

  it('reads a date with the time, the way Codex prints a reset more than a day away', () => {
    expect(
      quotaResumesAt('Nov 5th, 2026 11:48 AM', at('2026-11-03T10:00:00Z'))?.toISOString(),
    ).toBe('2026-11-05T11:48:00.000Z')
    expect(quotaResumesAt('Nov 5, 2026 3:04 PM', at('2026-11-03T10:00:00Z'))?.toISOString()).toBe(
      '2026-11-05T15:04:00.000Z',
    )
  })

  it('gives nothing for a text it cannot read or a zone that does not exist', () => {
    expect(quotaResumesAt(undefined, at('2026-11-06T10:00:00Z'))).toBeUndefined()
    expect(quotaResumesAt('soon', at('2026-11-06T10:00:00Z'))).toBeUndefined()
    expect(quotaResumesAt('25:00', at('2026-11-06T10:00:00Z'))).toBeUndefined()
    expect(quotaResumesAt('3pm (Mars/Base)', at('2026-11-06T10:00:00Z'))).toBeUndefined()
  })
})
