import { describe, expect, it } from 'vitest'

import { TASK_STAGES, type TaskStage } from '../db/schema'
import type { RoutedCode } from '../ingest/decide'

import {
  AUTOMATIC_RETRIES,
  automaticRunsLeft,
  EVENTS,
  NOT_WIRED,
  outcome,
  stagesWhere,
  type Facts,
  type Outcome,
  type TransitionEvent,
} from './transitions'

const act = (action: string) => ({ kind: 'action', action })
const refused = (reason: string) => ({ kind: 'refused', reason })
const ignored = (reason: string) => ({ kind: 'ignored', reason })

/** The stages where `event` leads to an action for a task with these facts, and the action. */
const acting = (event: TransitionEvent, facts: Omit<Facts, 'stage'> = {}) =>
  Object.fromEntries(
    TASK_STAGES.map((stage) => [stage, outcome({ ...facts, stage }, event)] as const)
      .filter(([, o]) => o.kind === 'action')
      .map(([stage, o]) => [stage, (o as Extract<Outcome, { kind: 'action' }>).action]),
  )

/** What every stage outside `acting` answers, which must be one outcome. */
const elsewhere = (event: TransitionEvent, facts: Omit<Facts, 'stage'> = {}) => {
  const others = TASK_STAGES.map((stage) => outcome({ ...facts, stage }, event)).filter(
    (o) => o.kind !== 'action',
  )
  return [...new Map(others.map((o) => [JSON.stringify(o), o])).values()]
}

const WORKING = ['sandbox', 'plan', 'build', 'push', 'verify', 'review', 'pr'] as const
const each = <T>(stages: readonly TaskStage[], value: T) =>
  Object.fromEntries(stages.map((stage) => [stage, value]))

describe('the transition table', () => {
  it('declares an outcome for every stage and every event', () => {
    const events: Record<TransitionEvent, true> = {
      approve: true,
      request_changes: true,
      retry: true,
      retry_from_finding: true,
      resolve: true,
      release: true,
      retry_due: true,
      conflict_rerun: true,
      send_back_after_ci: true,
      hand_over: true,
      integrate: true,
      issue_labeled: true,
      issue_comment_created: true,
      pull_request_comment_created: true,
      pull_request_review_submitted: true,
      pull_request_review_comment_created: true,
      check_suite_completed: true,
      check_run_completed: true,
      issue_unlabeled: true,
      issue_closed: true,
      issue_reopened: true,
    }
    expect([...EVENTS].sort()).toEqual(Object.keys(events).sort())
    const pairs = EVENTS.flatMap((event) => TASK_STAGES.map((stage) => ({ event, stage })))
    expect(pairs).toHaveLength(21 * 14)
    for (const { event, stage } of pairs) {
      const declared = outcome({ stage }, event)
      expect(['action', 'ignored', 'refused'], `${stage} + ${event}`).toContain(declared?.kind)
      const said = declared.kind === 'action' ? declared.action : declared.reason
      expect(said, `${stage} + ${event}`).not.toBe('')
    }
  })

  it('fails loudly for a stage nobody declared', () => {
    expect(() => outcome({ stage: 'archived' as TaskStage }, 'approve')).toThrow(
      'no outcome is declared for approve on a task in archived',
    )
  })

  it('has an event for every intent the event router gives', () => {
    const routed: Record<RoutedCode, true> = {
      issue_comment_created: true,
      pull_request_comment_created: true,
      pull_request_review_submitted: true,
      pull_request_review_comment_created: true,
      check_suite_completed: true,
      check_run_completed: true,
      issue_unlabeled: true,
      issue_closed: true,
      issue_reopened: true,
    }
    for (const code of Object.keys(routed)) expect(EVENTS).toContain(code)
  })

  it('marks as not wired the events nothing acts on yet, and only those', () => {
    expect([...NOT_WIRED].sort()).toEqual(
      [
        'hand_over',
        'integrate',
        'issue_labeled',
        'issue_comment_created',
        'pull_request_comment_created',
        'pull_request_review_submitted',
        'pull_request_review_comment_created',
        'check_suite_completed',
        'check_run_completed',
        'issue_unlabeled',
        'issue_closed',
        'issue_reopened',
      ].sort(),
    )
  })
})

