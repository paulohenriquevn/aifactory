import { createHash } from 'node:crypto'

import { INTEGRATION_BRANCH, PRE_RELEASE_BRANCH } from './branches'
import { versionBranchFor } from './changesets'

/** A pull request that promotes work one branch closer to a release. */
export type Promotion = { head: string; base: string }

/**
 * The promotion pull requests of a repository: the integration branch into the pre-release, the
 * pre-release into the release branch, and the Version Packages pull request of a repository that
 * publishes with changesets. A red check on any of them stops the release.
 */
export const promotionPullRequests = (releaseBranch: string): Promotion[] => [
  { head: INTEGRATION_BRANCH, base: PRE_RELEASE_BRANCH },
  { head: PRE_RELEASE_BRANCH, base: releaseBranch },
  { head: versionBranchFor(releaseBranch), base: releaseBranch },
]

/**
 * How many new issues one pass may open in one repository (`FACTORY_PROMOTION_ISSUES_PER_PASS`, three by
 * default). Zero turns the filing off and keeps the reruns.
 */
export function newIssuesCapFromEnv(env: NodeJS.ProcessEnv): number {
  const value = env.FACTORY_PROMOTION_ISSUES_PER_PASS ?? '3'
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `FACTORY_PROMOTION_ISSUES_PER_PASS must be a whole number of issues, got ${value}`,
    )
  }
  return Number(value)
}

/** A check that failed on a promotion's head commit, with what its log or annotations said. */
export type FailedCheck = { name: string; url: string; evidence: string[] }

