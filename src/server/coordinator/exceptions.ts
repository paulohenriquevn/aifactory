import type { EXCEPTION_KINDS, TaskStage } from '../db/schema'
import type { Read } from '../factory/doctor'
import type { HandoffCause } from '../factory/run-types'
import type { BaseHold } from '../factory/await-ci'
import { NO_TIME_FOR_AGENT } from '../factory/agent-time'
import { NO_CHANGE, NO_PULL_REQUEST } from '../factory/failure-reasons'
import { automaticRunsLeft } from '../factory/transitions'
import { AGENT_OUT_OF_TIME, retryableFailure } from '../../shared/panel'

/**
 * What the coordinator recognises as an exception of a task. Everything here decides over facts that
 * `exception-facts.ts` read, and reads nothing. A fact that could not be read is an exception of kind
 * `unknown`, never the absence of one.
 */

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number]

/** The event that put the task where it is: its stage, what the factory recorded with it and its id. */
export type LastEvent = { stage: TaskStage; detail: Record<string, unknown> | null; id?: number }

/** A check the factory ran on a commit of the task, as `evidence` keeps it. */
export type CheckRun = {
  name: string
  command: string
  sha: string
  passed: boolean
  output: string
}

/** The repository of a task and its integration branch. */
export type TaskRepository = { fullName: string; integrationBranch: string }

/** An open finding of the supervisor about a run of the task. */
export type OpenFinding = { id: number; kind: 'stalled' | 'orphaned'; detail: string }

/** What GitHub says of the pull request of a task: whether it conflicts with its base, and which base. */
export type PullRequestFacts = { conflicting: boolean; base: string; head?: string }

/** A check that failed on GitHub for the head of a pull request, with the lines its log or annotations gave. */
export type CiFailure = { name: string; url: string; lines: string[] }

/** What is known of one task when the coordinator looks at it. */
export type TaskFacts = {
  taskId: number
  stage: TaskStage
  headSha: string | null
  /** Its latest event, or null when it has none. */
  last: Read<LastEvent | null>
  /** The automatic runs since a person last started it. */
  automaticRuns: Read<number>
  findings: OpenFinding[]
  /**
   * Its pull request, read only for a handoff on failed checks, where the note depends on it: absent for any
   * other task, null for one with no pull request.
   */
  pullRequest?: Read<PullRequestFacts | null>
  /**
   * The hold a red integration branch puts on the task, read only for a task waiting for the integration
   * branch's checks: absent for any other task, null when nothing holds it.
   */
  baseHold?: Read<BaseHold | null>
  /** When the facts were read, which is what the age of a hold is measured against. */
  at?: Date
  /**
   * The checks the factory ran on the task, oldest first, read only where `readsChecks` says the exception
   * needs them: absent for any other task.
   */
  checks?: Read<CheckRun[]>
  /** Where the task's work integrates, which a fix of a red base is filed on. */
  repository?: TaskRepository
  /**
   * The checks that failed on GitHub for the head of the pull request, read only where `readsCiOutput` says
   * nothing else quoted them and the pull request merges cleanly: absent for any other task.
   */
  ciFailures?: Read<CiFailure[]>
}

/** An integration branch red this long while it holds a task is for a person. */
export const BASE_RED_LIMIT_MS = 30 * 60 * 1000

/** One exception: its kind, the task, the head it was seen on and what it was recognised by. */
export type TaskException = {
  kind: ExceptionKind
  taskId: number
  /** The task's head commit, or `none` for a task that never pushed. */
  head: string
  evidence: string
  /** The supervisor finding it came from. */
  findingId?: number
  /** The base its pull request conflicts with: the run must merge it before anything else. */
  conflictsWith?: string
  /** For a release of the repository: every issue it would release, with its labels, which set the bump. */
  released?: ReleasedIssue[]
  /** A release of a red release branch is allowed by the checks of this `develop` head: `release()` refuses another. */
  verifiedHead?: string
  /** The repository's release mode is `trial`: the decision is recorded and nothing is applied. */
  trialOnly?: true
  /** What the checks that fail on the task's head printed, for a send-back (`failingOutput`). */
  checkOutput?: string
  /** What the failed GitHub Actions jobs of the pull request's head logged, for a send-back (`ciFailingOutput`). */
  ciOutput?: string
  /** The files a merge of the integration branch with no agent conflicted in (`base_conflict`). */
  conflictFiles?: string[]
  /** The integration branch that is red, for the issue that fixes it. */
  base?: RedBase
  /** The builder's open question (`question`), which an answer of the unblocker answers. */
  questionId?: number
}

