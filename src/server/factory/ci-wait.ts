import type { CheckReport, PullRequestDetail } from '../github/pulls'

import type { FailedStep } from './promotion'
import type { HandoffCause } from './run-types'
import { AUTOMATIC_RETRIES, automaticRunsLeft } from './transitions'

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
export type ServerEvidence = { lines: string[]; step?: FailedStep } | { unreadable: string }

/**
 * A failed check as the note names it. A commit status has no check run, so it has no evidence. A check that
 * is `notRequired` failed on the same commit and is named because a required check (an aggregate job) said
 * only that something it depends on failed.
 */
export type FailedReport = CheckReport & {
  evidence?: ServerEvidence
  notRequired?: true
}

/** What to do about a task whose pull request waits for the repository's required checks. */
export type WaitingStep =
  /**
   * `baseRed` names the required checks that failed on the verified commit and fail on the head of the
   * integration branch too: the change did not cause them, so the task waits for the base, not for a fix.
   */
  | { kind: 'wait'; baseRed?: string[] }
  /**
   * A required check failed and the head of the integration branch must be read to tell whose failure it
   * is. Asked only then, so a base that cannot be read blocks no other step.
   */
  | { kind: 'needs_base' }
  /**
   * Every failed required check was blamed on the base, and the base passes them now. The pull request's
   * runs still carry the old failure and only a new commit runs them again, so a run merges the fixed base
   * into the task's branch with no agent (`mergeIntegration`), and that merge is verified and reviewed like
   * any work.
   */
  | { kind: 'merge_base'; checks: string[] }
  /** GitHub merged the verified commit: what follows a direct merge runs now. */
  | { kind: 'finish'; mergedSha: string }
  /**
   * A required check failed: the same agent works again on its branch, with a note on what each failed
   * check reported (`checksFeedback`) as feedback.
   */
  | { kind: 'send_back'; failed: string[]; reports: CheckReport[] }
  /**
   * The pull request conflicts with its base: the task runs again on its own branch, with a note, to merge
   * the new base into it. The approved work stays; the branch is not deleted.
   */
  | { kind: 'send_back_conflict'; reason: string }
  /**
   * Deleting the work branch closed the pull request, and nothing of the work is left to continue on: the
   * task starts over from the integration branch.
   */
  | { kind: 'start_over'; reason: string }
  /**
   * For a person. `cause` names a handoff the coordinator has a playbook for (`coordinator/exceptions.ts`): a pull
   * request that still conflicts, a base that passes again, checks that still fail. Any other is for a person only.
   */
  | {
      kind: 'person'
      reason: string
      stopAutoMerge: boolean
      reports?: CheckReport[]
      cause?: HandoffCause
    }
  /**
   * A promotion into the pre-release branch held the integration out and the hold expired: the verified
   * commit is integrated now, as the run would have done.
   */
  | { kind: 'integrate' }

