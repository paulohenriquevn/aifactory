import { describe, expect, it } from 'vitest'

import { readOf, unread } from '../factory/doctor'

import { causeOf, failedChecksOutput, recognise, type TaskFacts } from './exceptions'

const CHECKS_REASON =
  "the repository's required checks failed and the agent changed nothing, saying why below. What the failed checks reported:\n\nCI:\n~~~~text\nERROR: lint exited with 1\n~~~~"

const handedOver = (detail: Record<string, unknown> | null): TaskFacts => ({
  taskId: 7,
  stage: 'handoff',
  headSha: 'abc',
  last: readOf({ stage: 'handoff', detail }),
  automaticRuns: readOf(0),
  findings: [],
})

const failedWith = (detail: Record<string, unknown>, automaticRuns = 0): TaskFacts => ({
  taskId: 9,
  stage: 'failed',
  headSha: null,
  last: readOf({ stage: 'failed', detail }),
  automaticRuns: readOf(automaticRuns),
  findings: [],
})

describe('the cause of a handoff', () => {
  it('is the cause the run recorded', () => {
    expect(causeOf({ cause: 'checks_unchanged', reason: 'anything' })).toBe('checks_unchanged')
    expect(causeOf({ cause: 'review_unusable', reason: '' })).toBe('review_unusable')
    expect(causeOf({ cause: 'review_plateau', reason: '' })).toBe('review_plateau')
  })

  it('is read from the reason of a handoff recorded before causes were', () => {
    expect(causeOf({ reason: CHECKS_REASON })).toBe('checks_unchanged')
    expect(causeOf({ reason: 'the review gave no usable verdict: it said nothing' })).toBe(
      'review_unusable',
    )
    expect(
      causeOf({ reason: 'the reviewer still asked for changes after 3 attempts (5, 6, 7)' }),
    ).toBe('review_plateau')
  })

  it('is a plain handoff for a reason nothing recognises, or a cause nobody declared', () => {
    expect(causeOf({ reason: 'the repository checks never reported' })).toBe('handoff')
    expect(causeOf({ cause: 'made_up', reason: 'the review gave no usable verdict' })).toBe(
      'review_unusable',
    )
    expect(causeOf({ cause: 42 })).toBe('handoff')
    expect(causeOf({})).toBe('handoff')
    expect(causeOf(null)).toBe('handoff')
  })

  it('recognises an old reason only at its start', () => {
    expect(causeOf({ reason: `before: ${CHECKS_REASON}` })).toBe('handoff')
  })
})

describe('the output of the failed checks in a handoff reason', () => {
  it('is what follows the line that introduces it', () => {
    expect(failedChecksOutput(CHECKS_REASON)).toBe('CI:\n~~~~text\nERROR: lint exited with 1\n~~~~')
  })

  it('is found also when the reason starts with that line', () => {
    expect(failedChecksOutput('What the failed checks reported:\n\nlint: 1')).toBe('lint: 1')
  })

  it('is empty when the reason quotes no check', () => {
    expect(
      failedChecksOutput(
        "the repository's required checks failed and the agent changed nothing, saying why below",
      ),
    ).toBe('')
    expect(failedChecksOutput('What the failed checks reported:\n\n   ')).toBe('')
  })
})