const MAX_LINES = 40
const MAX_LINE = 300

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/
// Actions logs carry ANSI colors; logs shown by some tools write the escape as `^[`.
const COLORS = /(\u001b|\^\[)\[[0-9;]*m/g
const RUNNER_PATH = /^\/home\/runner\/work\/[^/]+\/[^/]+\//

/** Lines every failed job ends with, which say that something failed but not what. */
const GENERIC = [
  /Process completed with exit code/,
  /ELIFECYCLE/,
  /ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL/,
  /dependency did not succeed/,
]

/** Lines that say what failed: a test, an assertion, a type error, a lint rule. */
const TELLING = [
  /##\[error\]/,
  /\bFAIL\b/,
  /\b[A-Z]\w*Error\b:/,
  /\berror TS\d+/,
  /^[✖×]/,
  /^\d+:\d+\s+error\s/,
]

/** A heading under which knip and similar tools list what they found, one item per line. */
const LIST_HEADING = /^(Unused|Unlisted|Unresolved|Duplicate) .*\(\d+\)$/
const FILE_LINE = /^\/\S+\.\w+$/
const LINT_ERROR = /^\d+:\d+\s+error\s/

const clean = (raw: string) =>
  raw.replace(TIMESTAMP, '').replace(COLORS, '').replace('##[error]', '').trim()

/**
 * The lines of a job's log that say why it failed, read without a model: assertions, failing tests,
 * type and lint errors (with the file a lint error is in), and what a tool lists under a heading. At
 * most forty, each said once.
 */
export function logEvidence(log: string): string[] {
  const kept: string[] = []
  const keep = (line: string) => {
    const cut = line.slice(0, MAX_LINE)
    if (!kept.includes(cut)) kept.push(cut)
  }
  let file: string | undefined
  let listing = false
  for (const raw of log.split('\n')) {
    const line = clean(raw)
    if (listing && line !== '') {
      keep(line)
      continue
    }
    listing = LIST_HEADING.test(line)
    if (listing) keep(line)
    else if (FILE_LINE.test(line)) file = line.replace(RUNNER_PATH, '')
    else if (GENERIC.some((pattern) => pattern.test(line))) continue
    else if (TELLING.some((pattern) => pattern.test(line) || pattern.test(raw))) {
      if (file && LINT_ERROR.test(line)) keep(file)
      keep(line)
    }
  }
  return kept.slice(0, MAX_LINES)
}

/** The summary lines a check that is not an Actions job gives, after its annotations. */
const SUMMARY_LINES = 10

/**
 * The evidence of a check that is not an Actions job (CodeQL, Sonar): its annotations, then the first lines
 * of its summary, each said once, at most forty.
 */
export function checkEvidence(annotations: string[], summary: string): string[] {
  const told = summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, SUMMARY_LINES)
  const lines = [...annotations, ...told].map((line) => line.slice(0, MAX_LINE))
  return [...new Set(lines)].slice(0, MAX_LINES)
}

/** The comment on an open issue when the failure it is about comes back on a later commit. */
export const recurrenceComment = (check: FailedCheck, at: FailureAt): string =>
  `The same failure is back on \`${at.sha.slice(0, 7)}\`, the head of ${at.head} -> ${at.base} (#${at.pullRequest.number}): ${check.url}`

/**
 * What identifies a failure across commits: the check and its evidence, without the values a test makes
 * up on every run (quoted strings, numbers, hashes), in any order.
 */
export function findingSignature(check: string, evidence: string[]): string {
  const lines = evidence
    .map((line) =>
      line
        .replace(/'[^']*'|"[^"]*"/g, "''")
        .replace(/[0-9a-f]{6,}/gi, '#')
        .replace(/\d+/g, '#'),
    )
    .sort((a, b) => a.localeCompare(b))
  return createHash('sha256')
    .update([check, ...lines].join('\n'))
    .digest('hex')
    .slice(0, 16)
}

/**
 * A secret scanner reads every commit of the promotion, so one that flags a commit already in history
 * cannot be fixed by a change: the history is never rewritten. A person decides about it.
 */
export const needsPerson = (check: string): boolean => /trufflehog|gitleaks|secret/i.test(check)

/**
 * The failures worth an issue. A check that only says other jobs failed (a summary job) has no evidence
 * of its own, and is dropped when another failure says what went wrong.
 */
export function withEvidence<T extends FailedCheck>(checks: T[]): T[] {
  const telling = checks.filter((check) => check.evidence.length > 0)
  return telling.length > 0 ? telling : checks
}

/** Where a failure was seen. `rerun` is whether the job failed again after the watch reran it. */
export type FailureAt = {
  pullRequest: { number: number; url: string }
  head: string
  base: string
  sha: string
  rerun: boolean
}

export const issueTitle = (check: FailedCheck, at: FailureAt): string =>
  `promotion: \`${check.name}\` fails on ${at.head} -> ${at.base}`

/**
 * The issue for a failure, in the shape the factory's agents read: what failed, where, the evidence as
 * the log said it, and what done means. The evidence is text from the log, fenced so that nothing in it
 * can end the block.
 */
export function issueBody(check: FailedCheck, at: FailureAt): string {
  const person = needsPerson(check.name)
  const evidence =
    check.evidence.length > 0
      ? ['~~~~text', ...check.evidence.map((line) => line.replace(/~{3,}/g, '~~')), '~~~~']
      : ['No error line could be read from the log; open the run to see it.']
  return [
    '**Area:** promotion',
    `**Severity:** high (#${at.pullRequest.number} cannot merge, so \`${at.base}\` does not advance)`,
    '',
    '## Description',
    '',
    `The check \`${check.name}\` failed on the promotion ${at.head} -> ${at.base} (#${at.pullRequest.number}) at \`${at.sha.slice(0, 7)}\`${at.rerun ? ', and again after a rerun.' : '. It is not a GitHub Actions job, so it was not rerun.'}`,
    ...(person
      ? [
          '',
          'This check scans every commit of the promotion, including commits already in history, which are never rewritten. No change to the code can make it pass, so this issue has no `factory` label: a person decides.',
        ]
      : []),
    '',
    '## Evidence',
    '',
    `- Check: ${check.url}`,
    `- Pull request: ${at.pullRequest.url}`,
    '',
    ...evidence,
    '',
    '## Expected',
    '',
    `\`${check.name}\` passes on \`${at.head}\`.`,
    '',
    '## Acceptance',
    '',
    `- \`${check.name}\` passes on the promotion pull request.`,
    '- It passes because the cause is fixed: no test is skipped and no rule is turned off to get there.',
    '',
    '---',
    'Opened by the factory, which watches the promotion pull requests. The evidence is the CI log as it was.',
  ].join('\n')
}
