import type { Read } from '../factory/doctor'
import type { ReleaseMode } from '../factory/deliver'
import type { Bump } from '../factory/release'

import type { CoordinatorOutcome } from './decide'
import type { ExceptionKind, ReleasedIssue, TaskException } from './exceptions'

/**
 * The release train of ADR 0010, as the coordinator's `release_ready` playbook: when a repository is ready
 * for a release, which bump it takes, and which refusal is tried once more. Everything here decides over
 * facts `release-facts.ts` read, and reads nothing. A repository is not a task, so its exception is recorded
 * on its oldest task with integrated work, keyed by the head of the pre-release branch.
 */

/** Who the train releases as: an agent, so a release it starts is never counted as a person's decision. */
export const COORDINATOR_ACTOR = 'agent:coordinator'

/** How the release branch looks to `watch-main`: its last release still watched, red, or neither. */
export type ReleaseBranchState = 'green' | 'watching' | 'red'

/**
 * A release decision (`release_ready` or `release_retry`) already recorded for the repository on the current
 * head, in the order recorded, trial ones left out.
 */
export type ReleaseAttempt = {
  kind: ExceptionKind
  outcome: CoordinatorOutcome
  reason: string
}

/** What is known of one repository when the train looks at it. */
export type RepositoryReleaseFacts = {
  repository: string
  /** Its release mode, or the factory's default when it has none. */
  mode: ReleaseMode
  /**
   * Its tasks with work that no release holds (`done` with a merge, or resolved elsewhere at a commit),
   * integrated ones first, then oldest first.
   */
  releasable: { taskId: number; issueNumber: number; resolvedSha?: string }[]
  /** Its tasks queued, running or waiting for the integration branch's checks. */
  working: number
  /** A release or a publication of the repository that has not finished, said as a person reads it. */
  inFlight: string | undefined
  branch: { state: ReleaseBranchState; detail: string }
  /** The facts below are read only when the train does not hold the repository (`trainHolds`). */
  head?: Read<string>
  /**
   * How many commits the pre-release branch holds that the release branch lacks, read with its head. None
   * means integrated work has not been promoted into it yet, so there is nothing to release.
   */
  ahead?: number
  attempts?: ReleaseAttempt[]
  /** Why the release that waited for the release branch's checks on this head was refused, if it was. */
  waitRefusal?: string
  labels?: Read<ReleasedIssue[]>
}

/** Labels that make an issue a feature, which bumps the minor version. */
const FEATURE_LABELS = ['enhancement', 'feature']
/** The one label that allows a major version. */
const BREAKING_LABEL = 'breaking'

const carries = (labels: string[], wanted: string[]) =>
  labels.some((label) => wanted.includes(label.toLowerCase()))

/**
 * The bump of a release that carries issues with these labels: major only when one is labelled `breaking`,
 * minor when one is a feature (`enhancement` or `feature`), patch otherwise. A changesets repository ignores
 * it: its changesets set the versions.
 */
export function bumpFor(labelsPerIssue: string[][]): Bump {
  if (labelsPerIssue.some((labels) => carries(labels, [BREAKING_LABEL]))) return 'major'
  if (labelsPerIssue.some((labels) => carries(labels, FEATURE_LABELS))) return 'minor'
  return 'patch'
}

/**
 * Refusals whose cause ends by itself: required checks that are still expected, running or never reported
 * on the commit, a release that already waits for them, and a head that moved between the look and the merge.
 */
const PASSING_CAUSES = [
  /never reported on/,
  /required status checks?\b[^.]*\b(expected|in progress|pending)/i,
  /already waits for the checks of/,
  /(head|base) branch was modified/i,
  /moved to \S+ after the release was asked for/,
]

/** Whether a refused release may be tried once more on the same head, because its cause ends by itself. */
export const passingRefusal = (reason: string): boolean =>
  PASSING_CAUSES.some((cause) => cause.test(reason))

/**
 * Whether the train leaves the repository alone without reading anything more: a `manual` repository, no
 * integrated work to release, a task still working on what would join it, a release still in flight, or the
 * last release still watched on the release branch.
 */
export const trainHolds = (f: RepositoryReleaseFacts): boolean =>
  f.mode === 'manual' ||
  f.releasable.length === 0 ||
  f.working > 0 ||
  f.inFlight !== undefined ||
  f.branch.state === 'watching'

const short = (sha: string) => sha.slice(0, 7)

/**
 * The attempt the train makes next on this head, given the release decisions already recorded on it: the
 * release when none was made, the one retry when the release was refused for a cause that ends by itself
 * (at once, or later while it waited for the release branch's checks), or none.
 */
function nextAttempt(attempts: ReleaseAttempt[], waitRefusal: string | undefined) {
  const [first] = attempts
  if (!first) return 'release_ready' as const
  if (attempts.some((a) => a.kind === 'release_retry')) return undefined
  const refusal = first.outcome === 'applied' ? waitRefusal : first.reason
  return passingRefusal(refusal ?? '') ? ('release_retry' as const) : undefined
}

/** A read that failed, or one that was never made, said as a person reads it. */
const notRead = (read: Read<unknown> | undefined, what: string) =>
  read?.read === false ? `could not read ${read.tried}: ${read.error}` : `${what}: never read`

const unknown = (taskId: number, head: string, evidence: string) => ({
  kind: 'unknown' as const,
  taskId,
  head,
  evidence,
})

/**
 * The release the train would attempt next on the head it read, or none: what decides whether the labels of
 * the issues are worth reading at all.
 */
export function attemptDue(f: RepositoryReleaseFacts) {
  if (trainHolds(f) || !f.head?.read || f.ahead === 0 || f.branch.state === 'red') return undefined
  return nextAttempt(f.attempts ?? [], f.waitRefusal)
}

/** The repository's release exception, on its oldest task with integrated work, or none. */
export function recogniseRelease(f: RepositoryReleaseFacts): TaskException | undefined {
  if (trainHolds(f)) return undefined
  const taskId = f.releasable[0].taskId
  if (!f.head?.read)
    return unknown(taskId, 'none', notRead(f.head, 'the head of the pre-release branch'))
  if (f.ahead === 0) return undefined
  const head = f.head.value
  const at = { taskId, head, ...(f.mode === 'trial' ? { trialOnly: true as const } : {}) }
  if (f.branch.state === 'red') return { kind: 'release_blocked', ...at, evidence: f.branch.detail }
  const kind = attemptDue(f)
  if (!kind) return undefined
  if (!f.labels?.read) return unknown(taskId, head, notRead(f.labels, 'the labels of the issues'))
  const issues = f.releasable.map((t) => `#${t.issueNumber}`).join(', ')
  return {
    kind,
    ...at,
    evidence: `${f.releasable.length} integrated issues wait for a release of ${f.repository} at ${short(head)}: ${issues}`,
    released: f.labels.value,
  }
}