describe('what a person asks for in the panel', () => {
  const pushed = { headSha: 'abc' }

  it('approves only a task with a pull request', () => {
    const no = 'only a task with a pull request can be approved'
    expect(acting('approve', pushed)).toEqual({ done: 'approve', handoff: 'approve' })
    expect(elsewhere('approve', pushed)).toEqual([refused(no)])
    expect(acting('approve')).toEqual({})
    expect(outcome({ stage: 'done', headSha: null }, 'approve')).toEqual(refused(no))
    expect(outcome({ stage: 'handoff' }, 'approve')).toEqual(refused(no))
  })

  it('sends back a pull request that is not integrated, on the branch the agent pushed', () => {
    expect(acting('request_changes')).toEqual({
      done: 'continue_on_branch',
      handoff: 'continue_on_branch',
    })
    expect(elsewhere('request_changes')).toEqual([
      refused('only a task with a pull request can be sent back'),
    ])
  })

  it('refuses to send back integrated work, and says what to do instead', () => {
    const no = refused(
      'this work is already integrated, so there is no pull request to send back: open a new job for what should change',
    )
    expect(outcome({ stage: 'done', mergedSha: 'm' }, 'request_changes')).toEqual(no)
    expect(outcome({ stage: 'handoff', mergedSha: 'm' }, 'request_changes')).toEqual(no)
    expect(outcome({ stage: 'build', mergedSha: 'm' }, 'request_changes')).toEqual(
      refused('only a task with a pull request can be sent back'),
    )
  })

  // paulohenriquevn/aifactory#54
  it('starts a task sent back from the integration branch when its branch is gone', () => {
    for (const stage of ['done', 'handoff'] as const) {
      expect(outcome({ stage, branchGone: true }, 'request_changes')).toEqual(
        act('start_from_integration_branch'),
      )
      expect(outcome({ stage, branchGone: false }, 'request_changes')).toEqual(
        act('continue_on_branch'),
      )
    }
    expect(outcome({ stage: 'done', branchGone: true, mergedSha: 'm' }, 'request_changes')).toEqual(
      expect.objectContaining({ kind: 'refused' }),
    )
  })

  it('retries a failed or handed-over task, and a done one whose pull request never merged', () => {
    const no =
      'only a failed or handed-over task, or one whose pull request was never merged, can be retried'
    expect(acting('retry')).toEqual({
      failed: 'start_over',
      handoff: 'start_over',
      done: 'start_over',
    })
    expect(elsewhere('retry')).toEqual([refused(no)])
    expect(acting('retry', { mergedSha: 'm' })).toEqual({
      failed: 'start_over',
      handoff: 'start_over',
    })
    expect(acting('retry', { resolvedSha: 'r' })).toEqual({
      failed: 'start_over',
      handoff: 'start_over',
    })
    expect(outcome({ stage: 'done', mergedSha: 'm' }, 'retry')).toEqual(refused(no))
    expect(outcome({ stage: 'done', resolvedSha: 'r' }, 'retry')).toEqual(refused(no))
  })

  it('also retries, from a supervisor finding, a run in a stage the supervisor watches', () => {
    const watched = ['intake', 'sandbox', 'build', 'push', 'verify', 'review', 'pr'] as const
    expect(acting('retry_from_finding', { mergedSha: 'm' })).toEqual({
      ...each(watched, 'start_over'),
      failed: 'start_over',
      handoff: 'start_over',
    })
    expect(acting('retry_from_finding').done).toBe('start_over')
    expect(elsewhere('retry_from_finding', { resolvedSha: 'r' })).toEqual([
      refused(
        'only a failed or handed-over task, or one whose pull request was never merged, can be retried',
      ),
    ])
    expect(outcome({ stage: 'done', mergedSha: 'm' }, 'retry_from_finding').kind).toBe('refused')
    expect(outcome({ stage: 'done', resolvedSha: 'r' }, 'retry_from_finding').kind).toBe('refused')
  })

  it('resolves another way only a failed or handed-over task', () => {
    expect(acting('resolve')).toEqual({ failed: 'resolve', handoff: 'resolve' })
    expect(elsewhere('resolve')).toEqual([
      refused('only a failed or handed-over task can be resolved another way'),
    ])
  })

  it('releases only finished work that was integrated, and says which of the two is missing', () => {
    const integrated = { headSha: 'abc', mergedSha: 'm' }
    const unfinished = refused('only a finished task with a pull request can be released')
    expect(acting('release', integrated)).toEqual({ done: 'release' })
    expect(outcome({ ...integrated, stage: 'released' }, 'release')).toEqual(
      refused('this task was already released'),
    )
    expect(
      elsewhere('release', integrated).filter((o) => o.reason !== 'this task was already released'),
    ).toEqual([unfinished])
    expect(outcome({ stage: 'done', mergedSha: 'm' }, 'release')).toEqual(unfinished)
    expect(outcome({ stage: 'done', headSha: 'abc' }, 'release')).toEqual(
      refused(
        'this work was not integrated: its pull request is still waiting to be merged into the integration branch, so it is not on the pre-release branch',
      ),
    )
  })
})

