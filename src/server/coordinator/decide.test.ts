import { describe, expect, it } from 'vitest'

import { conflictNote } from '../panel/actions'

import { decide, MAX_APPLIED, seen, type RecordedAction } from './decide'
import type { TaskException } from './exceptions'

const exception = (over: Partial<TaskException> = {}): TaskException => ({
  kind: 'checks_unchanged',
  taskId: 7,
  head: 'abc1234def',
  evidence: 'CI:\n~~~~text\nERROR: lint exited with 1\n~~~~',
  ...over,
})

const recorded = (over: Partial<RecordedAction> = {}): RecordedAction => ({
  exceptionKind: 'stalled',
  headSha: 'old0000',
  action: 'retry_from_finding',
  outcome: 'applied',
  ...over,
})

describe('whether an exception was already decided', () => {
  const onHead = (outcome: RecordedAction['outcome']) =>
    recorded({ exceptionKind: 'checks_unchanged', headSha: 'abc1234def', outcome })

  it('is decided when a row names its kind on the same head', () => {
    expect(seen(exception(), [onHead('applied')], 'auto')).toBe(true)
    expect(seen(exception(), [onHead('escalated')], 'auto')).toBe(true)
    expect(seen(exception(), [onHead('refused')], 'trial')).toBe(true)
  })

  it('is not decided on another head, or for another kind', () => {
    const otherHead = recorded({ exceptionKind: 'checks_unchanged' })
    const otherKind = recorded({ headSha: 'abc1234def' })
    for (const mode of ['trial', 'auto'] as const) {
      expect(seen(exception(), [otherHead], mode)).toBe(false)
      expect(seen(exception(), [otherKind], mode)).toBe(false)
      expect(seen(exception(), [], mode)).toBe(false)
    }
  })

  it('leaves the head free for auto when only a trial decided it', () => {
    expect(seen(exception(), [onHead('trial')], 'auto')).toBe(false)
  })

  it('counts a trial row as decided while the coordinator is still in trial', () => {
    expect(seen(exception(), [onHead('trial')], 'trial')).toBe(true)
  })
})

describe('deciding one action for an exception', () => {
  it('sends work back on its branch with the output of the checks that failed', () => {
    const decided = decide(exception(), [])
    expect(decided).toEqual({
      action: 'send_back',
      reason:
        'the required checks failed on abc1234 and the last run changed nothing: sent back on its branch with what the checks reported',
      note: "The coordinator sent this back: the repository's required checks failed on abc1234 and the last run changed nothing. Fix what they report.\n\nCI:\n~~~~text\nERROR: lint exited with 1\n~~~~",
    })
  })

  it('escalates failed checks whose output the handoff did not keep', () => {
    expect(decide(exception({ evidence: '' }), [])).toEqual({
      action: 'escalate',
      reason:
        'the required checks failed on abc1234 and the last run changed nothing, but the handoff kept no output of the checks to send back',
    })
  })

  it('sends work whose pull request conflicts with its base back to merge it, not with the check output', () => {
    for (const evidence of ['CI:\nnothing failed', '']) {
      expect(decide(exception({ evidence, conflictsWith: 'workspace' }), [])).toEqual({
        action: 'send_back',
        reason:
          'the required checks failed on abc1234 and the last run changed nothing, and its pull request conflicts with workspace: sent back on its branch to merge it',
        note: conflictNote('workspace'),
      })
    }
  })

  it('reviews again work whose review gave no usable verdict', () => {
    const unusable = exception({ kind: 'review_unusable', evidence: 'the review gave no verdict' })
    expect(decide(unusable, [])).toEqual({
      action: 'review_again',
      reason:
        'the review gave no usable verdict on abc1234 (the review gave no verdict): the same branch runs again to be reviewed',
    })
  })

  it('retries a stalled or orphaned run from the finding, as the panel does', () => {
    const stalled = exception({
      kind: 'stalled',
      evidence: 'no event for 50 minutes',
      findingId: 11,
    })
    expect(decide(stalled, [])).toEqual({
      action: 'retry_from_finding',
      findingId: 11,
      reason:
        'the supervisor found the run stalled (no event for 50 minutes): retried from its finding',
    })
    const orphaned = exception({ kind: 'orphaned', evidence: 'the job is gone', findingId: 12 })
    expect(decide(orphaned, [])).toMatchObject({ action: 'retry_from_finding', findingId: 12 })
  })

  it('escalates a finding that names none, since there is nothing to retry from', () => {
    expect(decide(exception({ kind: 'stalled', evidence: 'x' }), [])).toEqual({
      action: 'escalate',
      reason: 'the supervisor found the run stalled (x), but no finding was named to retry from',
    })
  })

  it('leaves the environment to a person past its automatic retries', () => {
    expect(decide(exception({ kind: 'environment', evidence: 'Status code 402' }), [])).toEqual({
      action: 'escalate',
      reason:
        'the environment failed past its automatic retries (Status code 402): credentials, spend limits and the GitHub App are for a person',
    })
  })

  it('escalates a fact it could not read', () => {
    expect(decide(exception({ kind: 'unknown', evidence: 'could not read x: y' }), [])).toEqual({
      action: 'escalate',
      reason: 'the coordinator could not tell what is wrong: could not read x: y',
    })
  })

  it('scopes a review that did not converge, leaving the drafting to the next step', () => {
    const plateau = exception({
      kind: 'review_plateau',
      evidence: 'the reviewer still asked for changes after 3 attempts',
    })
    expect(decide(plateau, [])).toEqual({
      action: 'scope',
      reason:
        'the reviewer still asked for changes on abc1234 (the reviewer still asked for changes after 3 attempts): the requests are scoped, the rest filed as a follow-up, and the task sent back on its branch',
    })
  })

  it('escalates every other exception, saying it has no action for it', () => {
    for (const kind of ['handoff', 'failure'] as const) {
      expect(decide(exception({ kind, evidence: 'why' }), [])).toEqual({
        action: 'escalate',
        reason: `the coordinator has no action for ${kind} yet: why`,
      })
    }
  })

  it('escalates the exception after two applied actions, naming them', () => {
    expect(MAX_APPLIED).toBe(2)
    const tried = [
      recorded({ action: 'retry_from_finding', exceptionKind: 'stalled', headSha: 'old0000aa' }),
      recorded({ action: 'review_again', exceptionKind: 'review_unusable', headSha: 'mid1111bb' }),
    ]
    expect(decide(exception(), tried)).toEqual({
      action: 'escalate',
      reason:
        'the coordinator already applied retry_from_finding for stalled on old0000, review_again for review_unusable on mid1111 on this task: a person decides what comes next',
    })
  })

  it('counts only applied actions toward the limit', () => {
    const notApplied = (['trial', 'refused', 'failed', 'escalated'] as const).map((outcome) =>
      recorded({ outcome }),
    )
    expect(decide(exception(), notApplied).action).toBe('send_back')
    expect(decide(exception(), [recorded()]).action).toBe('send_back')
  })
})

