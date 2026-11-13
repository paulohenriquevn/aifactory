// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider, LANGUAGE_KEY } from '../lib/copy'
import { en } from '../lib/copy/en'
import { ptBR } from '../lib/copy/pt-BR'

import { Assist } from './Assist'

type Agent = {
  thread: unknown[]
  status: 'idle' | 'streaming' | 'error'
  error: Error | undefined
  send: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

let agent: Agent
let used: { path: string; options: unknown }[]

vi.mock('theokit/client', () => ({
  useAgent: (path: string, options: unknown) => {
    used.push({ path, options })
    return agent
  },
}))

const proposed = (input: object) => [
  {
    id: 'a',
    role: 'assistant',
    parts: [{ type: 'dynamic-tool', toolName: 'propose', state: 'output-available', input }],
  },
]

beforeEach(() => {
  used = []
  agent = { thread: [], status: 'idle', error: undefined, send: vi.fn(), reset: vi.fn() }
})
afterEach(cleanup)

const mount = (over: Partial<Parameters<typeof Assist>[0]> = {}) => {
  const onUse = vi.fn()
  render(<Assist kind="goal" text="a site for my clients" onUse={onUse} {...over} />)
  return onUse
}

describe('the assistant under a text box', () => {
  it('talks to the assistant that reads nothing, and sends the CSRF header the server wants', () => {
    mount()
    expect(used[0].path).toBe('/api/agents/assist')
    expect(used[0].options).toEqual({ headers: { 'x-theo-action': '1' } })
  })

  it('talks to the setup assistant for a repository setup', () => {
    mount({ kind: 'setup', text: '', repository: 'o/r' })
    expect(used[0].path).toBe('/api/agents/assist-setup')
  })

  it('asks with what the owner wrote, starting from a clean conversation', () => {
    mount({ repository: 'o/r', context: 'ctx' })
    fireEvent.click(screen.getByRole('button', { name: 'Help me say it' }))
    expect(agent.reset).toHaveBeenCalled()
    expect(agent.send).toHaveBeenCalledWith({
      message:
        'kind: goal\nrepository: o/r\ncontext: ctx\n\nThe owner wrote:\na site for my clients',
    })
  })

  it('waits for a few words before it helps, except when it can look at the project', () => {
    mount({ text: '  ' })
    expect(
      (screen.getByRole('button', { name: 'Help me say it' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByText('Write a few words first.')).toBeDefined()
    cleanup()
    mount({ kind: 'setup', text: '', repository: 'o/r' })
    expect(
      (screen.getByRole('button', { name: 'Set this up for me' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('has its own words on the button for each kind', () => {
    for (const [kind, label] of [
      ['job', 'Help me say it'],
      ['changes', 'Help me say it'],
      ['issue', 'Improve this'],
      ['setup', 'Set this up for me'],
    ] as const) {
      mount({ kind, text: 'enough words', repository: 'o/r' })
      expect(screen.getByRole('button', { name: label })).toBeDefined()
      cleanup()
    }
  })

  it('says it is working, and does not let the owner ask twice', () => {
    agent.status = 'streaming'
    mount()
    expect(screen.getByRole('status').textContent).toBe('Working on it…')
    expect(
      (screen.getByRole('button', { name: 'Help me say it' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('shows the suggestion with its notes, and hands it over only when the owner says so', () => {
    agent.thread = proposed({
      title: 'Booking site',
      text: 'A site to book.',
      notes: 'I assumed one person.',
      domains: ['pypi.org'],
    })
    const onUse = mount()
    const box = screen.getByRole('region', { name: 'Suggestion' })
    expect(box.textContent).toContain('Booking site')
    expect(box.textContent).toContain('A site to book.')
    expect(box.textContent).toContain('I assumed one person.')
    expect(box.textContent).toContain('Extra domains: pypi.org')
    expect(onUse).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Use this' }))

    expect(onUse).toHaveBeenCalledWith({
      title: 'Booking site',
      text: 'A site to book.',
      notes: 'I assumed one person.',
      domains: ['pypi.org'],
    })
    expect(agent.reset).toHaveBeenCalled()
  })

  it('drops the suggestion without using it', () => {
    agent.thread = proposed({ text: 'A site to book.', notes: '' })
    const onUse = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(agent.reset).toHaveBeenCalled()
    expect(onUse).not.toHaveBeenCalled()
  })

  it('asks for a change in the owner words, on the same kind of text', () => {
    agent.thread = proposed({ text: 'A site to book.', notes: '' })
    mount()
    const change = screen.getByRole('button', { name: 'Change it' }) as HTMLButtonElement
    expect(change.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Ask for a change'), {
      target: { value: '  shorter  ' },
    })
    fireEvent.click(change)
    expect(agent.send).toHaveBeenCalledWith({
      message:
        'kind: goal\n\nThe owner wrote:\na site for my clients\n\nThe owner then asked for a change to your suggestion: shorter',
    })
    expect((screen.getByLabelText('Ask for a change') as HTMLInputElement).value).toBe('')
  })

  it('hides the suggestion while a new one is being written', () => {
    agent.thread = proposed({ text: 'old', notes: '' })
    agent.status = 'streaming'
    mount()
    expect(screen.queryByRole('region', { name: 'Suggestion' })).toBeNull()
  })

  it('says what went wrong, in words the owner can act on', () => {
    agent.status = 'error'
    agent.error = new Error('invalid x-api-key')
    mount()
    expect(screen.getByRole('alert').textContent).toMatch(/ANTHROPIC_API_KEY/)
  })
})

describe('the assistant in the language of the panel', () => {
  afterEach(() => window.localStorage.clear())

  it.each([
    ['en', en],
    ['pt-BR', ptBR],
  ] as const)('writes its button and its hint in %s', (language, copy) => {
    window.localStorage.setItem(LANGUAGE_KEY, language)
    render(
      <CopyProvider>
        <Assist kind="job" text="" onUse={vi.fn()} />
      </CopyProvider>,
    )
    expect(screen.getByRole('button', { name: copy.assist.label.job })).toBeTruthy()
    expect(screen.getByText(copy.assist.needsWords)).toBeTruthy()
  })

  it('writes a suggestion and its buttons in Portuguese', () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'pt-BR')
    agent.thread = proposed({ text: 'Uma página', domains: ['a.com'] })
    render(
      <CopyProvider>
        <Assist kind="job" text="uma página" onUse={vi.fn()} />
      </CopyProvider>,
    )
    expect(screen.getByRole('region', { name: ptBR.assist.suggestion })).toBeTruthy()
    expect(screen.getByRole('button', { name: ptBR.assist.use })).toBeTruthy()
    expect(screen.getByRole('button', { name: ptBR.assist.dismiss })).toBeTruthy()
    expect(screen.getByRole('button', { name: ptBR.assist.change })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: ptBR.assist.askChange })).toBeTruthy()
    expect(screen.getByText(ptBR.assist.extraDomains('a.com'))).toBeTruthy()
  })
})