describe('recognising the exceptions of a task', () => {
  it('recognises required checks that failed on a run that changed nothing, with their output', () => {
    expect(recognise(handedOver({ reason: CHECKS_REASON, cause: 'checks_unchanged' }))).toEqual([
      {
        kind: 'checks_unchanged',
        taskId: 7,
        head: 'abc',
        evidence: 'CI:\n~~~~text\nERROR: lint exited with 1\n~~~~',
      },
    ])
  })

  it('recognises failed checks on a pull request that conflicts with its base, naming the base', () => {
    const facts = {
      ...handedOver({ reason: CHECKS_REASON, cause: 'checks_unchanged' }),
      pullRequest: readOf({ conflicting: true, base: 'workspace' }),
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'checks_unchanged',
        taskId: 7,
        head: 'abc',
        evidence: 'CI:\n~~~~text\nERROR: lint exited with 1\n~~~~',
        conflictsWith: 'workspace',
      },
    ])
  })

  it('names no base when the pull request of the failed checks merges cleanly', () => {
    const facts = {
      ...handedOver({ reason: CHECKS_REASON, cause: 'checks_unchanged' }),
      pullRequest: readOf({ conflicting: false, base: 'workspace' }),
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'checks_unchanged',
        taskId: 7,
        head: 'abc',
        evidence: 'CI:\n~~~~text\nERROR: lint exited with 1\n~~~~',
      },
    ])
  })

  it('gives an unknown exception when the pull request of the failed checks could not be read', () => {
    const facts = {
      ...handedOver({ reason: CHECKS_REASON, cause: 'checks_unchanged' }),
      pullRequest: unread('the pull request of task 7', 'GitHub answered 502'),
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'unknown',
        taskId: 7,
        head: 'abc',
        evidence: 'could not read the pull request of task 7: GitHub answered 502',
      },
    ])
  })

  it('recognises a review that gave no verdict and one that did not converge, with the reason', () => {
    const unusable = 'the review gave no usable verdict: nothing'
    expect(recognise(handedOver({ reason: unusable, cause: 'review_unusable' }))).toEqual([
      { kind: 'review_unusable', taskId: 7, head: 'abc', evidence: unusable },
    ])
    const plateau = 'the reviewer still asked for changes after 3 attempts'
    expect(recognise(handedOver({ reason: plateau }))).toEqual([
      { kind: 'review_plateau', taskId: 7, head: 'abc', evidence: plateau },
    ])
  })

  it('names a handoff with no reason as such', () => {
    expect(recognise(handedOver(null))).toEqual([
      { kind: 'handoff', taskId: 7, head: 'abc', evidence: 'the handoff recorded no reason' },
    ])
    expect(recognise(handedOver({}))).toEqual([
      { kind: 'handoff', taskId: 7, head: 'abc', evidence: 'the handoff recorded no reason' },
    ])
  })

  it('gives an unknown exception, never none, when the last event could not be read', () => {
    const facts = { ...handedOver({}), last: unread('the last events of the tasks', 'ECONNRESET') }
    expect(recognise(facts)).toEqual([
      {
        kind: 'unknown',
        taskId: 7,
        head: 'abc',
        evidence: 'could not read the last events of the tasks: ECONNRESET',
      },
    ])
  })

  it('gives an unknown exception when the task is in a stage its last event does not say', () => {
    const facts = { ...handedOver({}), last: readOf({ stage: 'review' as const, detail: null }) }
    expect(recognise(facts)).toEqual([
      {
        kind: 'unknown',
        taskId: 7,
        head: 'abc',
        evidence: 'the task is in handoff, and its last event is review',
      },
    ])
    expect(recognise({ ...handedOver({}), last: readOf(null) })).toEqual([
      {
        kind: 'unknown',
        taskId: 7,
        head: 'abc',
        evidence: 'the task is in handoff, and it has no event',
      },
    ])
  })

  it('leaves alone a failure of the environment that still has automatic retries', () => {
    expect(recognise(failedWith({ error: 'fetch failed' }, 2))).toEqual([])
  })

  it('recognises a failure of the environment past its automatic retries, on no head', () => {
    expect(recognise(failedWith({ error: 'fetch failed' }, 3))).toEqual([
      { kind: 'environment', taskId: 9, head: 'none', evidence: 'fetch failed' },
    ])
  })

  it('leaves alone the failures that pass by themselves', () => {
    expect(recognise(failedWith({ quota: true, error: 'usage limit' }, 9))).toEqual([])
    expect(recognise(failedWith({ blockedBy: [12], error: 'blocked' }, 9))).toEqual([])
  })

  it('recognises a failure of the work itself', () => {
    expect(recognise(failedWith({ error: 'the tests failed' }))).toEqual([
      { kind: 'failure', taskId: 9, head: 'none', evidence: 'the tests failed' },
    ])
    const noDetail = { ...failedWith({}), last: readOf({ stage: 'failed' as const, detail: null }) }
    expect(recognise(noDetail)).toEqual([
      { kind: 'failure', taskId: 9, head: 'none', evidence: 'the failure recorded no error' },
    ])
    expect(recognise(failedWith({}))).toEqual([
      { kind: 'failure', taskId: 9, head: 'none', evidence: 'the failure recorded no error' },
    ])
  })

  it('gives an unknown exception for a failure whose automatic runs could not be counted', () => {
    const facts = {
      ...failedWith({ error: 'fetch failed' }),
      automaticRuns: unread('the automatic runs of the tasks', 'timeout'),
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'unknown',
        taskId: 9,
        head: 'none',
        evidence: 'could not read the automatic runs of the tasks: timeout',
      },
    ])
  })

  it('recognises each open finding of the supervisor on a task, whatever its stage', () => {
    const facts: TaskFacts = {
      taskId: 3,
      stage: 'build',
      headSha: 'def',
      last: unread('the last events of the tasks', 'not needed'),
      automaticRuns: unread('the automatic runs of the tasks', 'not needed'),
      findings: [
        { id: 11, kind: 'stalled', detail: 'no event for 50 minutes' },
        { id: 12, kind: 'orphaned', detail: 'the run job is gone' },
      ],
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'stalled',
        taskId: 3,
        head: 'def',
        evidence: 'no event for 50 minutes',
        findingId: 11,
      },
      { kind: 'orphaned', taskId: 3, head: 'def', evidence: 'the run job is gone', findingId: 12 },
    ])
  })

  it('recognises nothing on a task in another stage with no finding', () => {
    expect(recognise({ ...handedOver({}), stage: 'done' })).toEqual([])
  })
})
