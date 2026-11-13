import { describe, expect, it } from 'vitest'

import { decideIngress, ROUTED_EVENTS } from './decide'

const repository = { full_name: 'paulo/app' }
const issue = (labels: string[] = []) => ({
  number: 7,
  title: 'Fix the login redirect',
  labels: labels.map((name) => ({ name })),
})

describe('decideIngress', () => {
  it('takes an issue that receives the factory label', () => {
    const decision = decideIngress('issues', {
      action: 'labeled',
      label: { name: 'factory' },
      issue: issue(['factory']),
      repository,
    })
    expect(decision).toMatchObject({
      accept: true,
      code: 'issue_labeled',
      repository: 'paulo/app',
      issueNumber: 7,
      issueTitle: 'Fix the login redirect',
    })
  })

  it('takes an issue opened already carrying the factory label', () => {
    const decision = decideIngress('issues', {
      action: 'opened',
      issue: issue(['bug', 'factory']),
      repository,
    })
    expect(decision).toMatchObject({ accept: true, issueNumber: 7 })
  })

  it('ignores another label, and says which one', () => {
    const decision = decideIngress('issues', {
      action: 'labeled',
      label: { name: 'bug' },
      issue: issue(['bug', 'factory']),
      repository,
    })
    expect(decision).toMatchObject({
      accept: false,
      code: 'label_not_factory',
      reason: 'label "bug" is not "factory"',
    })
  })

  it('ignores an issue opened without the label', () => {
    const decision = decideIngress('issues', { action: 'opened', issue: issue(), repository })
    expect(decision).toMatchObject({ accept: false, code: 'action_not_relevant' })
  })

  it('ignores events other than issues, keeping the repository when it is there', () => {
    expect(decideIngress('push', { repository })).toEqual({
      accept: false,
      code: 'event_not_issues',
      reason: 'event "push" is not "issues"',
      repository: 'paulo/app',
    })
  })

  it('refuses a payload that does not look like an issues event', () => {
    const decision = decideIngress('issues', { action: 'labeled' })
    expect(decision).toMatchObject({ accept: false, code: 'payload_invalid', repository: null })
  })
})

const actor = { login: 'alice' }
const comment = { id: 9001, user: actor, author_association: 'MEMBER' }
const pullRequest = { number: 12, head: { sha: 'abc1234' } }

/** One valid delivery per event the factory routes, with the intent it must come out as. */
const ROUTED: {
  event: string
  payload: Record<string, unknown>
  intent: Record<string, unknown>
}[] = [
  {
    event: 'issue_comment',
    payload: { action: 'created', issue: { number: 7 }, comment, repository },
    intent: {
      kind: 'issue_comment_created',
      repository: 'paulo/app',
      issueNumber: 7,
      commentId: 9001,
      actorLogin: 'alice',
      actorAssociation: 'MEMBER',
    },
  },
  {
    event: 'issue_comment',
    payload: {
      action: 'created',
      issue: { number: 12, pull_request: { url: 'https://api.github.com/x' } },
      comment,
      repository,
    },
    intent: {
      kind: 'pull_request_comment_created',
      repository: 'paulo/app',
      pullRequestNumber: 12,
      commentId: 9001,
      actorLogin: 'alice',
      actorAssociation: 'MEMBER',
    },
  },
  {
    event: 'pull_request_review',
    payload: {
      action: 'submitted',
      review: { id: 77, user: actor, author_association: 'OWNER' },
      pull_request: pullRequest,
      repository,
    },
    intent: {
      kind: 'pull_request_review_submitted',
      repository: 'paulo/app',
      pullRequestNumber: 12,
      reviewId: 77,
      headSha: 'abc1234',
      actorLogin: 'alice',
      actorAssociation: 'OWNER',
    },
  },
  {
    event: 'pull_request_review_comment',
    payload: { action: 'created', comment, pull_request: pullRequest, repository },
    intent: {
      kind: 'pull_request_review_comment_created',
      repository: 'paulo/app',
      pullRequestNumber: 12,
      commentId: 9001,
      headSha: 'abc1234',
      actorLogin: 'alice',
      actorAssociation: 'MEMBER',
    },
  },
  {
    event: 'check_suite',
    payload: {
      action: 'completed',
      check_suite: { head_sha: 'abc1234', conclusion: 'success' },
      repository,
    },
    intent: {
      kind: 'check_suite_completed',
      repository: 'paulo/app',
      headSha: 'abc1234',
      conclusion: 'success',
    },
  },
  {
    event: 'check_run',
    payload: {
      action: 'completed',
      check_run: { name: 'test', head_sha: 'abc1234', conclusion: 'failure' },
      repository,
    },
    intent: {
      kind: 'check_run_completed',
      repository: 'paulo/app',
      headSha: 'abc1234',
      checkName: 'test',
      conclusion: 'failure',
    },
  },
  {
    event: 'issues',
    payload: {
      action: 'unlabeled',
      label: { name: 'factory' },
      issue: issue(),
      repository,
      sender: actor,
    },
    intent: {
      kind: 'issue_unlabeled',
      repository: 'paulo/app',
      issueNumber: 7,
      actorLogin: 'alice',
    },
  },
  {
    event: 'issues',
    payload: { action: 'closed', issue: issue(['factory']), repository, sender: actor },
    intent: {
      kind: 'issue_closed',
      repository: 'paulo/app',
      issueNumber: 7,
      actorLogin: 'alice',
    },
  },
  {
    event: 'issues',
    payload: { action: 'reopened', issue: issue(), repository, sender: actor },
    intent: {
      kind: 'issue_reopened',
      repository: 'paulo/app',
      issueNumber: 7,
      actorLogin: 'alice',
    },
  },
]

