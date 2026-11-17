/** What one case of the suite came to. */
export type CaseResult = {
  id: string
  passed: boolean
  /** Why it passed or failed, in a line. */
  reason: string
  /** What the agents said they cost; the sandbox is not included. */
  costUsd: number
  durationMs: number
  /** How many builder passes the case took. */
  attempts: number
  reviewRounds: number
}

/** Which agents ran, and with what model, so a change made outside the code still counts as a change. */
export type AgentSetup = Record<string, string>

export type Baseline = {
  /** The commit of this repository the baseline ran on. */
  commit: string
  ranAt: string
  setup: AgentSetup
  results: CaseResult[]
}

export type Summary = {
  cases: number
  passed: number
  passRate: number
  meanCostUsd: number
  meanDurationMs: number
}

/**
 * How much worse a run may be than the baseline before it is refused (ADR 0008). A pass rate may fall by
 * one case in five, since a model answers differently from one run to the next; two cases in five is a
 * change. The mean cost may rise by a quarter.
 */
export const THRESHOLDS = { passRateDrop: 0.2, costRise: 0.25 }

const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length

export function summarize(results: CaseResult[]): Summary {
  const passed = results.filter((r) => r.passed).length
  return {
    cases: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    meanCostUsd: mean(results.map((r) => r.costUsd)),
    meanDurationMs: mean(results.map((r) => r.durationMs)),
  }
}

export type Comparison = {
  ok: boolean
  reasons: string[]
  /** Cases that passed in the baseline and failed now. */
  regressions: string[]
  now: Summary
  before: Summary
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`
const usd = (value: number) => `US$ ${value.toFixed(2)}`
// Rates and costs are sums of floating point numbers; a run exactly at a threshold must not fail on rounding.
const EPSILON = 1e-9

/** Compares the cases a run shares with the baseline; cases only one of them has are left out. */
export function compareWithBaseline(
  run: CaseResult[],
  baseline: Baseline,
  thresholds = THRESHOLDS,
): Comparison {
  const earlier = new Map(baseline.results.map((r) => [r.id, r]))
  const shared = run.filter((r) => earlier.has(r.id))
  const now = summarize(shared)
  const before = summarize(shared.map((r) => earlier.get(r.id)!))
  const regressions = shared.filter((r) => !r.passed && earlier.get(r.id)!.passed).map((r) => r.id)
  if (shared.length === 0) {
    return {
      ok: false,
      reasons: ['no case of this run is in the baseline'],
      regressions,
      now,
      before,
    }
  }
  const reasons: string[] = []
  if (before.passRate - now.passRate > thresholds.passRateDrop + EPSILON) {
    reasons.push(`the pass rate fell from ${percent(before.passRate)} to ${percent(now.passRate)}`)
  }
  if (
    before.meanCostUsd > 0 &&
    now.meanCostUsd > before.meanCostUsd * (1 + thresholds.costRise) + EPSILON
  ) {
    reasons.push(
      `the mean cost per case rose from ${usd(before.meanCostUsd)} to ${usd(now.meanCostUsd)}`,
    )
  }
  return { ok: reasons.length === 0, reasons, regressions, now, before }
}

/** What a case's last attempt came to, or what stopped it before there was one. */
export type CaseEnd =
  | {
      checksPassed: boolean
      verdict: 'approve' | 'changes' | 'invalid'
      /** Findings about the diff that the factory makes without a model and that block a merge. */
      blockingGuards: string[]
      failedChecks?: string[]
    }
  | { stopped: string }

/** The same bar the factory sets before it integrates: green checks, an approval, and no broken rule. */
export function caseOutcome(end: CaseEnd): { passed: boolean; reason: string } {
  if ('stopped' in end) return { passed: false, reason: end.stopped }
  if (!end.checksPassed) {
    return { passed: false, reason: `checks failed: ${(end.failedChecks ?? []).join(', ')}` }
  }
  if (end.blockingGuards.length > 0) {
    return { passed: false, reason: `outside the rules: ${end.blockingGuards.join('; ')}` }
  }
  if (end.verdict !== 'approve') {
    return {
      passed: false,
      reason:
        end.verdict === 'changes'
          ? 'the reviewer asked for changes'
          : 'the reviewer gave no verdict',
    }
  }
  return { passed: true, reason: 'approved' }
}
