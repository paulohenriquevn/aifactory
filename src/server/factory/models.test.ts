import { describe, expect, it } from 'vitest'

import { coordinatorModel, unblockerModel } from './models'

describe('the model the coordinator drafts with', () => {
  it('is gpt-4.1-mini through OpenRouter when nothing names another', () => {
    expect(coordinatorModel({})).toBe('openrouter/openai/gpt-4.1-mini')
  })

  it('is the one FACTORY_COORDINATOR_MODEL names, and an empty value is no name', () => {
    expect(coordinatorModel({ FACTORY_COORDINATOR_MODEL: 'openrouter/x/y' })).toBe('openrouter/x/y')
    expect(coordinatorModel({ FACTORY_COORDINATOR_MODEL: '' })).toBe(
      'openrouter/openai/gpt-4.1-mini',
    )
  })

  it('does not follow the assistants of the panel', () => {
    expect(coordinatorModel({ FACTORY_ASSIST_MODEL: 'anthropic/claude-sonnet-4-6' })).toBe(
      'openrouter/openai/gpt-4.1-mini',
    )
  })
})

describe('the model the unblocker investigates with', () => {
  it("is the coordinator's model when nothing names another", () => {
    expect(unblockerModel({})).toBe('openrouter/openai/gpt-4.1-mini')
    expect(unblockerModel({ FACTORY_COORDINATOR_MODEL: 'openrouter/x/y' })).toBe('openrouter/x/y')
  })

  it('is the one FACTORY_UNBLOCKER_MODEL names, and an empty value is no name', () => {
    expect(unblockerModel({ FACTORY_UNBLOCKER_MODEL: 'openrouter/a/b' })).toBe('openrouter/a/b')
    expect(unblockerModel({ FACTORY_UNBLOCKER_MODEL: '' })).toBe('openrouter/openai/gpt-4.1-mini')
  })
})
