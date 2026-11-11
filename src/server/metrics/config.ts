/**
 * What the factory measures about itself and how it reacts when a number leaves its usual range. This file
 * is the configuration: a change to a band or a tier is a reviewed change to it, like code.
 */

export const METRIC_NAMES = [
  'first_pass_checks',
  'rework_rounds',
  'first_review_approval',
  'minutes_to_first_review',
  'minutes_to_delivery',
  'cost_per_delivery',
  'change_failure',
  'hours_to_release',
] as const
export type MetricName = (typeof METRIC_NAMES)[number]

export type MetricSpec = {
  label: string
  unit: 'share' | 'count' | 'minutes' | 'hours' | 'usd'
  /** The direction in which the number gets worse. A move the other way never raises a signal. */
  worse: 'up' | 'down'
  /** A day with fewer observations than this makes no point: one run is not a rate. */
  minSamples: number
}

export const METRICS: Record<MetricName, MetricSpec> = {
  first_pass_checks: {
    label: 'Checks green on the first verification',
    unit: 'share',
    worse: 'down',
    minSamples: 3,
  },
  rework_rounds: { label: 'Rework rounds per run', unit: 'count', worse: 'up', minSamples: 3 },
  first_review_approval: {
    label: 'Approved on the first review',
    unit: 'share',
    worse: 'down',
    minSamples: 3,
  },
  minutes_to_first_review: {
    label: 'Minutes from the start of a run to its first review',
    unit: 'minutes',
    worse: 'up',
    minSamples: 3,
  },
  minutes_to_delivery: {
    label: 'Minutes from the start of a run to its delivery',
    unit: 'minutes',
    worse: 'up',
    minSamples: 3,
  },
  cost_per_delivery: {
    label: 'Cost per delivered run',
    unit: 'usd',
    worse: 'up',
    minSamples: 3,
  },
  change_failure: {
    label: 'Delivered work that came back',
    unit: 'share',
    worse: 'up',
    minSamples: 3,
  },
  hours_to_release: {
    label: 'Hours from the task to its release',
    unit: 'hours',
    worse: 'up',
    minSamples: 1,
  },
}

export const RULES = [
  'beyond_3_sigma',
  'two_of_three_beyond_2_sigma',
  'four_of_five_beyond_1_sigma',
  'eight_on_one_side',
] as const
export type Rule = (typeof RULES)[number]

/** What a broken rule leads to: `log` only records it, `show` also puts it on the panel, `act` opens an issue. */
export type Tier = 'log' | 'show' | 'act'

export type BandConfig = {
  /** The days before a point that make its baseline. */
  windowDays: number
  /** A baseline with fewer points than this says nothing, so no rule is read against it. */
  minBaselinePoints: number
  tiers: Record<Rule, Tier>
  /** Where an `act` signal is filed. */
  issueRepository: string
}

export const BANDS: BandConfig = {
  windowDays: 30,
  minBaselinePoints: 7,
  tiers: {
    beyond_3_sigma: 'act',
    two_of_three_beyond_2_sigma: 'show',
    four_of_five_beyond_1_sigma: 'log',
    // A slow drift breaks no sigma line, and it is the change nobody notices.
    eight_on_one_side: 'show',
  },
  issueRepository: 'paulohenriquevn/aifactory',
}
