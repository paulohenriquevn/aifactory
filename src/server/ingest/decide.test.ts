import { describe, expect, it } from 'vitest'

import { decideIngress } from './decide'

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

  it('ignores an issue that is closed, even with the label', () => {
    const decision = decideIngress('issues', {
      action: 'closed',
      issue: issue(['factory']),
      repository,
    })
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
