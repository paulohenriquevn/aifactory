import type { CheckReport, PullRequestDetail } from '../github/pulls'

import { AUTOMATIC_RETRIES } from './auto-retry'

/**
 * How long a required check may stay silent on the verified commit before a person is told. A check that
 * runs only on pushes, and never on a pull request into the integration branch, never reports at all, and
 * the pull request would wait forever.
 */
export const CI_SILENCE_MS = 6 * 60 * 60_000

/** The longest note a run takes as feedback, the same as a person's request for changes. */
const NOTE_MAX = 4_000
/** Below this much room for each check's report, the note lists the checks and their links only. */
const TAIL_MIN = 80
/** What surrounds a report in the note, besides the check's name: `\n\n`, `:\n`, `~~~~text\n` and `\n~~~~`. */
const FRAME = 18

/**
 * What the factory read on the server about a failed check run: the lines of its log (or its annotations and
 * summary) that say why it failed, or why they could not be read.
 */
export type ServerEvidence = { lines: string[] } | { unreadable: string }

/** A failed check as the note names it. A commit status has no check run, so it has no evidence. */
export type FailedReport = CheckReport & { evidence?: ServerEvidence }

/** What to do about a task whose pull request waits for the repository's required checks. */
export type WaitingStep =
  | { kind: 'wait' }
  /** GitHub merged the verified commit: what follows a direct merge runs now. */
  | { kind: 'finish'; mergedSha: string }
  /**
   * A required check failed: the same agent works again on its branch, with a note on what each failed
   * check reported (`checksFeedback`) as feedback.
   */
  | { kind: 'send_back'; failed: string[]; reports: CheckReport[] }
  /** The pull request conflicts with its base: the task starts again from the new base. */
  | { kind: 'start_over'; reason: string }
  | { kind: 'person'; reason: string; stopAutoMerge: boolean }

export type WaitingIntegration = {
  /** The commit the factory verified and reviewed: the only one it lets merge. */
  verifiedSha: string
  pull: PullRequestDetail
  /** The checks the integration branch requires now. */
  required: string[]
  /** Every check reported on the verified commit. */
  reports: CheckReport[]
  /** How long the pull request has waited. */
  waitedMs: number
  /** Automatic runs since a person last started the task. */
  automaticRuns: number
}

const short = (sha: string) => sha.slice(0, 7)

/** A pull request GitHub no longer merges on its own: merged, closed, moved past the verified commit. */
function settled(input: WaitingIntegration): WaitingStep | undefined {
  const { pull, verifiedSha } = input
  if (pull.merged && pull.headSha === verifiedSha) {
    // GitHub names the merge commit a moment after the merge.
    return pull.mergeCommitSha
      ? { kind: 'finish', mergedSha: pull.mergeCommitSha }
      : { kind: 'wait' }
  }
  if (pull.merged) {
    return {
      kind: 'person',
      reason: `the pull request was merged at ${short(pull.headSha)}, not at the verified ${short(verifiedSha)}: check what reached the integration branch`,
      stopAutoMerge: false,
    }
  }
  if (pull.state === 'closed') {
    return {
      kind: 'person',
      reason: 'the pull request was closed without being merged',
      stopAutoMerge: false,
    }
  }
  if (pull.headSha !== verifiedSha) {
    return {
      kind: 'person',
      reason: `${short(pull.headSha)} was pushed after the verified ${short(verifiedSha)}, and the factory merges only what it verified`,
      stopAutoMerge: true,
    }
  }
  return undefined
}

/** What the required checks say: the ones that failed, and the ones that never reported. */
export function readRequired(input: Pick<WaitingIntegration, 'required' | 'reports'>) {
  const failed: string[] = []
  const silent: string[] = []
  for (const name of input.required) {
    const seen = input.reports.find((r) => r.name === name)
    if (!seen) silent.push(name)
    else if (seen.state === 'failure') failed.push(name)
  }
  return { failed, silent }
}

