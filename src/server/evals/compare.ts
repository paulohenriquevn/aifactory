import { retryableFailure } from '../../shared/panel'

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
  /**
   * Whether the case ran to a reviewer's verdict (approve or changes). A case stopped early, or whose checks
   * never let a review finish, has none, and its cost says nothing. Results recorded before this field
   * existed are read by `reachedVerdict`.
   */
  reachedVerdict?: boolean
}

/**
 * A result recorded without the field counts as a verdict only when it passed (an approval): `reviewRounds` also
 * counts a review that gave no valid verdict, so a failed legacy result is ambiguous and left out.
 */
export const reachedVerdict = (r: CaseResult): boolean => r.reachedVerdict ?? r.passed

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
 *
 * Two more rules, for a suite large enough to tell a change from chance. Cases that got worse are weighed
 * against cases that got better, and a run is refused when that many regressions would come by chance less
 * than once in twenty (`regressionPValue`), even under the pass-rate drop. A case the environment failed
 * (a sandbox, the network, a provider's limit) says nothing about the agents and is left out of both, but a
 * run where that happened to more than one case in five measured too little and is refused.
 */
export const THRESHOLDS = { passRateDrop: 0.2, costRise: 0.25, unmeasured: 0.2, pValue: 0.05 }

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
  /** Cases that failed in the baseline and pass now. */
  improvements: string[]
  /** Cases left out because the environment failed them, in the run or in the baseline. */
  unmeasured: string[]
  /** How likely that many regressions are by chance, against the improvements (`regressionPValue`). */
  pValue: number
  now: Summary
  before: Summary
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`
const usd = (value: number) => `US$ ${value.toFixed(2)}`
// Rates and costs are sums of floating point numbers; a run exactly at a threshold must not fail on rounding.
const EPSILON = 1e-9

/** How a case ends whose failing checks fail on its base too: it measured the base, not the agents (#219). */
export const MEASURED_ITS_BASE = 'so the case measures its base, not the agents'

/**
 * A case that failed for its environment (`retryableFailure` says `environment`), or whose checks fail on its base
 * too, not for what the agents did.
 */
export function failedForEnvironment(result: CaseResult): boolean {
  if (result.passed) return false
  return (
    result.reason.includes(MEASURED_ITS_BASE) ||
    retryableFailure({ error: result.reason }) === 'environment'
  )
}

/**
 * The exact one-sided sign test over the cases whose outcome changed (McNemar's test for paired cases): the
 * chance of `regressions` or more of them going worse if each change were a fair coin.
 */
export function regressionPValue(regressions: number, improvements: number): number {
  const n = regressions + improvements
  if (regressions === 0) return 1
  let choose = 1
  let tail = 0
  for (let k = 0; k <= n; k++) {
    if (k >= regressions) tail += choose
    choose = (choose * (n - k)) / (k + 1)
  }
  return tail / 2 ** n
}

/** Compares the cases a run shares with the baseline; cases only one of them has are left out. */
export function compareWithBaseline(
  run: CaseResult[],
  baseline: Baseline,
  thresholds = THRESHOLDS,
): Comparison {
  const earlier = new Map(baseline.results.map((r) => [r.id, r]))
  const shared = run.filter((r) => earlier.has(r.id))
  const unmeasured = shared
    .filter((r) => failedForEnvironment(r) || failedForEnvironment(earlier.get(r.id)!))
    .map((r) => r.id)
  const measured = shared.filter((r) => !unmeasured.includes(r.id))
  const now = summarize(measured)
  const before = summarize(measured.map((r) => earlier.get(r.id)!))
  const regressions = measured.filter((r) => !r.passed && earlier.get(r.id)!.passed).map((r) => r.id)
  const improvements = measured.filter((r) => r.passed && !earlier.get(r.id)!.passed).map((r) => r.id)
  const pValue = regressionPValue(regressions.length, improvements.length)
  // Cost is compared over the cases that ran to a verdict in both runs: a case that failed early costs nothing.
  const costed = measured.filter((r) => reachedVerdict(r) && reachedVerdict(earlier.get(r.id)!))
  now.meanCostUsd = mean(costed.map((r) => r.costUsd))
  before.meanCostUsd = mean(costed.map((r) => earlier.get(r.id)!.costUsd))
  const counts = { regressions, improvements, unmeasured, pValue, now, before }
  if (shared.length === 0) {
    return { ok: false, reasons: ['no case of this run is in the baseline'], ...counts }
  }
  const reasons: string[] = []
  if (unmeasured.length / shared.length > thresholds.unmeasured + EPSILON) {
    reasons.push(
      `the environment failed ${unmeasured.length} of ${shared.length} cases (${unmeasured.join(', ')}), so the run measured too little`,
    )
  }
  if (pValue < thresholds.pValue) {
    reasons.push(
      `${regressions.length} cases got worse and ${improvements.length} got better, more than chance explains (p = ${pValue.toFixed(3)})`,
    )
  }
  if (before.passRate - now.passRate > thresholds.passRateDrop + EPSILON) {
    reasons.push(`the pass rate fell from ${percent(before.passRate)} to ${percent(now.passRate)}`)
  }
  if (costed.length === 0 && measured.length > 0) {
    reasons.push('no case ran to a verdict in both runs, so the cost could not be compared')
  }
  if (
    before.meanCostUsd > 0 &&
    now.meanCostUsd > before.meanCostUsd * (1 + thresholds.costRise) + EPSILON
  ) {
    reasons.push(
      `the mean cost per case rose from ${usd(before.meanCostUsd)} to ${usd(now.meanCostUsd)} (${costed.length} cases that ran to a verdict in both runs)`,
    )
  }
  return { ok: reasons.length === 0, reasons, ...counts }
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
