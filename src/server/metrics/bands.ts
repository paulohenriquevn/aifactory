import type { BandConfig, MetricSpec, Rule, Tier } from './config'

/** One day of one metric: the mean of what was observed that day, and how many observations made it. */
export type Point = { day: string; value: number; samples: number }

export type Baseline = { mean: number; sd: number; points: number }

export type Broken = { rule: Rule; tier: Tier }

/** Where the latest point of a series stands against its band. */
export type BandState =
  | { kind: 'no_baseline'; points: number }
  | {
      kind: 'evaluated'
      baseline: Baseline
      /** The latest point's distance from the mean, in deviations, positive in the worse direction. */
      z: number
      /** The rules it breaks, the strongest tier first. */
      broken: Broken[]
    }

/**
 * The points the rules read: the latest eight. The baseline is made of the points before them, so a run of
 * bad days cannot drag the mean along and hide itself.
 */
export const TAIL = 8

const DAY_MS = 86_400_000
const TIER_ORDER: Tier[] = ['act', 'show', 'log']

/** The day `days` days before `day`, both as `YYYY-MM-DD`. */
function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10)
}

/**
 * The mean and standard deviation of the points inside the window that ends at `latestDay`. Null when there
 * are too few points to say anything, or when they are all equal and no distance can be measured.
 */
export function baselineOf(
  before: Point[],
  latestDay: string,
  config: BandConfig,
): Baseline | null {
  const from = daysBefore(latestDay, config.windowDays)
  const values = before.filter((p) => p.day >= from).map((p) => p.value)
  if (values.length < config.minBaselinePoints) return null
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length)
  if (sd === 0) return null
  return { mean, sd, points: values.length }
}

/**
 * How many of the last `of` distances are past `limit`, given that the latest one is. The tail always holds
 * `TAIL` distances, as many as the longest rule reads.
 */
function pastLimit(z: number[], of: number, limit: number): number {
  if (z[z.length - 1] <= limit) return 0
  return z.slice(-of).filter((d) => d > limit).length
}

/** The Western Electric rules, each read on the distances of the tail, oldest first. */
const RULE_TESTS: Record<Rule, (z: number[]) => boolean> = {
  beyond_3_sigma: (z) => pastLimit(z, 1, 3) === 1,
  two_of_three_beyond_2_sigma: (z) => pastLimit(z, 3, 2) >= 2,
  four_of_five_beyond_1_sigma: (z) => pastLimit(z, 5, 1) >= 4,
  eight_on_one_side: (z) => pastLimit(z, 8, 0) === 8,
}

/**
 * Reads the latest point of a series (sorted by day) against its band. Only a move in the direction the
 * metric gets worse breaks a rule: a better number is good news, not a signal.
 */
export function evaluate(
  series: Point[],
  worse: MetricSpec['worse'],
  config: BandConfig,
): BandState {
  if (series.length === 0) return { kind: 'no_baseline', points: 0 }
  const tail = series.slice(-TAIL)
  const before = series.slice(0, Math.max(0, series.length - TAIL))
  const latestDay = tail[tail.length - 1].day
  const baseline = baselineOf(before, latestDay, config)
  if (!baseline) {
    const from = daysBefore(latestDay, config.windowDays)
    return { kind: 'no_baseline', points: before.filter((p) => p.day >= from).length }
  }
  const sign = worse === 'up' ? 1 : -1
  const z = tail.map((p) => (sign * (p.value - baseline.mean)) / baseline.sd)
  const broken = (Object.keys(RULE_TESTS) as Rule[])
    .filter((rule) => RULE_TESTS[rule](z))
    .map((rule) => ({ rule, tier: config.tiers[rule] }))
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
  return { kind: 'evaluated', baseline, z: z[z.length - 1], broken }
}

/** The strongest tier among broken rules: `act` over `show` over `log`. */
export function strongest(broken: Broken[]): Tier | null {
  return TIER_ORDER.find((tier) => broken.some((b) => b.tier === tier)) ?? null
}
