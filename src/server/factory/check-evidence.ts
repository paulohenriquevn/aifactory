import type { FailedRun, PromotionApi } from '../github/promotion-api'
import type { CheckReport } from '../github/pulls'

import type { FailedReport, ServerEvidence } from './ci-wait'
import { checkEvidence, failedStep, logEvidence } from './promotion'

/** What reading a failed check's evidence takes from GitHub, with a repository-scoped token. */
export type EvidenceApi = Pick<PromotionApi, 'failedChecks' | 'jobLog' | 'annotations'> &
  Partial<Pick<PromotionApi, 'jobAttempt' | 'rerunFailedJobs'>>

/**
 * The lines that say why a check run failed, read on the factory host: the error lines of an Actions job's
 * log, or the annotations and summary of any other check. Both come bounded by `logEvidence` and
 * `checkEvidence`. The text is CI output, so it is data for an agent to read, never a command to run.
 */
export async function readEvidence(
  api: Pick<EvidenceApi, 'jobLog' | 'annotations'>,
  repo: string,
  token: string,
  run: FailedRun,
): Promise<string[]> {
  if (run.actions) return logEvidence(await api.jobLog(repo, token, run.id))
  return checkEvidence(await api.annotations(repo, token, run.id), run.summary)
}

/** What became of the rerun of the failed jobs: how many runs are rerunning, and what kept the others from it. */
export type RerunOutcome = { started: number; problems: string[] }

/** The reruns the factory asked for, by commit and run, and when: the next pass waits for them to finish. */
export type RerunMemo = Map<string, number>

/** How long a requested rerun is waited for before the failure counts again. */
const RERUN_WAIT_MS = 15 * 60_000

const said = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A check run whose log or annotations were read and said nothing about what failed (an aggregate job). */
const aggregate = (evidence: ServerEvidence) => 'lines' in evidence && evidence.lines.length === 0

/**
 * The failed Actions runs worth rerunning: the runs of the failed required checks and, when they all say
 * no more than that something they depend on failed (an aggregate job such as `checks-pass`), the other
 * failed runs of the commit, as `alongside` names them. A run of an unrelated workflow is left alone.
 */
async function relevantRuns(
  api: EvidenceApi,
  repo: string,
  token: string,
  runs: FailedRun[],
  names: string[],
): Promise<FailedRun[]> {
  const named = runs.filter((run) => run.actions && names.includes(run.name))
  const evidence = await Promise.all(named.map((run) => evidenceOf(api, repo, token, run)))
  if (named.length > 0 && !evidence.every(aggregate)) return named
  return runs.filter((run) => run.actions)
}

/**
 * Reruns, once, the failed Actions runs behind the failed required checks whose job is on its first attempt:
 * a failure that is not of the work (a flaky test) passes on the second attempt. A job already on its second
 * attempt is never rerun, and a run rerun by `memo` in the last quarter of an hour is waited for, not
 * rerun again. What GitHub refuses or fails to answer is a problem the caller reports, per run, so one failure
 * does not keep the others from being rerun. An API without the rerun calls reruns nothing and says nothing.
 */
export async function rerunTransient(
  api: EvidenceApi,
  repo: string,
  token: string,
  sha: string,
  reports: CheckReport[],
  memo: RerunMemo,
  now: Date = new Date(),
): Promise<RerunOutcome> {
  const outcome: RerunOutcome = { started: 0, problems: [] }
  const { jobAttempt, rerunFailedJobs } = api
  if (!jobAttempt || !rerunFailedJobs) return outcome
  let runs: FailedRun[]
  try {
    runs = await relevantRuns(
      api,
      repo,
      token,
      await api.failedChecks(repo, token, sha),
      reports.map((r) => r.name),
    )
  } catch (error) {
    outcome.problems.push(`listing the failed jobs: ${said(error)}`)
    return outcome
  }
  const tried = new Set<number>()
  for (const run of runs) {
    try {
      const job = await jobAttempt.call(api, repo, token, run.id)
      if (job.attempt >= 2 || tried.has(job.runId)) continue
      tried.add(job.runId)
      const key = `${sha}:${job.runId}`
      const asked = memo.get(key)
      if (asked !== undefined && now.getTime() - asked < RERUN_WAIT_MS) {
        outcome.started += 1
        continue
      }
      const answer = await rerunFailedJobs.call(api, repo, token, job.runId)
      if (answer.started) {
        memo.set(key, now.getTime())
        outcome.started += 1
      } else outcome.problems.push(answer.refusal)
    } catch (error) {
      outcome.problems.push(`rerunning ${run.name}: ${said(error)}`)
    }
  }
  return outcome
}

const unreadable = (error: unknown): ServerEvidence => ({
  unreadable: error instanceof Error ? error.message : String(error),
})

/** A check's evidence as the note takes it: what was read, or why it could not be. */
async function evidenceOf(
  api: EvidenceApi,
  repo: string,
  token: string,
  run: FailedRun,
): Promise<ServerEvidence> {
  try {
    if (!run.actions) return { lines: await readEvidence(api, repo, token, run) }
    const log = await api.jobLog(repo, token, run.id)
    const step = failedStep(log)
    return { lines: logEvidence(log), ...(step ? { step } : {}) }
  } catch (error) {
    return unreadable(error)
  }
}

/** A check run whose log or annotations were read and said nothing about what failed (an aggregate job). */
const silent = (report: FailedReport) =>
  report.evidence !== undefined && 'lines' in report.evidence && report.evidence.lines.length === 0

/**
 * The other failed check runs of the commit, for a required check that only says something it depends on
 * failed (an aggregate job such as `checks-pass`). As in `withEvidence` for the promotion watch, a run that
 * says no more than the aggregate is left out; one whose evidence could not be read is named all the same.
 */
async function alongside(
  api: EvidenceApi,
  repo: string,
  token: string,
  runs: FailedRun[],
  named: string[],
): Promise<FailedReport[]> {
  const others: FailedReport[] = []
  for (const run of runs.filter((candidate) => !named.includes(candidate.name))) {
    const other: FailedReport = {
      name: run.name,
      state: 'failure',
      detail: run.summary,
      url: run.url,
      notRequired: true,
      evidence: await evidenceOf(api, repo, token, run),
    }
    if (!silent(other)) others.push(other)
  }
  return others
}

/**
 * The failed required checks of a commit, each with the evidence of the check run that has its name, and,
 * when one of them names no failure of its own, the other check runs that failed on the commit. Reading it
 * never fails the caller: a check whose evidence GitHub would not give says why instead, and a commit status,
 * which has no check run, keeps only what it said of itself.
 */
export async function attachEvidence(
  api: EvidenceApi,
  repo: string,
  token: string,
  sha: string,
  reports: CheckReport[],
): Promise<FailedReport[]> {
  let runs: FailedRun[]
  try {
    runs = await api.failedChecks(repo, token, sha)
  } catch (error) {
    return reports.map((r) => ({ ...r, evidence: unreadable(error) }))
  }
  const attached: FailedReport[] = []
  for (const report of reports) {
    const run = runs.find((candidate) => candidate.name === report.name)
    attached.push(run ? { ...report, evidence: await evidenceOf(api, repo, token, run) } : report)
  }
  if (!attached.some(silent)) return attached
  const named = reports.map((r) => r.name)
  return [...attached, ...(await alongside(api, repo, token, runs, named))]
}
