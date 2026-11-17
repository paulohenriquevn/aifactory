import type { CheckReport, PullRequestDetail } from '../github/pulls'

import { CI_SILENCE_MS, readRequired } from './ci-wait'

/** What to do about a release whose pull request waits for the release branch's required checks. */
export type ReleaseStep =
  | { kind: 'wait' }
  /** GitHub merged the pinned commit: the release finishes as a direct merge does. */
  | { kind: 'finish'; mergeSha: string }
  /**
   * The release does not happen. A release is never retried on its own: what the release pull request
   * carries is everything on the pre-release branch, so a person looks at it and asks again.
   */
  | { kind: 'refuse'; reason: string; stopAutoMerge: boolean; failed?: string[] }

export type WaitingRelease = {
  /** The head of the release pull request when the release was asked for: the only one GitHub may merge. */
  pinnedSha: string
  /** The branch the release lands on, for the reasons. */
  releaseBranch: string
  pull: PullRequestDetail
  /** The checks the release branch requires now. */
  required: string[]
  /** Every check reported on the pinned commit. */
  reports: CheckReport[]
  /** How long the release has waited. */
  waitedMs: number
}

const short = (sha: string) => sha.slice(0, 7)

const refuse = (reason: string, stopAutoMerge: boolean): ReleaseStep => ({
  kind: 'refuse',
  reason,
  stopAutoMerge,
})

/** A release pull request GitHub no longer merges on its own: merged, closed, moved past the pinned head. */
function settled(input: WaitingRelease): ReleaseStep | undefined {
  const { pull, pinnedSha, releaseBranch } = input
  if (pull.merged && pull.headSha === pinnedSha) {
    // GitHub names the merge commit a moment after the merge.
    return pull.mergeCommitSha
      ? { kind: 'finish', mergeSha: pull.mergeCommitSha }
      : { kind: 'wait' }
  }
  if (pull.merged) {
    return refuse(
      `the release pull request was merged at ${short(pull.headSha)}, not at ${short(pinnedSha)} that the release was asked for: check what reached ${releaseBranch}`,
      false,
    )
  }
  if (pull.state === 'closed') {
    return refuse('the release pull request was closed without being merged', false)
  }
  if (pull.headSha !== pinnedSha) {
    return refuse(
      `the pre-release branch moved to ${short(pull.headSha)} after the release was asked for at ${short(pinnedSha)}: ask for the release again to promote what is there now`,
      true,
    )
  }
  return undefined
}

/**
 * The next step for a release whose pull request waits for the release branch's required checks. GitHub
 * merges it through auto-merge, pinned to the head the release was asked for; anything else (a failed
 * check, a new push to the pre-release branch, a conflict, auto-merge turned off, a check that never
 * reports) refuses the release, with the reason, for a person to see.
 */
export function decideWaitingRelease(input: WaitingRelease): ReleaseStep {
  const done = settled(input)
  if (done) return done
  const branch = input.releaseBranch
  if (input.pull.mergeableState === 'dirty') {
    return refuse(`the release pull request conflicts with ${branch}`, true)
  }
  if (!input.pull.autoMerge) {
    return refuse(
      'auto-merge was turned off on the release pull request, so nothing will merge it',
      false,
    )
  }
  const { failed, silent } = readRequired(input)
  if (failed.length > 0) {
    const checks = failed.length === 1 ? 'check' : 'checks'
    return {
      kind: 'refuse',
      reason: `the required ${checks} of ${branch} failed on the release pull request: ${failed.join(', ')}`,
      failed,
      stopAutoMerge: true,
    }
  }
  if (silent.length > 0 && input.waitedMs > CI_SILENCE_MS) {
    const one = silent.length === 1
    return refuse(
      `the required check${one ? '' : 's'} ${silent.join(', ')} never reported on ${short(input.pinnedSha)}: ${one ? 'it' : 'they'} must run on pull requests into ${branch}`,
      true,
    )
  }
  return { kind: 'wait' }
}