/** An integration branch whose checks fail: where, on which commit, and how to run them when that is known. */
export type RedBase = {
  repository: string
  branch: string
  sha: string
  checks: string[]
  commands: { name: string; command: string }[]
}

/** An issue whose integrated work a release of its repository carries. */
export type ReleasedIssue = { issue: number; labels: string[] }

/**
 * The causes the coordinator has a playbook for. Any other, as `agent_configuration`, is a plain `handoff`:
 * it is outside the coordinator's limits and goes to a person.
 */
const CAUSES = [
  'review_plateau',
  'review_unusable',
  'checks_unchanged',
] as const satisfies readonly HandoffCause[]

/** How a handoff recorded before it carried a `cause` says why, at the start of its reason (`Run`). */
const REASON_PREFIXES: [string, (typeof CAUSES)[number]][] = [
  ["the repository's required checks failed and the agent changed nothing", 'checks_unchanged'],
  ['the review gave no usable verdict', 'review_unusable'],
  ['the reviewer still asked for changes after', 'review_plateau'],
]

const FAILED_CHECKS = 'What the failed checks reported:\n\n'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Why a run handed its task over, from the handoff event; `handoff` when nothing says. */
export function causeOf(detail: Record<string, unknown> | null): ExceptionKind {
  const cause = CAUSES.find((known) => known === detail?.cause)
  if (cause) return cause
  const reason = text(detail?.reason)
  return REASON_PREFIXES.find(([prefix]) => reason.startsWith(prefix))?.[1] ?? 'handoff'
}

/** What a `checks_unchanged` reason quotes of the checks that failed, or nothing. */
export function failedChecksOutput(reason: string): string {
  const at = reason.indexOf(FAILED_CHECKS)
  return at < 0 ? '' : reason.slice(at + FAILED_CHECKS.length).trim()
}

/** How much of the checks' output a send-back quotes, shared between the checks that fail. */
export const CHECK_OUTPUT_MAX = 3_000

const fenced = (output: string, max: number) =>
  output.trim().replace(/~{3,}/g, '~~').slice(-max) || '(no output)'

/** What each check whose last run on `head` failed printed, with its command, the end of each kept. */
export function failingOutput(runs: CheckRun[], head: string): string {
  const last = new Map<string, CheckRun>()
  for (const run of runs) if (run.sha === head) last.set(run.name, run)
  const failing = [...last.values()].filter((run) => !run.passed)
  const share = Math.floor(CHECK_OUTPUT_MAX / Math.max(failing.length, 1))
  return failing
    .map((r) => `${r.name} (\`${r.command}\`):\n~~~~text\n${fenced(r.output, share)}\n~~~~`)
    .join('\n\n')
}

const fencedStart = (lines: string[], max: number) =>
  lines.join('\n').replace(/~{3,}/g, '~~').slice(0, max)

/**
 * What each failed check of the pull request's head said on GitHub, with its link, the first lines of each kept.
 * A check whose log or annotations said nothing is left out: its name alone gives the agent nothing to fix.
 */
export function ciFailingOutput(failures: CiFailure[]): string {
  const telling = failures.filter((f) => f.lines.length > 0)
  const share = Math.floor(CHECK_OUTPUT_MAX / Math.max(telling.length, 1))
  return telling
    .map((f) => `${f.name} (${f.url}):\n~~~~text\n${fencedStart(f.lines, share)}\n~~~~`)
    .join('\n\n')
}

/**
 * Whether failed checks handed over are read from GitHub Actions: only when neither the handoff nor the
 * factory's own checks on the head kept any output to send back.
 */
export function readsCiOutput(
  reason: string,
  facts: Pick<TaskFacts, 'checks' | 'headSha'>,
): boolean {
  if (failedChecksOutput(reason) !== '') return false
  const runs = facts.checks?.read ? facts.checks.value : []
  return failingOutput(runs, facts.headSha ?? '') === ''
}

/** Checks still red after the run's attempts, as the run says it: one of them `failed at` a commit. */
const CHECKS_RED = new RegExp(`^${NO_PULL_REQUEST}.*"[^"]*" failed at [0-9a-f]{7}`, 's')

