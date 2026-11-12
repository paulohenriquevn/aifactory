import type { FailedRun, PromotionApi } from '../github/promotion-api'
import type { CheckReport } from '../github/pulls'

import type { FailedReport, ServerEvidence } from './ci-wait'
import { checkEvidence, logEvidence } from './promotion'

/** What reading a failed check's evidence takes from GitHub, with a repository-scoped token. */
export type EvidenceApi = Pick<PromotionApi, 'failedChecks' | 'jobLog' | 'annotations'>

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

const unreadable = (error: unknown): ServerEvidence => ({
  unreadable: error instanceof Error ? error.message : String(error),
})

/**
 * The failed required checks of a commit, each with the evidence of the check run that has its name. Reading
 * it never fails the caller: a check whose evidence GitHub would not give says why instead, and a commit
 * status, which has no check run, keeps only what it said of itself.
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
    if (!run) {
      attached.push(report)
      continue
    }
    try {
      attached.push({ ...report, evidence: { lines: await readEvidence(api, repo, token, run) } })
    } catch (error) {
      attached.push({ ...report, evidence: unreadable(error) })
    }
  }
  return attached
}