/**
 * The next step for a pull request that waits for the repository's required checks. The factory only ever
 * lets GitHub merge the commit it verified; anything else (a new push, a closed pull request, auto-merge
 * turned off by somebody) goes to a person. A failed check and a conflict run again on their own, as many
 * times as an environment failure, then go to a person too.
 */
export function decideWaitingIntegration(input: WaitingIntegration): WaitingStep {
  const done = settled(input)
  if (done) return done
  const runsLeft = input.automaticRuns < AUTOMATIC_RETRIES
  const runs = `${AUTOMATIC_RETRIES} automatic runs`
  if (input.pull.mergeableState === 'dirty') {
    return runsLeft
      ? { kind: 'start_over', reason: 'the pull request conflicts with its base' }
      : {
          kind: 'person',
          reason: `the pull request conflicts with its base after ${runs}`,
          stopAutoMerge: true,
        }
  }
  if (!input.pull.autoMerge) {
    return {
      kind: 'person',
      reason: 'auto-merge was turned off on the pull request, so nothing will merge it',
      stopAutoMerge: false,
    }
  }
  const { failed, silent } = readRequired(input)
  if (failed.length > 0) {
    if (!runsLeft) {
      return {
        kind: 'person',
        reason: `the required checks still fail after ${runs}: ${failed.join(', ')}`,
        stopAutoMerge: true,
      }
    }
    const reports = failed.map((name) => input.reports.find((r) => r.name === name)!)
    return { kind: 'send_back', failed, reports }
  }
  if (silent.length > 0 && input.waitedMs > CI_SILENCE_MS) {
    return {
      kind: 'person',
      reason: `the required check${silent.length === 1 ? '' : 's'} ${silent.join(', ')} never reported on ${short(input.verifiedSha)}: ${silent.length === 1 ? 'it' : 'they'} must run on pull requests into the integration branch`,
      stopAutoMerge: true,
    }
  }
  return { kind: 'wait' }
}

const unread = (r: FailedReport) => r.evidence !== undefined && 'unreadable' in r.evidence

/** The lines read from the check's log or annotations, when the factory read any. */
const evidenceLines = (r: FailedReport) =>
  r.evidence && 'lines' in r.evidence ? r.evidence.lines : []

/**
 * What the note quotes of a check, in at most `share` characters: the first of the lines that say why it
 * failed, or else the end of what the check said of itself. Both are text from CI, so nothing in them may
 * end the block they are quoted in.
 */
function quote(r: FailedReport, share: number): string {
  const lines = evidenceLines(r)
  const text = lines.length > 0 ? lines.join('\n').slice(0, share) : r.detail.trim().slice(-share)
  return text.replace(/~{3,}/g, '~~')
}

const said = (r: FailedReport) => evidenceLines(r).length > 0 || r.detail.trim() !== ''

/**
 * The feedback a run gets when the repository's required checks failed: every check with its link, and what
 * each reported, cut so the whole note fits what a run takes. A check whose evidence the factory read on the
 * server is quoted from it, because the agent's sandbox cannot open the link; one whose evidence could not be
 * read says so, and the reason goes to the factory's log rather than to the agent.
 */
export function checksFeedback(sha: string, failed: FailedReport[]): string {
  const head = [
    `The repository's required checks failed on ${short(sha)}, so the pull request was not merged. Fix what they report:`,
    ...failed.map(
      (r) =>
        `- ${r.name}: ${r.url}${unread(r) ? ' (the factory could not read its log or annotations)' : ''}`,
    ),
  ].join('\n')
  const told = failed.filter(said)
  // Each report gets an equal share of what is left once its frame (`\n\n<name>:\n` and a fence) is counted.
  const frames = told.reduce((sum, r) => sum + r.name.length + FRAME, 0)
  const share = Math.floor((NOTE_MAX - head.length - frames) / Math.max(told.length, 1))
  if (share < TAIL_MIN) return head.slice(0, NOTE_MAX)
  const quotes = told.map((r) => `\n\n${r.name}:\n~~~~text\n${quote(r, share)}\n~~~~`)
  return head + quotes.join('')
}
