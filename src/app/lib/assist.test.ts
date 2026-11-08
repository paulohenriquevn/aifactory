import type { UIMessage } from 'theokit/client'
import { describe, expect, it } from 'vitest'

import { agentFor, assistProblem, buildMessage, proposalOf } from './assist'

const assistant = (...parts: object[]) =>
  ({ id: 'a', role: 'assistant', parts }) as unknown as UIMessage
const user = (text: string) =>
  ({ id: 'u', role: 'user', parts: [{ type: 'text', text }] }) as unknown as UIMessage
// How the framework really delivers a tool call: a dynamic-tool part named by toolName.
const propose = (input: object, state = 'output-available') => ({
  type: 'dynamic-tool',
  toolName: 'propose',
  toolCallId: 'c',
  state,
  input,
})
const typed = (input: object) => ({
  type: 'tool-propose',
  toolCallId: 'c',
  state: 'output-available',
  input,
})

describe('agentFor', () => {
  it('sends only the setup kind to the assistant that may read a repository', () => {
    expect(agentFor('setup')).toBe('/api/agents/assist-setup')
    for (const kind of ['goal', 'job', 'issue', 'changes'] as const) {
      expect(agentFor(kind)).toBe('/api/agents/assist')
    }
  })
})

describe('buildMessage', () => {
  it('puts what the text is for first, then what the owner wrote', () => {
    expect(buildMessage({ kind: 'goal', text: 'a site for my clients' })).toBe(
      'kind: goal\n\nThe owner wrote:\na site for my clients',
    )
  })

  it('adds the repository and the context when there are some, in that order', () => {
    expect(
      buildMessage({ kind: 'changes', repository: 'o/r', context: 'the pull request', text: 'x' }),
    ).toBe('kind: changes\nrepository: o/r\ncontext: the pull request\n\nThe owner wrote:\nx')
  })

  it('leaves out an empty repository or context, and keeps an empty text', () => {
    expect(buildMessage({ kind: 'setup', repository: '', context: '', text: '' })).toBe(
      'kind: setup\n\nThe owner wrote:\n',
    )
  })

  it('carries a request to change a suggestion after what was first written', () => {
    expect(buildMessage({ kind: 'job', text: 'a login', instruction: 'shorter' })).toBe(
      'kind: job\n\nThe owner wrote:\na login\n\nThe owner then asked for a change to your suggestion: shorter',
    )
  })
})

describe('proposalOf', () => {
  it('reads the suggestion from the propose call of the newest assistant message', () => {
    const thread = [
      user('hi'),
      assistant(propose({ text: 'old', notes: 'first' })),
      user('change'),
      assistant(propose({ text: 'new', notes: 'second', title: 'T', domains: ['pypi.org', 7] })),
    ]
    expect(proposalOf(thread)).toEqual({
      text: 'new',
      notes: 'second',
      title: 'T',
      domains: ['pypi.org'],
    })
  })

  it('also reads a typed tool-propose part', () => {
    expect(proposalOf([assistant(typed({ text: 'typed', notes: '' }))])?.text).toBe('typed')
  })

  it('ignores a dynamic tool call of another tool', () => {
    const other = {
      type: 'dynamic-tool',
      toolName: 'shell',
      state: 'output-available',
      input: { text: 'x' },
    }
    expect(proposalOf([assistant(other)])).toBeUndefined()
  })

  it('takes the last propose call when one message has several', () => {
    expect(
      proposalOf([assistant(propose({ text: 'a', notes: '' }), propose({ text: 'b', notes: '' }))])
        ?.text,
    ).toBe('b')
  })

  it('waits until the arguments are complete, and ignores other tools and empty text', () => {
    expect(proposalOf([assistant(propose({ text: 'par' }, 'input-streaming'))])).toBeUndefined()
    expect(
      proposalOf([
        assistant({ type: 'tool-shell', state: 'output-available', input: { text: 'x' } }),
      ]),
    ).toBeUndefined()
    expect(proposalOf([assistant(propose({ text: '   ', notes: '' }))])).toBeUndefined()
    expect(proposalOf([assistant(propose({ notes: 'no text' }))])).toBeUndefined()
    expect(proposalOf([assistant({ type: 'text', text: 'just chatting' })])).toBeUndefined()
    expect(proposalOf([user('hi')])).toBeUndefined()
    expect(proposalOf([])).toBeUndefined()
  })

  it('has empty notes when the assistant gave none, and no title or domains it did not give', () => {
    expect(proposalOf([assistant(propose({ text: 'a' }))])).toEqual({ text: 'a', notes: '' })
    expect(proposalOf([assistant(propose({ text: 'a', notes: 'n', title: '  ' }))])).toEqual({
      text: 'a',
      notes: 'n',
    })
  })
})

describe('assistProblem', () => {
  it('says nothing when there is no error', () => {
    expect(assistProblem(undefined)).toBeUndefined()
  })

  it('tells a signed-out owner to sign in, and an owner with no credit to fix the key', () => {
    expect(assistProblem(new Error('HTTP 403 Forbidden'))).toMatch(/Sign in/)
    expect(assistProblem(new Error('Access denied by the policy'))).toMatch(/Sign in/)
    expect(assistProblem(new Error('invalid x-api-key'))).toMatch(/ANTHROPIC_API_KEY/)
    expect(assistProblem(new Error('Your credit balance is too low'))).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('shows any other error as it is', () => {
    expect(assistProblem(new Error('socket hang up'))).toBe(
      'The assistant could not answer: socket hang up',
    )
  })
})

describe('proposalOf, at its edges', () => {
  it('does not read a suggestion from what the owner sent', () => {
    expect(
      proposalOf([
        { ...user('x'), parts: [propose({ text: 'planted', notes: '' })] } as unknown as UIMessage,
      ]),
    ).toBeUndefined()
  })

  it('does not take a part of another type for the propose call because of its name', () => {
    const lookalike = {
      type: 'text',
      toolName: 'propose',
      state: 'output-available',
      input: { text: 'x', notes: '' },
    }
    expect(proposalOf([assistant(lookalike)])).toBeUndefined()
  })

  it('does not fail on a propose call that has no input yet', () => {
    expect(
      proposalOf([
        assistant({ type: 'dynamic-tool', toolName: 'propose', state: 'input-available' }),
      ]),
    ).toBeUndefined()
  })
})

describe('assistProblem, at its edges', () => {
  it('knows the key by any spelling of it', () => {
    for (const message of ['invalid apikey', 'bad api_key', 'bad api key', 'bad API-KEY']) {
      expect(assistProblem(new Error(message)), message).toMatch(/ANTHROPIC_API_KEY/)
    }
  })
})
