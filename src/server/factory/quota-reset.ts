/**
 * When an agent's quota comes back, as an instant. The agents say it as a clock time ("resets 3:39 AM",
 * "reset at 3pm (America/Sao_Paulo)"), so the instant depends on two things the text leaves out: the time
 * zone, which is the sandbox's own (UTC) unless the text names one, and the day, which is the first one
 * after the failure where that time falls. Reading it against the failure, and not against the moment
 * someone reads it, is what keeps a stop that already passed from turning into a pause until the next day.
 */
const CLOCK = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*(?:\(([^)]+)\))?\s*$/i
const DATED =
  /^\s*([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*(?:\(([^)]+)\))?\s*$/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const SANDBOX_ZONE = 'UTC'

export function quotaResumesAt(text: string | undefined, failedAt: Date): Date | undefined {
  if (!text) return undefined
  const dated = DATED.exec(text)
  if (dated) {
    const month = MONTHS.indexOf(dated[1].toLowerCase())
    const time = hourOf(dated[4], dated[5], dated[6])
    const zone = dated[7]?.trim() ?? SANDBOX_ZONE
    if (month < 0 || !time || !isZone(zone)) return undefined
    return instantOf(Number(dated[3]), month, Number(dated[2]), time.hour, time.minute, zone)
  }
  const clock = CLOCK.exec(text)
  if (!clock) return undefined
  const time = hourOf(clock[1], clock[2], clock[3])
  const zone = clock[4]?.trim() ?? SANDBOX_ZONE
  if (!time || !isZone(zone)) return undefined
  const { hour, minute } = time
  const day = wallClock(failedAt, zone)
  const today = instantOf(day.year, day.month, day.day, hour, minute, zone)
  return today.getTime() > failedAt.getTime()
    ? today
    : instantOf(day.year, day.month, day.day + 1, hour, minute, zone)
}

/** A 12-hour clock reading as a 24-hour one, or nothing when it is not a time. */
function hourOf(hours: string, minutes: string | undefined, half: string) {
  const hour12 = Number(hours)
  const minute = Number(minutes ?? 0)
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined
  return { hour: (hour12 % 12) + (half.toLowerCase() === 'p' ? 12 : 0), minute }
}

function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The calendar date and time an instant shows in a zone. */
function wallClock(instant: Date, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(instant)
      .map((p) => [p.type, Number(p.value)]),
  )
  return {
    year: parts.year,
    month: parts.month - 1,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

/** How far ahead of UTC a zone's clock is at an instant, in milliseconds. */
function offsetAt(instant: number, zone: string): number {
  const w = wallClock(new Date(instant), zone)
  const asUtc = Date.UTC(w.year, w.month, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(instant / 1000) * 1000
}

/** The instant a zone's clock shows a given date and time. Computed twice so a DST change is met. */
function instantOf(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
) {
  const wall = Date.UTC(year, month, day, hour, minute)
  const first = wall - offsetAt(wall, zone)
  return new Date(wall - offsetAt(first, zone))
}