describe('what the factory does on its own', () => {
  const alone =
    'only a failed task, or one whose pull request was never merged, runs again on its own'

  it('runs a failed task again when its time came', () => {
    expect(acting('retry_due')).toEqual({ failed: 'start_over' })
    expect(elsewhere('retry_due')).toEqual([refused(alone)])
  })

  it('runs again a done task whose pull request conflicts, unless it was merged or resolved', () => {
    expect(acting('conflict_rerun')).toEqual({ done: 'start_over' })
    expect(elsewhere('conflict_rerun')).toEqual([refused(alone)])
    expect(outcome({ stage: 'done', mergedSha: 'm' }, 'conflict_rerun')).toEqual(refused(alone))
    expect(outcome({ stage: 'done', resolvedSha: 'r' }, 'conflict_rerun')).toEqual(refused(alone))
  })

  it('sends back only work that waits for the repository checks', () => {
    const no = 'only work that waits for the repository checks is sent back on its own'
    expect(acting('send_back_after_ci', { awaitingCiSha: 'abc' })).toEqual({
      done: 'continue_on_branch',
    })
    expect(elsewhere('send_back_after_ci', { awaitingCiSha: 'abc' })).toEqual([refused(no)])
    expect(outcome({ stage: 'done', awaitingCiSha: null }, 'send_back_after_ci')).toEqual(
      refused(no),
    )
  })

  it('hands over a run that is working, and work whose wait for the checks went wrong', () => {
    expect(acting('hand_over', { awaitingCiSha: 'abc' })).toEqual({
      ...each(WORKING, 'hand_over'),
      done: 'hand_over',
    })
    expect(acting('hand_over')).toEqual(each(WORKING, 'hand_over'))
    expect(elsewhere('hand_over')).toEqual([
      ignored('no run is working on this task and nothing of it waits for the repository checks'),
    ])
  })

  it('stops running a task again on its own after a few automatic runs', () => {
    expect(AUTOMATIC_RETRIES).toBe(3)
    expect([0, 2, 3, 4].map(automaticRunsLeft)).toEqual([true, true, false, false])
  })
})

describe('integrating approved work', () => {
  const none = 'only a run that reached its pull request integrates it'

  it('merges at once where no check is required, and lets GitHub merge after the required ones', () => {
    expect(acting('integrate')).toEqual({ pr: 'merge' })
    expect(elsewhere('integrate')).toEqual([ignored(none)])
    expect(acting('integrate', { checksRequired: true })).toEqual({ pr: 'auto_merge' })
    expect(outcome({ stage: 'pr', checksPassed: true }, 'integrate')).toEqual(act('merge'))
  })

  // paulohenriquevn/aifactory#51
  it('merges directly a pull request whose required checks already passed', () => {
    expect(outcome({ stage: 'pr', checksRequired: true, checksPassed: true }, 'integrate')).toEqual(
      act('merge'),
    )
  })

  // paulohenriquevn/aifactory#56
  it('marks a draft pull request ready for review before anything merges it', () => {
    const draft = { stage: 'pr', draft: true } as const
    expect(outcome(draft, 'integrate')).toEqual(act('mark_ready_for_review'))
    expect(outcome({ ...draft, checksRequired: true }, 'integrate')).toEqual(
      act('mark_ready_for_review'),
    )
    expect(outcome({ ...draft, checksRequired: true, checksPassed: true }, 'integrate')).toEqual(
      act('mark_ready_for_review'),
    )
    expect(outcome({ stage: 'done', draft: true }, 'integrate')).toEqual(ignored(none))
  })
})