export type WaitingIntegration = {
  /** The commit the factory verified and reviewed: the only one it lets merge. */
  verifiedSha: string
  pull: PullRequestDetail
  /** The checks the integration branch requires now. */
  required: string[]
  /** Every check reported on the verified commit. */
  reports: CheckReport[]
  /**
   * Every check reported on the head of the integration branch. Undefined until it was read, which is asked
   * for (`needs_base`) only when a required check failed.
   */
  baseReports?: CheckReport[]
  /**
   * The checks an earlier pass found red on the base while they failed on this verified commit, every one
   * of them. Their failure on the pull request stays the base's until the base passes them.
   */
  blamedOnBase: string[]
  /**
   * Whether the work branch no longer exists. Read only for a pull request closed without a merge, which
   * is what deleting the branch leaves behind; undefined when it was not read.
   */
  branchGone?: boolean
  /** How long the pull request has waited. */
  waitedMs: number
  /** Automatic runs since a person last started the task. */
  automaticRuns: number
  /**
   * Whether a promotion into the pre-release branch held the integration out (`task.integration_held`):
   * `holding` while the hold runs, `released` once it expired. Undefined for an integration never held.
   */
  held?: 'holding' | 'released'
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

/** Every run of a check that failed on the commit: two workflows may report the same name. */
const failedRuns = (reports: CheckReport[], name: string) =>
  reports.filter((r) => r.name === name && r.state === 'failure')

/**
 * What the required checks say: the ones that failed, and the ones that never reported. A check can run
 * more than once on a commit (a workflow on both `push` and `pull_request`), and GitHub blocks the merge
 * when any of those runs failed, so one failed run makes the check failed whatever the others say.
 */
export function readRequired(input: Pick<WaitingIntegration, 'required' | 'reports'>) {
  const failed: string[] = []
  const silent: string[] = []
  for (const name of input.required) {
    if (failedRuns(input.reports, name).length > 0) failed.push(name)
    else if (!input.reports.some((r) => r.name === name)) silent.push(name)
  }
  return { failed, silent }
}

/**
 * What the required checks of a commit say together, whatever the checks the branch does not require say:
 * `red` naming the ones that failed, `pending` while one runs or has not reported, `green` once each passed.
 */
export function requiredState(input: Pick<WaitingIntegration, 'required' | 'reports'>): {
  state: 'green' | 'red' | 'pending'
  failing: string[]
} {
  const { failed, silent } = readRequired(input)
  if (failed.length > 0) return { state: 'red', failing: failed }
  const running = input.reports.some(
    (r) => r.state === 'pending' && input.required.includes(r.name),
  )
  return { state: silent.length > 0 || running ? 'pending' : 'green', failing: [] }
}

/**
 * The next step for a pull request that waits for the repository's required checks. The factory only ever
 * lets GitHub merge the commit it verified; anything else (a new push, a closed pull request, auto-merge
 * turned off by somebody) goes to a person. A failed check and a conflict run again on their own, as many
 * times as an environment failure, then go to a person too. A failed check that fails on the head of the
 * integration branch too is the base's: the task waits, and once the base passes it the factory merges the
 * base into its branch, with no agent told to fix anything. A pull request a promotion held out has no
 * auto-merge yet: it waits while the hold runs and is integrated once it ends.
 */
export function decideWaitingIntegration(input: WaitingIntegration): WaitingStep {
  const runsLeft = automaticRunsLeft(input.automaticRuns)
  const { pull } = input
  if (
    input.branchGone &&
    runsLeft &&
    pull.state === 'closed' &&
    !pull.merged &&
    pull.headSha === input.verifiedSha
  ) {
    return { kind: 'start_over', reason: 'the work branch was deleted and the pull request closed' }
  }
  const done = settled(input)
  if (done) return done
  const runs = `${AUTOMATIC_RETRIES} automatic runs`
  if (input.pull.mergeableState === 'dirty') {
    return runsLeft
      ? { kind: 'send_back_conflict', reason: CONFLICTS_WITH_BASE }
      : {
          kind: 'person',
          reason: `${CONFLICTS_WITH_BASE} after ${runs}`,
          stopAutoMerge: true,
          cause: 'pull_conflict',
        }
  }
  if (input.held && !input.pull.autoMerge) {
    return input.held === 'holding' ? { kind: 'wait' } : { kind: 'integrate' }
  }
  if (!input.pull.autoMerge) {
    return {
      kind: 'person',
      reason: 'auto-merge was turned off on the pull request, so nothing will merge it',
      stopAutoMerge: false,
    }
  }
  return decideOnChecks(input, runsLeft, runs)
}

/** What the required checks of an open pull request with auto-merge on decide: see `decideWaitingIntegration`. */
function decideOnChecks(input: WaitingIntegration, runsLeft: boolean, runs: string): WaitingStep {
  const { failed, silent } = readRequired(input)
  // Whose failure it is needs the base, read only now: a base that cannot be read blocks no other step.
  if (failed.length > 0 && input.baseReports === undefined) return { kind: 'needs_base' }
  const blame = blameFailures(failed, input.baseReports ?? [], input.blamedOnBase, input.waitedMs)
  if (blame.own.length > 0) {
    const reports = blame.own.flatMap((name) => failedRuns(input.reports, name))
    if (!runsLeft) {
      return {
        kind: 'person',
        reason: `${CHECKS_STILL_FAIL} ${runs}: ${blame.own.join(', ')}`,
        stopAutoMerge: true,
        reports,
        cause: 'ci_red',
      }
    }
    return { kind: 'send_back', failed: blame.own, reports }
  }
  if (silent.length > 0 && input.waitedMs > CI_SILENCE_MS) {
    return {
      kind: 'person',
      reason: `the required check${silent.length === 1 ? '' : 's'} ${silent.join(', ')} never reported on ${short(input.verifiedSha)}: ${silent.length === 1 ? 'it' : 'they'} must run on pull requests into the integration branch`,
      stopAutoMerge: true,
    }
  }
  if (blame.red.length > 0) return { kind: 'wait', baseRed: blame.red }
  if (blame.fixed.length === 0 || blame.unsettled.length > 0) return { kind: 'wait' }
  return runsLeft
    ? { kind: 'merge_base', checks: blame.fixed }
    : {
        kind: 'person',
        reason: `${BASE_PASSES_AGAIN}${blame.fixed.join(', ')} again, and the pull request still has to merge it after ${runs}`,
        stopAutoMerge: true,
        cause: 'base_fixed',
      }
}

/**
 * Whose a failed required check is, by what the head of the integration branch says of the same check:
 * `red` when a run of it failed there too, `unsettled` while it runs there, while the base has no run of it
 * yet (or, once blamed, until it reports again), `fixed` when the base passes a check blamed on it before,
 * and `own` otherwise: the change's.
 *
 * A base with no run of the check says nothing about whose failure it is: a repository whose CI runs on a
 * pull request, and not on a push to the integration branch, has no run on its head until a promotion opens
 * from it. Such a check waits, up to `CI_SILENCE_MS` of the pull request's wait; after that the base will not
 * say, and the failure is the change's.
 */
type Blame = Record<'own' | 'red' | 'unsettled' | 'fixed', string[]>

function blameFailures(
  failed: string[],
  base: CheckReport[],
  blamed: string[],
  waitedMs: number,
): Blame {
  const blame: Blame = { own: [], red: [], unsettled: [], fixed: [] }
  for (const name of failed) blame[blameOf(base, blamed.includes(name), waitedMs, name)].push(name)
  return blame
}

function blameOf(
  base: CheckReport[],
  blamedBefore: boolean,
  waitedMs: number,
  name: string,
): keyof Blame {
  const runs = base.filter((r) => r.name === name)
  if (runs.some((r) => r.state === 'failure')) return 'red'
  if (runs.some((r) => r.state === 'pending')) return 'unsettled'
  if (runs.length > 0) return blamedBefore ? 'fixed' : 'own'
  return blamedBefore || waitedMs <= CI_SILENCE_MS ? 'unsettled' : 'own'
}

/**
 * How the reasons and notes this module writes start, so a reader of the record (the panel's `returned` mark)
 * can tell them apart from the text alone, as for a handoff recorded before it carried a `cause`.
 */
export const CONFLICTS_WITH_BASE = 'the pull request conflicts with its base'
export const CHECKS_STILL_FAIL = 'the required checks still fail after'
export const BASE_PASSES_AGAIN = 'the integration branch passes '
export const CHECKS_FEEDBACK_OPENING = "The repository's required checks failed on "

const NOT_THIS_CHANGE = "so the failure was not this change's."

/** Whether a run was opened by `fixedBaseNote`: it only merges the base, so the work it carries did not fail. */
export function isFixedBaseNote(note: unknown): boolean {
  return typeof note === 'string' && note.includes(NOT_THIS_CHANGE)
}

/**
 * What the task's record says when the checks its pull request failed were the base's and the base passes
 * them now: the factory merges the base into the branch itself (`mergeIntegration`), so the checks run again
 * on a commit that has the fix. No agent reads it, and nobody is told to fix anything.
 */
export function fixedBaseNote(base: string, checks: string[]): string {
  const one = checks.length === 1
  return [
    `The required check${one ? '' : 's'} ${checks.join(', ')} failed on this pull request while ${one ? 'it' : 'they'} failed on ${base} too, ${NOT_THIS_CHANGE}`,
    `${base} passes ${one ? 'it' : 'them'} now, and a check runs again only on a new commit.`,
    `The factory merges ${base} into this branch and checks and reviews the merge.`,
  ].join(' ')
}

const unread = (r: FailedReport) => r.evidence !== undefined && 'unreadable' in r.evidence

/** What the list of checks says of a check besides its name and link. */
const remarks = (r: FailedReport) =>
  (r.notRequired
    ? ' (not a required check: it failed on the same commit, where a required one names no failure of its own)'
    : '') + (unread(r) ? ' (the factory could not read its log or annotations)' : '')

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

/** The line that names the step that exited and what it ran, so the builder can run it in the sandbox. */
function stepLine(r: FailedReport): string {
  const step = r.evidence && 'lines' in r.evidence ? r.evidence.step : undefined
  if (!step) return ''
  const ran = step.command
    ? step.command !== step.name
      ? ` (ran: ${step.command})`
      : ''
    : ' (the command was not identified)'
  return `Step that exited: ${step.name}${ran}\n`.replace(/~{3,}/g, '~~')
}

/** What a note says after its list of checks: the quoted reports, for a handoff to carry the same evidence. */
export const evidenceOfNote = (note: string): string => {
  const [, ...quotes] = note.split('\n\n')
  return quotes.join('\n\n')
}

const said = (r: FailedReport) =>
  evidenceLines(r).length > 0 || r.detail.trim() !== '' || stepLine(r) !== ''

/**
 * The feedback a run gets when the repository's required checks failed: every check with its link, and what
 * each reported, cut so the whole note fits what a run takes. A check whose evidence the factory read on the
 * server is quoted from it, because the agent's sandbox cannot open the link; one whose evidence could not be
 * read says so, and the reason goes to the factory's log rather than to the agent.
 */
export function checksFeedback(sha: string, failed: FailedReport[]): string {
  const head = [
    `${CHECKS_FEEDBACK_OPENING}${short(sha)}, so the pull request was not merged. Fix what they report:`,
    ...failed.map((r) => `- ${r.name}: ${r.url}${remarks(r)}`),
  ].join('\n')
  // The reports that say something, in order; when they do not all fit, the last ones are left out (their
  // names and links stay in the list above) so the first keep their evidence and step.
  const told = failed.filter(said)
  const shareOf = (list: FailedReport[]) => {
    const frames = list.reduce((sum, r) => sum + r.name.length + FRAME + stepLine(r).length, 0)
    return Math.floor((NOTE_MAX - head.length - frames) / Math.max(list.length, 1))
  }
  while (told.length > 1 && shareOf(told) < TAIL_MIN) told.pop()
  const share = shareOf(told)
  if (share < TAIL_MIN) return head.slice(0, NOTE_MAX)
  const quotes = told.map((r) => {
    const text = quote(r, share)
    return `\n\n${r.name}:\n${stepLine(r)}${text === '' ? '' : `~~~~text\n${text}\n~~~~`}`
  })
  return head + quotes.join('')
}