/** The failures the coordinator has an action for, by how the run starts their reason. */
const FAILURE_CAUSES: [ExceptionKind, (error: string) => boolean][] = [
  ['checks_red', (error) => CHECKS_RED.test(error)],
  ['out_of_time', (error) => error.startsWith(NO_TIME_FOR_AGENT) || AGENT_OUT_OF_TIME.test(error)],
  ['no_change', (error) => error.startsWith(NO_CHANGE)],
]

/** What kind of failure a run's error is: one the coordinator acts on, or a plain `failure`. */
export function failureCause(error: string): ExceptionKind {
  return FAILURE_CAUSES.find(([, matches]) => matches(error))?.[0] ?? 'failure'
}

/** Whether recognising the exception of a task in `stage` needs the checks the factory ran on it. */
export function readsChecks(stage: TaskStage, detail: Record<string, unknown> | null): boolean {
  if (stage === 'handoff') return causeOf(detail) === 'checks_unchanged'
  if (stage !== 'failed') return false
  return failureCause(text(detail?.error)) === 'checks_red' || retryableFailure(detail) === 'base'
}

const unknown = (evidence: string) => ({ kind: 'unknown' as const, evidence })

type Found = Pick<
  TaskException,
  'kind' | 'evidence' | 'conflictsWith' | 'checkOutput' | 'ciOutput' | 'conflictFiles' | 'base'
> & {
  identity?: string
}

/** The event that put the task in its stage, or the unknown exception that stands for it. */
function lastOf(facts: TaskFacts): LastEvent | Found {
  if (!facts.last.read) return unknown(`could not read ${facts.last.tried}: ${facts.last.error}`)
  const last = facts.last.value
  if (!last) return unknown(`the task is in ${facts.stage}, and it has no event`)
  if (last.stage !== facts.stage) {
    return unknown(`the task is in ${facts.stage}, and its last event is ${last.stage}`)
  }
  return last
}

/** Failed checks the agent did not answer, with the base to merge when their pull request conflicts with it. */
function checksUnchanged(reason: string, facts: TaskFacts): Found {
  const { pullRequest, checks, ciFailures } = facts
  if (pullRequest && !pullRequest.read) {
    return unknown(`could not read ${pullRequest.tried}: ${pullRequest.error}`)
  }
  const found: Found = { kind: 'checks_unchanged', evidence: failedChecksOutput(reason) }
  const pull = pullRequest?.value
  if (pull?.conflicting) return { ...found, conflictsWith: pull.base }
  if (ciFailures && !ciFailures.read) {
    return unknown(`could not read ${ciFailures.tried}: ${ciFailures.error}`)
  }
  // The handoff may have kept no output: what the factory's own checks printed on the head stands in for it,
  // and what GitHub Actions logged for the pull request's head when the factory kept nothing either.
  const quoted = checks?.read
    ? { checkOutput: failingOutput(checks.value, facts.headSha ?? '') }
    : {}
  const logged = ciFailures ? { ciOutput: ciFailingOutput(ciFailures.value) } : {}
  return { ...found, ...quoted, ...logged }
}

function handedOver(last: LastEvent, facts: TaskFacts): Found {
  const kind = causeOf(last.detail)
  const reason = text(last.detail?.reason)
  if (kind === 'checks_unchanged') return checksUnchanged(reason, facts)
  return { kind, evidence: reason || 'the handoff recorded no reason' }
}

/**
 * A failure of the work by its cause, or a merge of the integration branch with no agent that conflicted. Those the
 * coordinator acts on are told apart by their event, since an
 * agent that is sent back and fails the same way on the same head is a second failure, not the first one again.
 */
function failedWork(error: string, last: LastEvent, facts: TaskFacts): Found {
  const conflict = baseConflictOf(last.detail)
  const kind = conflict ? 'base_conflict' : failureCause(error)
  if (kind === 'failure') return { kind, evidence: error }
  const identity =
    facts.headSha !== null && last.id !== undefined ? `${facts.headSha}@${last.id}` : undefined
  const found: Found = { kind, evidence: error, ...(identity ? { identity } : {}), ...conflict }
  if (kind !== 'checks_red') return found
  const checks = facts.checks
  if (checks && !checks.read) return unknown(`could not read ${checks.tried}: ${checks.error}`)
  return { ...found, checkOutput: failingOutput(checks?.value ?? [], facts.headSha ?? '') }
}