describe('deciding a release of a repository', () => {
  const ready = (labels: string[][], over: Partial<TaskException> = {}) =>
    exception({
      kind: 'release_ready',
      head: 'dev1234567',
      evidence: '2 integrated issues wait for a release of paulo/app at dev1234: #40, #60',
      released: labels.map((l, i) => ({ issue: 40 + i, labels: l })),
      ...over,
    })

  it('releases the repository with a patch when no issue is a feature', () => {
    expect(decide(ready([['bug'], []]), [])).toEqual({
      action: 'release',
      bump: 'patch',
      reason:
        '2 integrated issues wait for a release of paulo/app at dev1234: #40, #60: released as a patch',
    })
  })

  it('releases a feature as a minor and breaking work as a major', () => {
    expect(decide(ready([['enhancement']]), [])).toMatchObject({ action: 'release', bump: 'minor' })
    expect(decide(ready([['breaking']]), [])).toMatchObject({ action: 'release', bump: 'major' })
  })

  it('retries a refused release the same way, saying it is the one retry on the head', () => {
    expect(decide(ready([['bug']], { kind: 'release_retry' }), [])).toEqual({
      action: 'release',
      bump: 'patch',
      reason:
        '2 integrated issues wait for a release of paulo/app at dev1234: #40, #60: the release on dev1234 was refused for a cause that ends by itself, so it is tried once more, as a patch',
    })
  })

  it('escalates a release whose issues it does not know', () => {
    expect(decide(ready([], { released: undefined }), [])).toMatchObject({ action: 'escalate' })
  })

  it('escalates a red release branch, calling nothing', () => {
    const blocked = exception({
      kind: 'release_blocked',
      head: 'dev1234567',
      evidence: 'CI failed',
    })
    expect(decide(blocked, [])).toEqual({
      action: 'escalate',
      reason:
        'the release branch is red (CI failed): the release train waits on dev1234 until it is green again, and a person looks at it',
    })
  })

  it('is not held by the limit of applied actions of the task it is recorded on', () => {
    const tried = [recorded(), recorded({ action: 'review_again' })]
    expect(decide(ready([['bug']]), tried).action).toBe('release')
  })

  it('does not count a release toward the limit of the task it is recorded on', () => {
    const released = recorded({ action: 'release', exceptionKind: 'release_ready' })
    expect(decide(exception(), [released, recorded()]).action).toBe('send_back')
  })
})

describe('prioritising a task in the queue', () => {
  const blocked = exception({ kind: 'queue_blocked', head: 'a test', evidence: 'the test failed' })

  it('moves the task ahead', () => {
    expect(decide(blocked, [])).toMatchObject({ action: 'prioritise' })
  })

  it('is not counted by the limit of applied actions', () => {
    const applied = recorded({ action: 'prioritise', exceptionKind: 'queue_blocked' })
    const two = [recorded(), recorded({ headSha: 'o2' })]
    expect(decide(blocked, two)).toMatchObject({ action: 'prioritise' })
    expect(
      decide(exception({ kind: 'stalled', findingId: 1 }), [applied, applied, applied]),
    ).toMatchObject({ action: 'retry_from_finding' })
  })
})
