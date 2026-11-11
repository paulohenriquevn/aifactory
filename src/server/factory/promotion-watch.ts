import { and, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { promotionFinding, repository } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { IssuesApi } from '../github/issues-api'
import type { PromotionApi, PromotionPull } from '../github/promotion-api'
import type { GithubApi } from '../github/pulls'
import { FACTORY_LABEL } from '../ingest/decide'

import {
  checkEvidence,
  findingSignature,
  issueBody,
  issueTitle,
  logEvidence,
  needsPerson,
  promotionPullRequests,
  recurrenceComment,
  withEvidence,
  type FailedCheck,
  type FailureAt,
} from './promotion'

export type PromotionWatchDeps = {
  db: Database
  app: GithubApp
  api: PromotionApi
  github: Pick<GithubApi, 'defaultBranch' | 'commentOnIssue'>
  issues: Pick<IssuesApi, 'createIssue' | 'ensureLabel'>
  /** New issues one pass may open in one repository, so a broken pipeline does not flood the tracker. */
  maxNewIssuesPerRepository: number
}

export type PromotionWatchResult = {
  /** Workflow runs whose failed jobs were run again before they count. */
  reruns: number
  opened: string[]
  commented: string[]
  /** New failures left for a later pass because the cap was reached. */
  capped: number
  errors: string[]
}

/** A failed check with its evidence, and whether it failed again after a rerun. */
type Seen = FailedCheck & { rerun: boolean }

/** One repository in one pass: where to write, and how many issues it opened so far. */
type Pass = {
  deps: PromotionWatchDeps
  repo: string
  token: string
  result: PromotionWatchResult
  opened: number
}

/**
 * Looks at the open promotion pull requests of every enabled repository. A check that failed on a head
 * commit becomes an issue the factory's agents fix (or, for what no change can fix, an issue for a person),
 * once: the same failure later is a comment on its issue. An Actions job is rerun once before it counts.
 * Nothing in here reads a log with a model, and nothing merges.
 */
export async function pollPromotions(deps: PromotionWatchDeps): Promise<PromotionWatchResult> {
  const result: PromotionWatchResult = {
    reruns: 0,
    opened: [],
    commented: [],
    capped: 0,
    errors: [],
  }
  const repositories = await deps.db
    .select({ fullName: repository.fullName, releaseBranch: repository.releaseBranch })
    .from(repository)
    .where(eq(repository.enabled, true))
  for (const row of repositories) {
    try {
      await watchRepository(deps, row, result)
    } catch (error) {
      result.errors.push(
        `${row.fullName}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return result
}

async function watchRepository(
  deps: PromotionWatchDeps,
  row: { fullName: string; releaseBranch: string | null },
  result: PromotionWatchResult,
) {
  const { token } = await deps.app.installationToken(row.fullName)
  const release = row.releaseBranch ?? (await deps.github.defaultBranch(row.fullName, token))
  const pass: Pass = { deps, repo: row.fullName, token, result, opened: 0 }
  for (const promotion of promotionPullRequests(release)) {
    const pull = await deps.api.openPullRequest(row.fullName, token, promotion.head, promotion.base)
    if (!pull) continue
    for (const check of withEvidence(await failuresOf(pass, pull.headSha))) {
      await report(pass, check, at(pull, promotion, check.rerun))
    }
  }
}

const at = (
  pull: PromotionPull,
  promotion: { head: string; base: string },
  rerun: boolean,
): FailureAt => ({
  pullRequest: { number: pull.number, url: pull.url },
  head: promotion.head,
  base: promotion.base,
  sha: pull.headSha,
  rerun,
})

/**
 * The checks that failed on a commit, with their evidence. An Actions job on its first attempt is not one
 * yet: its run is rerun (once, however many of its jobs failed) and a later pass reads the second attempt.
 */
async function failuresOf(pass: Pass, sha: string): Promise<Seen[]> {
  const { api } = pass.deps
  const rerunNow = new Set<number>()
  const seen: Seen[] = []
  for (const run of await api.failedChecks(pass.repo, pass.token, sha)) {
    const check = { name: run.name, url: run.url }
    if (!run.actions) {
      const annotations = await api.annotations(pass.repo, pass.token, run.id)
      seen.push({ ...check, evidence: checkEvidence(annotations, run.summary), rerun: false })
      continue
    }
    const job = await api.jobAttempt(pass.repo, pass.token, run.id)
    if (job.attempt >= 2) {
      const log = await api.jobLog(pass.repo, pass.token, run.id)
      seen.push({ ...check, evidence: logEvidence(log), rerun: true })
    } else if (!rerunNow.has(job.runId)) {
      rerunNow.add(job.runId)
      await api.rerunFailedJobs(pass.repo, pass.token, job.runId)
      pass.result.reruns++
    }
  }
  return seen
}

/** Files a failure once: a new one opens an issue, a known one on a new commit comments or opens again. */
async function report(pass: Pass, check: FailedCheck, where: FailureAt) {
  const signature = findingSignature(check.name, check.evidence)
  const [known] = await pass.deps.db
    .select()
    .from(promotionFinding)
    .where(
      and(
        eq(promotionFinding.repository, pass.repo),
        eq(promotionFinding.checkName, check.name),
        eq(promotionFinding.signature, signature),
      ),
    )
  if (!known) return fileNew(pass, check, where, signature)
  if (known.issueNumber === null || known.lastSha === where.sha) return
  const open = await pass.deps.api.issueOpen(pass.repo, pass.token, known.issueNumber)
  if (open) return commentAgain(pass, check, where, { ...known, issueNumber: known.issueNumber })
  return fileAgain(pass, check, where, known)
}

const capReached = (pass: Pass) => {
  if (pass.opened < pass.deps.maxNewIssuesPerRepository) return false
  pass.result.capped++
  return true
}

async function fileNew(pass: Pass, check: FailedCheck, where: FailureAt, signature: string) {
  if (capReached(pass)) return
  // Taken before the issue is opened, so that two passes cannot open two.
  const [claim] = await pass.deps.db
    .insert(promotionFinding)
    .values({
      repository: pass.repo,
      checkName: check.name,
      signature,
      forFactory: !needsPerson(check.name),
      lastSha: where.sha,
    })
    .onConflictDoNothing()
    .returning({ id: promotionFinding.id })
  if (!claim) return
  try {
    await openIssue(pass, check, where, claim.id)
  } catch (error) {
    await pass.deps.db.delete(promotionFinding).where(eq(promotionFinding.id, claim.id))
    throw error
  }
}

type Known = { id: number; lastSha: string }

/** Moves the finding to the new commit, unless another pass already did. False when it did. */
async function takeCommit(pass: Pass, known: Known, sha: string): Promise<boolean> {
  const taken = await pass.deps.db
    .update(promotionFinding)
    .set({ lastSha: sha, updatedAt: new Date() })
    .where(and(eq(promotionFinding.id, known.id), eq(promotionFinding.lastSha, known.lastSha)))
    .returning({ id: promotionFinding.id })
  return taken.length > 0
}

const giveCommitBack = (pass: Pass, known: Known) =>
  pass.deps.db
    .update(promotionFinding)
    .set({ lastSha: known.lastSha })
    .where(eq(promotionFinding.id, known.id))

async function commentAgain(
  pass: Pass,
  check: FailedCheck,
  where: FailureAt,
  known: Known & { issueNumber: number },
) {
  if (!(await takeCommit(pass, known, where.sha))) return
  try {
    await pass.deps.github.commentOnIssue(
      pass.repo,
      pass.token,
      known.issueNumber,
      recurrenceComment(check, where),
    )
  } catch (error) {
    await giveCommitBack(pass, known)
    throw error
  }
  pass.result.commented.push(`${pass.repo}#${known.issueNumber}`)
}

/** The failure is back after its issue was closed: the fix did not hold, so it gets a new issue. */
async function fileAgain(pass: Pass, check: FailedCheck, where: FailureAt, known: Known) {
  if (capReached(pass)) return
  if (!(await takeCommit(pass, known, where.sha))) return
  try {
    await openIssue(pass, check, where, known.id)
  } catch (error) {
    await giveCommitBack(pass, known)
    throw error
  }
}

async function openIssue(pass: Pass, check: FailedCheck, where: FailureAt, findingId: number) {
  const forFactory = !needsPerson(check.name)
  const { deps, repo, token } = pass
  if (forFactory) {
    await deps.issues.ensureLabel(repo, token, {
      name: FACTORY_LABEL,
      color: '5319e7',
      description: 'The factory builds this issue',
    })
  }
  const issue = await deps.issues.createIssue(repo, token, {
    title: issueTitle(check, where),
    body: issueBody(check, where),
    labels: forFactory ? [FACTORY_LABEL] : [],
  })
  await deps.db
    .update(promotionFinding)
    .set({ issueNumber: issue.number, issueUrl: issue.url, updatedAt: new Date() })
    .where(eq(promotionFinding.id, findingId))
  pass.opened++
  pass.result.opened.push(issue.url)
}