/** The red base of a task, when its repository is known, with the commands of its checks the task ran. */
function redBase(facts: TaskFacts, red: { sha: string; checks: string[] }): Pick<Found, 'base'> {
  if (!facts.repository) return {}
  const runs = facts.checks?.read ? facts.checks.value : []
  const command = new Map(runs.map((r) => [r.name, r.command]))
  const commands = red.checks.flatMap((name) => {
    const known = command.get(name)
    return known === undefined ? [] : [{ name, command: known }]
  })
  const { fullName, integrationBranch } = facts.repository
  const base: RedBase = { repository: fullName, branch: integrationBranch, ...red, commands }
  return { base }
}

/**
 * A merge of the integration branch with no agent that conflicted (`Run.mergeBase`), with the branch and the
 * files the run recorded; nothing when the failure names no branch.
 */
function baseConflictOf(detail: Record<string, unknown> | null) {
  const conflict = detail?.baseConflict as { branch?: unknown; files?: unknown } | undefined
  if (typeof conflict?.branch !== 'string') return undefined
  const files = Array.isArray(conflict.files)
    ? conflict.files.filter((f): f is string => typeof f === 'string')
    : []
  return { conflictsWith: conflict.branch, conflictFiles: files }
}

const baseRedOf = (detail: Record<string, unknown> | null) =>
  detail?.baseRed as { sha: string; checks: string[] }

/**
 * A failure that passes by itself (a quota, a blocker, an environment or a red base with retries left) is none.
 * Checks that still fail on the integration branch once the retries are over are a `base_red`, for a person.
 */
function failed(last: LastEvent, facts: TaskFacts): Found | undefined {
  const { automaticRuns } = facts
  const error = text(last.detail?.error) || 'the failure recorded no error'
  const retryable = retryableFailure(last.detail)
  if (retryable === null) return failedWork(error, last, facts)
  if (retryable !== 'environment' && retryable !== 'base') return undefined
  if (!automaticRuns.read) {
    return unknown(`could not read ${automaticRuns.tried}: ${automaticRuns.error}`)
  }
  if (automaticRunsLeft(automaticRuns.value)) return undefined
  if (retryable === 'environment') return { kind: 'environment', evidence: error }
  return { kind: 'base_red', evidence: error, ...redBase(facts, baseRedOf(last.detail)) }
}

const isFound = (value: LastEvent | Found): value is Found => 'kind' in value

/** What the stage of the task says is wrong with it. */
function ofStage(facts: TaskFacts): Found | undefined {
  if (facts.stage !== 'handoff' && facts.stage !== 'failed') return undefined
  const last = lastOf(facts)
  if (isFound(last)) return last
  return facts.stage === 'handoff' ? handedOver(last, facts) : failed(last, facts)
}

const short = (sha: string) => sha.slice(0, 7)

/** What a red integration branch does to the task: nothing before the limit, an exception after it. */
function ofBase(facts: TaskFacts): Found | undefined {
  const read = facts.baseHold
  if (!read) return undefined
  if (!read.read) return unknown(`could not read ${read.tried}: ${read.error}`)
  const hold = read.value
  if (!hold) return undefined
  const since = Date.parse(hold.since)
  const red = (facts.at ?? new Date()).getTime() - since
  if (red < BASE_RED_LIMIT_MS) return undefined
  const minutes = Math.floor(red / 60_000)
  const forHow = minutes < 120 ? `${minutes} minutes` : `${Math.floor(minutes / 60)} hours`
  return {
    kind: 'base_red',
    evidence: `the integration branch has been red for ${forHow} on ${hold.checks.join(', ')}, and the task waits for ${hold.checks.length === 1 ? 'it' : 'them'} to pass there`,
    // The start is part of it: a hold that cleared and came back on the same commit is another hold.
    identity: `${short(hold.sha)}:${hold.checks.join(',')}@${hold.since}`,
    ...redBase({ ...facts, checks: undefined }, { sha: hold.sha, checks: hold.checks }),
  }
}

/** Every exception of a task: one for each open finding, and one for its stage or its hold when it has one. */
export function recognise(facts: TaskFacts): TaskException[] {
  const at = { taskId: facts.taskId, head: facts.headSha ?? 'none' }
  const fromFindings = facts.findings.map((f) => ({
    kind: f.kind,
    ...at,
    evidence: f.detail,
    findingId: f.id,
  }))
  const found = ofStage(facts) ?? ofBase(facts)
  if (!found) return fromFindings
  const { identity, ...rest } = found
  return [...fromFindings, { ...rest, ...at, ...(identity ? { head: identity } : {}) }]
}
