import type { COORDINATOR_ACTIONS, COORDINATOR_OUTCOMES } from '../db/schema'
import type { Bump } from '../factory/release'
import { conflictNote } from '../panel/actions'

import type { ExceptionKind, TaskException } from './exceptions'
import type { CoordinatorMode } from './mode'
import { bumpFor } from './release-train'
import type { ScopeDraft } from './scope'

/**
 * One action, from a closed set, for an exception of a task. A pure function of the exception and what the
 * coordinator already recorded for the task: it reads nothing and changes nothing, and `apply.ts` carries
 * out what it says.
 */

export type CoordinatorActionKind = (typeof COORDINATOR_ACTIONS)[number]
export type CoordinatorOutcome = (typeof COORDINATOR_OUTCOMES)[number]

/** A decision the coordinator already recorded for the task. */
export type RecordedAction = {
  exceptionKind: ExceptionKind
  headSha: string
  action: CoordinatorActionKind
  outcome: CoordinatorOutcome
}

export type Decision = {
  action: CoordinatorActionKind
  /** Why, as a person reads it. */
  reason: string
  /** The feedback a send-back gives the run. */
  note?: string
  /** The bump a release asks for (`release-train.ts`). */
  bump?: Bump
  /** The finding a retry resolves. */
  findingId?: number
  /** What the drafter wrote for a `scope`, filled by `draft.ts` after the decision. */
  draft?: ScopeDraft
  /** The drafter's answer when it did not parse, kept for a person to read. */
  answer?: string
  /** What drafting cost, in USD. */
  costUsd?: number
  /** Why drafting failed, when it threw: the action is then recorded as failed. */
  failure?: string
}

/** A task gets at most this many applied actions; the next exception stays with a person. */
export const MAX_APPLIED = 2

const short = (sha: string) => sha.slice(0, 7)

/**
 * Whether this exception already has a decision on this head: one exception, one decision per head. A trial
 * decision applied nothing, so in `auto` it leaves the head free; in `trial` it counts, or every pass would
 * record the same exception again.
 */
export const seen = (
  exception: TaskException,
  recorded: RecordedAction[],
  mode: CoordinatorMode,
): boolean =>
  recorded.some(
    (r) =>
      r.exceptionKind === exception.kind &&
      r.headSha === exception.head &&
      (mode === 'trial' || r.outcome !== 'trial'),
  )

const escalate = (reason: string): Decision => ({ action: 'escalate', reason })

function sendBack({ head, evidence, conflictsWith }: TaskException): Decision {
  const what = `the required checks failed on ${short(head)} and the last run changed nothing`
  if (conflictsWith !== undefined) {
    return {
      action: 'send_back',
      reason: `${what}, and its pull request conflicts with ${conflictsWith}: sent back on its branch to merge it`,
      note: conflictNote(conflictsWith),
    }
  }
  if (evidence === '') {
    return escalate(`${what}, but the handoff kept no output of the checks to send back`)
  }
  return {
    action: 'send_back',
    reason: `${what}: sent back on its branch with what the checks reported`,
    note: `The coordinator sent this back: the repository's required checks failed on ${short(head)} and the last run changed nothing. Fix what they report.\n\n${evidence}`,
  }
}

function retryFromFinding({ kind, evidence, findingId }: TaskException): Decision {
  const what = `the supervisor found the run ${kind} (${evidence})`
  if (findingId === undefined) return escalate(`${what}, but no finding was named to retry from`)
  return { action: 'retry_from_finding', findingId, reason: `${what}: retried from its finding` }
}

/** Releases the repository through `release()`, with the bump its issues allow. */
function releaseRepository({ kind, head, evidence, released }: TaskException): Decision {
  if (!released) return escalate(`${evidence}, but the issues it would release are not known`)
  const bump = bumpFor(released.map((issue) => issue.labels))
  const how =
    kind === 'release_retry'
      ? `the release on ${short(head)} was refused for a cause that ends by itself, so it is tried once more, as a ${bump}`
      : `released as a ${bump}`
  return { action: 'release', bump, reason: `${evidence}: ${how}` }
}

const BY_KIND: Partial<Record<ExceptionKind, (exception: TaskException) => Decision>> = {
  checks_unchanged: sendBack,
  review_plateau: ({ head, evidence }) => ({
    action: 'scope',
    reason: `the reviewer still asked for changes on ${short(head)} (${evidence}): the requests are scoped, the rest filed as a follow-up, and the task sent back on its branch`,
  }),
  review_unusable: ({ head, evidence }) => ({
    action: 'review_again',
    reason: `the review gave no usable verdict on ${short(head)} (${evidence}): the same branch runs again to be reviewed`,
  }),
  stalled: retryFromFinding,
  orphaned: retryFromFinding,
  environment: ({ evidence }) =>
    escalate(
      `the environment failed past its automatic retries (${evidence}): credentials, spend limits and the GitHub App are for a person`,
    ),
  unknown: ({ evidence }) => escalate(`the coordinator could not tell what is wrong: ${evidence}`),
  release_ready: releaseRepository,
  release_retry: releaseRepository,
  queue_blocked: ({ evidence }) => ({
    action: 'prioritise',
    reason: `${evidence}: its job goes ahead of the repository's other queued tasks`,
  }),
  release_blocked: ({ head, evidence }) =>
    escalate(
      `the release branch is red (${evidence}): the release train waits on ${short(head)} until it is green again, and a person looks at it`,
    ),
}

/** A release or a reordering is the repository's, not a rework of the task it is recorded on, so the limit does not count it. */
const RELEASE_KINDS: readonly ExceptionKind[] = [
  'release_ready',
  'release_retry',
  'release_blocked',
  'queue_blocked',
]

/** The one action for this exception, given what was already recorded for its task. */
export function decide(exception: TaskException, recorded: RecordedAction[]): Decision {
  const applied = recorded.filter(
    (r) => r.outcome === 'applied' && r.action !== 'release' && r.action !== 'prioritise',
  )
  if (!RELEASE_KINDS.includes(exception.kind) && applied.length >= MAX_APPLIED) {
    const tried = applied.map((r) => `${r.action} for ${r.exceptionKind} on ${short(r.headSha)}`)
    return escalate(
      `the coordinator already applied ${tried.join(', ')} on this task: a person decides what comes next`,
    )
  }
  const byKind = BY_KIND[exception.kind]
  if (byKind) return byKind(exception)
  return escalate(`the coordinator has no action for ${exception.kind} yet: ${exception.evidence}`)
}
