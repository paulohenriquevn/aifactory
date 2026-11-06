// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentSettings } from '../../../shared/panel'

import { EngineChooser } from './EngineChooser'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const settings = (over: Partial<AgentSettings> = {}): AgentSettings => ({
  options: [
    { id: 'claude-code', ready: true },
    { id: 'codex', ready: true },
  ],
  chosen: { builder: null, planner: null, reviewer: null },
  effective: { builder: 'codex', planner: 'codex', reviewer: 'codex' },
  repositoriesWithOwn: [],
  ...over,
})

function mount(
  role: 'builder' | 'planner' | 'reviewer',
  s = settings(),
  answer = new Response('{}'),
) {
  const fetchMock = vi.fn(async () => answer)
  vi.stubGlobal('fetch', fetchMock)
  const onSaved = vi.fn()
  render(
    <MemoryRouter>
      <EngineChooser role={role} settings={s} onSaved={onSaved} />
    </MemoryRouter>,
  )
  return { fetchMock, onSaved }
}

const choose = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('choosing the coding agent of a role', () => {
  it('shows the agent in use for the builder, and has nothing to save until it changes', () => {
    mount('builder')
    expect(
      (screen.getByLabelText('Agente de código do Construtor') as HTMLSelectElement).value,
    ).toBe('codex')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'claude-code',
      'codex',
    ])
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('saves the new builder, and says it applies to the next runs without a restart', async () => {
    const { fetchMock, onSaved } = mount('builder')
    choose('Agente de código do Construtor', 'claude-code')
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('próximas execuções, sem reiniciar'),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/panel/agents/settings',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ builder: 'claude-code' }) }),
    )
    expect(onSaved).toHaveBeenCalled()
  })

  it('lets the planner and the reviewer follow the builder, which is saved as going back to the default', async () => {
    const { fetchMock } = mount(
      'planner',
      settings({ chosen: { builder: null, planner: 'claude-code', reviewer: null } }),
    )
    const box = screen.getByLabelText('Agente de código do Planejador') as HTMLSelectElement
    expect(box.value).toBe('claude-code')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'O mesmo do Construtor (codex)',
      'claude-code',
      'codex',
    ])
    choose('Agente de código do Planejador', '')
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
    expect(init).toMatchObject({ body: JSON.stringify({ planner: null }) })
  })

  it('shows "the same as the builder" for a role that was not given another', () => {
    mount('reviewer')
    expect((screen.getByLabelText('Agente de código do Revisor') as HTMLSelectElement).value).toBe(
      '',
    )
  })

  it('cannot pick an agent that cannot start, and says what is missing', () => {
    mount(
      'builder',
      settings({
        options: [
          { id: 'claude-code', ready: false, problem: 'CLAUDE_CODE_OAUTH_TOKEN is not set' },
          { id: 'codex', ready: true },
        ],
      }),
    )
    const claude = screen.getByRole('option', {
      name: 'claude-code (indisponível)',
    }) as HTMLOptionElement
    expect(claude.disabled).toBe(true)
    expect(
      screen.getByText(/não pode ser escolhido: CLAUDE_CODE_OAUTH_TOKEN is not set/),
    ).toBeDefined()
  })

  it('names the repositories that have an agent of their own, which wins over this choice', () => {
    mount(
      'builder',
      settings({
        repositoriesWithOwn: [
          { repository: 'o/own', builder: 'claude-code', reviewer: null },
          { repository: 'o/rev', builder: null, reviewer: 'codex' },
        ],
      }),
    )
    expect(screen.getByText(/o\/own\./)).toBeDefined()
    expect(screen.queryByText(/o\/rev/)).toBeNull()
    expect(screen.getByRole('link', { name: 'Mudar em Repositórios' }).getAttribute('href')).toBe(
      '/repositories',
    )
    cleanup()
    mount(
      'reviewer',
      settings({
        repositoriesWithOwn: [{ repository: 'o/rev', builder: null, reviewer: 'codex' }],
      }),
    )
    expect(screen.getByText(/o\/rev\./)).toBeDefined()
  })

  it('shows the refusal of the server, and keeps the choice for another try', async () => {
    const { onSaved } = mount(
      'builder',
      settings(),
      new Response(JSON.stringify({ error: 'refused', message: 'codex cannot start: x' }), {
        status: 409,
      }),
    )
    choose('Agente de código do Construtor', 'claude-code')
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect((await screen.findByRole('alert')).textContent).toContain('codex cannot start: x')
    expect(onSaved).not.toHaveBeenCalled()
    expect(
      (screen.getByLabelText('Agente de código do Construtor') as HTMLSelectElement).value,
    ).toBe('claude-code')
  })
})
