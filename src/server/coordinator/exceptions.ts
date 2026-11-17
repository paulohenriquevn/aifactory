import type { EXCEPTION_KINDS, TaskStage } from '../db/schema'
import type { Read } from '../factory/doctor'
import type { HandoffCause } from '../factory/run-types'
import { automaticRunsLeft } from '../factory/transitions'
import { retryableFailure } from '../../shared/panel'

/**
 * What the coordinator recognises as an exception of a task. Everything here decides over facts that
 * `exception-facts.ts` read, and reads nothing. A fact that could not be read is an exception of kind
 * `unknown`, never the absence of one.
 */

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number]

/** The event that put the task where it is: its stage and what the factory recorded with it. */
export type LastEvent = { stage: TaskStage; detail: Record<string, unknown> | null }

/** An open finding of the supervisor about a run of the task. */
export type OpenFinding = { id: number; kind: 'stalled' | 'orphaned'; detail: string }

/** What GitHub says of the pull request of a task: whether it conflicts with its base, and which base. */
export type PullRequestFacts = { conflicting: boolean; base: string }

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
}

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
  /** The repository's release mode is `trial`: the decision is recorded and nothing is applied. */
  trialOnly?: true
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

const unknown = (evidence: string) => ({ kind: 'unknown' as const, evidence })

type Found = Pick<TaskException, 'kind' | 'evidence' | 'conflictsWith'>

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
function checksUnchanged(reason: string, pullRequest: TaskFacts['pullRequest']): Found {
  if (pullRequest && !pullRequest.read) {
    return unknown(`could not read ${pullRequest.tried}: ${pullRequest.error}`)
  }
  const found: Found = { kind: 'checks_unchanged', evidence: failedChecksOutput(reason) }
  const pull = pullRequest?.value
  return pull?.conflicting ? { ...found, conflictsWith: pull.base } : found
}

function handedOver(last: LastEvent, pullRequest: TaskFacts['pullRequest']): Found {
  const kind = causeOf(last.detail)
  const reason = text(last.detail?.reason)
  if (kind === 'checks_unchanged') return checksUnchanged(reason, pullRequest)
  return { kind, evidence: reason || 'the handoff recorded no reason' }
}

/** A failure that passes by itself (a quota, a blocker, an environment with retries left) is none. */
function failed(last: LastEvent, automaticRuns: Read<number>): Found | undefined {
  const error = text(last.detail?.error) || 'the failure recorded no error'
  const retryable = retryableFailure(last.detail)
  if (retryable === null) return { kind: 'failure', evidence: error }
  if (retryable !== 'environment') return undefined
  if (!automaticRuns.read) {
    return unknown(`could not read ${automaticRuns.tried}: ${automaticRuns.error}`)
  }
  return automaticRunsLeft(automaticRuns.value)
    ? undefined
    : { kind: 'environment', evidence: error }
}

const isFound = (value: LastEvent | Found): value is Found => 'kind' in value

/** What the stage of the task says is wrong with it. */
function ofStage(facts: TaskFacts): Found | undefined {
  if (facts.stage !== 'handoff' && facts.stage !== 'failed') return undefined
  const last = lastOf(facts)
  if (isFound(last)) return last
  return facts.stage === 'handoff'
    ? handedOver(last, facts.pullRequest)
    : failed(last, facts.automaticRuns)
}

/** Every exception of a task: one for each open finding, and one for its stage when it has one. */
export function recognise(facts: TaskFacts): TaskException[] {
  const at = { taskId: facts.taskId, head: facts.headSha ?? 'none' }
  const fromFindings = facts.findings.map((f) => ({
    kind: f.kind,
    ...at,
    evidence: f.detail,
    findingId: f.id,
  }))
  const stage = ofStage(facts)
  return stage ? [...fromFindings, { ...stage, ...at }] : fromFindings
}