describe('deliveries the factory routes without taking work', () => {
  it.each(ROUTED)('reads $event as $intent.kind', ({ event, payload, intent }) => {
    const decision = decideIngress(event, payload)
    expect(decision).toMatchObject({ accept: false, code: intent.kind, repository: 'paulo/app' })
    // Exactly these fields: the next phase reads the intent, never the payload.
    expect('intent' in decision && decision.intent).toEqual(intent)
    expect(decision.reason).not.toBe('')
  })

  it.each(ROUTED.filter((r) => r.event !== 'issues'))(
    'keeps the code it had for another action of $event',
    ({ event, payload }) => {
      expect(decideIngress(event, { ...payload, action: 'edited' })).toEqual({
        accept: false,
        code: 'event_not_issues',
        reason: `event "${event}" is not "issues"`,
        repository: 'paulo/app',
      })
    },
  )

  it.each(ROUTED.filter((r) => r.event !== 'issues'))(
    'refuses a $event payload that lacks what $intent.kind carries',
    ({ event, payload }) => {
      const decision = decideIngress(event, { action: payload.action, repository })
      expect(decision).toMatchObject({
        accept: false,
        code: 'payload_invalid',
        repository: 'paulo/app',
      })
      expect(decision).not.toHaveProperty('intent')
    },
  )

  it('refuses an issue closed, reopened or unlabeled by nobody', () => {
    for (const action of ['closed', 'reopened', 'unlabeled']) {
      const decision = decideIngress('issues', {
        action,
        label: { name: 'factory' },
        issue: issue(),
        repository,
      })
      expect(decision, action).toMatchObject({ accept: false, code: 'payload_invalid' })
      expect(decision, action).not.toHaveProperty('intent')
    }
  })

  it('ignores the removal of another label, or of no label at all', () => {
    for (const label of [{ name: 'bug' }, undefined]) {
      expect(
        decideIngress('issues', {
          action: 'unlabeled',
          label,
          issue: issue(),
          repository,
          sender: actor,
        }),
      ).toEqual({
        accept: false,
        code: 'action_not_relevant',
        reason: 'action "unlabeled" does not hand an issue to the factory',
        repository: 'paulo/app',
      })
    }
  })

  it('still ignores an action of an issue that means nothing to the factory', () => {
    expect(
      decideIngress('issues', { action: 'edited', issue: issue(['factory']), repository }),
    ).toMatchObject({ accept: false, code: 'action_not_relevant' })
  })

  it('ignores a label event that names no label, without failing', () => {
    expect(
      decideIngress('issues', { action: 'labeled', issue: issue(), repository }),
    ).toMatchObject({
      accept: false,
      code: 'label_not_factory',
      reason: 'label "" is not "factory"',
    })
  })

  it('ignores an issue opened with other labels, or with none listed', () => {
    const { number, title } = issue()
    for (const opened of [issue(['bug']), { number, title }]) {
      expect(
        decideIngress('issues', { action: 'opened', issue: opened, repository }),
      ).toMatchObject({
        accept: false,
        code: 'action_not_relevant',
      })
    }
  })

  it('does not route an event only because its name is a property every object has', () => {
    expect(decideIngress('constructor', { action: 'created', repository })).toMatchObject({
      accept: false,
      code: 'event_not_issues',
    })
  })

  it('lists the events the App must subscribe to', () => {
    expect(ROUTED_EVENTS).toEqual([
      'issues',
      'issue_comment',
      'pull_request_review',
      'pull_request_review_comment',
      'check_suite',
      'check_run',
    ])
  })
})