describe('what a delivery from GitHub is meant to do, once something acts on it', () => {
  const written = [
    'pull_request_comment_created',
    'pull_request_review_submitted',
    'pull_request_review_comment_created',
  ] as const
  const checks = ['check_suite_completed', 'check_run_completed'] as const
  const withdrawn = ['issue_unlabeled', 'issue_closed'] as const

  it('reads a comment on the issue as the answer of a task that waits for one', () => {
    expect(acting('issue_comment_created')).toEqual({ waiting: 'read_answer' })
    expect(elsewhere('issue_comment_created')).toEqual([
      ignored('the task asked no question that a comment could answer'),
    ])
  })

  it.each(written)('sends the work back for a trusted %s on its open pull request', (event) => {
    expect(acting(event, { trusted: true })).toEqual({
      done: 'continue_on_branch',
      handoff: 'continue_on_branch',
      released: 'open_follow_up_issue',
    })
    expect(elsewhere(event, { trusted: true })).toEqual([
      ignored('the task has no pull request waiting for a person'),
    ])
  })

  it.each(written)('opens a follow-up issue for a trusted %s on integrated work', (event) => {
    expect(acting(event, { trusted: true, mergedSha: 'm' })).toEqual({
      done: 'open_follow_up_issue',
      handoff: 'open_follow_up_issue',
      released: 'open_follow_up_issue',
    })
  })

  it.each(written)('ignores a %s from someone the repository does not trust', (event) => {
    const untrusted = ignored('it was not written by someone the repository trusts')
    expect(acting(event)).toEqual({})
    expect(acting(event, { trusted: false, mergedSha: 'm' })).toEqual({})
    for (const stage of ['done', 'handoff', 'released'] as const) {
      expect(outcome({ stage }, event)).toEqual(untrusted)
    }
    expect(outcome({ stage: 'build' }, event)).toEqual(
      ignored('the task has no pull request waiting for a person'),
    )
  })

  it.each(checks)(
    'looks at the integration again when a %s reaches a task awaiting CI',
    (event) => {
      const none = ignored('no pull request of this task waits for the repository checks')
      expect(acting(event, { awaitingCiSha: 'abc' })).toEqual({ done: 're_evaluate_integration' })
      expect(elsewhere(event, { awaitingCiSha: 'abc' })).toEqual([none])
      expect(outcome({ stage: 'done' }, event)).toEqual(none)
    },
  )

  it.each(withdrawn)('cancels on %s a task that is queued, working, waiting or failed', (event) => {
    expect(acting(event, { mergedSha: 'm' })).toEqual({
      intake: 'cancel',
      ...each(WORKING, 'cancel'),
      waiting: 'cancel',
      failed: 'cancel',
    })
    expect(acting(event)).toEqual(acting(event, { mergedSha: 'm' }))
  })

  it.each(withdrawn)('ignores %s for work that is finished, released or with a person', (event) => {
    const ended = ignored('its run already ended, and what it left is with a person')
    expect(outcome({ stage: 'done', mergedSha: 'm' }, event)).toEqual(ended)
    expect(outcome({ stage: 'done' }, event)).toEqual(ended)
    expect(outcome({ stage: 'handoff' }, event)).toEqual(ended)
    expect(outcome({ stage: 'released' }, event)).toEqual(ignored('the work was already released'))
    expect(outcome({ stage: 'cancelled' }, event)).toEqual(ignored('the task is already cancelled'))
  })

  it('starts again a failed, handed-over or cancelled task whose issue gets the label again', () => {
    expect(acting('issue_labeled')).toEqual({
      failed: 'start_over',
      handoff: 'start_over',
      cancelled: 'start_over',
    })
    expect(elsewhere('issue_labeled')).toEqual([
      ignored('the issue already has a task that is running or delivered'),
    ])
  })

  it('does nothing when an issue is reopened, whatever its task is doing', () => {
    expect(acting('issue_reopened')).toEqual({})
    expect(elsewhere('issue_reopened')).toEqual([
      ignored('reopening an issue asks for nothing: the factory label does'),
    ])
  })
})

describe('the stages a task may be in when what was decided is carried out', () => {
  it('lists every stage where the event acts for the task as it was read', () => {
    expect(stagesWhere('request_changes', {})).toEqual(['done', 'handoff'])
    expect(stagesWhere('request_changes', { mergedSha: 'm' })).toEqual([])
    expect(stagesWhere('resolve', {})).toEqual(['handoff', 'failed'])
    expect(stagesWhere('retry', { mergedSha: 'm' })).toEqual(['handoff', 'failed'])
    expect(stagesWhere('retry', {})).toEqual(['done', 'handoff', 'failed'])
  })
})
