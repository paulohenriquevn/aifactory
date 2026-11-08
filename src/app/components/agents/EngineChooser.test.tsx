// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  chosenModel: { builder: null, planner: null, reviewer: null },
  chosenEffort: { builder: null, planner: null, reviewer: null },
  engines: {
    'claude-code': {
      models: [
        {
          id: 'sonnet',
          label: 'Sonnet',
          note: 'Apelido: o mais recente.',
          efforts: ['low', 'high'],
        },
        {
          id: 'opus',
          label: 'Opus',
          note: 'Apelido: o mais recente.',
          efforts: ['low', 'medium', 'high'],
        },
      ],
      efforts: ['low', 'medium', 'high'],
    },
    codex: {
      models: [
        {
          id: 'gpt-6.1-sol',
          label: 'GPT-6.1-Sol',
          note: 'O cavalo de batalha.',
          efforts: ['low', 'medium', 'high', 'ultra'],
        },
        {
          id: 'gpt-6-luna',
          label: 'GPT-6-Luna',
          note: 'Rápido e barato.',
          efforts: ['low', 'medium'],
        },
      ],
      efforts: ['low', 'medium', 'high', 'ultra'],
    },
  },
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

const optionsOf = (label: string) =>
  within(screen.getByLabelText(label))
    .getAllByRole('option')
    .map((o) => o.textContent)

describe('choosing the coding agent of a role', () => {
  it('shows the agent in use for the builder, and has nothing to save until something changes', () => {
    mount('builder')
    expect(
      (screen.getByLabelText('Agente de código do Construtor') as HTMLSelectElement).value,
    ).toBe('codex')
    expect(optionsOf('Agente de código do Construtor')).toEqual(['claude-code', 'codex'])
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('saves a new builder, and says it applies to the next runs without a restart', async () => {
    const { fetchMock, onSaved } = mount('builder')
    choose('Agente de código do Construtor', 'claude-code')
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('próximas execuções, sem reiniciar'),
    )
    const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
    expect(url).toBe('/api/panel/agents/settings')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({
      builder: 'claude-code',
      models: { builder: null },
      efforts: { builder: null },
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it('lets the planner and the reviewer follow the builder, which is saved as going back to the default', async () => {
    const { fetchMock } = mount(
      'planner',
      settings({ chosen: { builder: null, planner: 'claude-code', reviewer: null } }),
    )
    const box = screen.getByLabelText('Agente de código do Planejador') as HTMLSelectElement
    expect(box.value).toBe('claude-code')
    expect(optionsOf('Agente de código do Planejador')).toEqual([
      'O mesmo do Construtor (codex)',
      'claude-code',
      'codex',
    ])
    choose('Agente de código do Planejador', '')
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
    expect(JSON.parse(String(init.body)).planner).toBeNull()
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

describe('choosing the model and the effort', () => {
  it('offers the models of the agent in use, with its own default first', () => {
    mount('builder')
    expect(optionsOf('Modelo do Construtor')).toEqual([
      'Padrão do agente',
      'GPT-6.1-Sol',
      'GPT-6-Luna',
    ])
    expect(optionsOf('Esforço do Construtor')).toEqual(['Padrão', 'low', 'medium', 'high', 'ultra'])
  })

  it('shows what was chosen, and what the model is for', () => {
    mount(
      'builder',
      settings({
        chosenModel: { builder: 'gpt-6-luna', planner: null, reviewer: null },
        chosenEffort: { builder: 'medium', planner: null, reviewer: null },
      }),
    )
    expect((screen.getByLabelText('Modelo do Construtor') as HTMLSelectElement).value).toBe(
      'gpt-6-luna',
    )
    expect((screen.getByLabelText('Esforço do Construtor') as HTMLSelectElement).value).toBe(
      'medium',
    )
    expect(screen.getByText('Rápido e barato.')).toBeDefined()
  })

  it('narrows the effort to what the chosen model takes, and drops one it does not take', () => {
    mount('builder')
    choose('Esforço do Construtor', 'ultra')
    choose('Modelo do Construtor', 'gpt-6-luna')
    expect(optionsOf('Esforço do Construtor')).toEqual(['Padrão', 'low', 'medium'])
    expect((screen.getByLabelText('Esforço do Construtor') as HTMLSelectElement).value).toBe('')
    choose('Esforço do Construtor', 'medium')
    choose('Modelo do Construtor', 'gpt-6.1-sol')
    expect((screen.getByLabelText('Esforço do Construtor') as HTMLSelectElement).value).toBe(
      'medium',
    )
  })

  it("swaps the lists for the other agent's, and forgets a model that belongs to the first", () => {
    mount(
      'builder',
      settings({ chosenModel: { builder: 'gpt-6.1-sol', planner: null, reviewer: null } }),
    )
    choose('Agente de código do Construtor', 'claude-code')
    expect(optionsOf('Modelo do Construtor')).toEqual(['Padrão do agente', 'Sonnet', 'Opus'])
    expect((screen.getByLabelText('Modelo do Construtor') as HTMLSelectElement).value).toBe('')
    expect(optionsOf('Esforço do Construtor')).toEqual(['Padrão', 'low', 'medium', 'high'])
  })

  it('follows the agent of the builder for a planner that has none of its own', () => {
    mount('planner')
    expect(optionsOf('Modelo do Planejador')).toEqual([
      'Padrão do agente',
      'GPT-6.1-Sol',
      'GPT-6-Luna',
    ])
  })

  it('saves a model and an effort for the role, and sends the agent only when it changed', async () => {
    const { fetchMock } = mount('builder')
    choose('Modelo do Construtor', 'gpt-6.1-sol')
    choose('Esforço do Construtor', 'high')
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
    expect(JSON.parse(String(init.body))).toEqual({
      models: { builder: 'gpt-6.1-sol' },
      efforts: { builder: 'high' },
    })
  })

  it('sends the agent with its model when both changed, and null where it went back to the default', async () => {
    const { fetchMock } = mount(
      'builder',
      settings({ chosenModel: { builder: 'gpt-6.1-sol', planner: null, reviewer: null } }),
    )
    choose('Agente de código do Construtor', 'claude-code')
    choose('Modelo do Construtor', 'opus')
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]
    expect(JSON.parse(String(init.body))).toEqual({
      builder: 'claude-code',
      models: { builder: 'opus' },
      efforts: { builder: null },
    })
  })

  it('has something to save when only the model changed, and nothing once it is back', () => {
    mount('builder')
    const save = () =>
      (screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled
    choose('Modelo do Construtor', 'gpt-6-luna')
    expect(save()).toBe(false)
    choose('Modelo do Construtor', '')
    expect(save()).toBe(true)
  })

  it('says an agent has no list of models here, and offers only its default', () => {
    mount(
      'builder',
      settings({
        engines: { 'claude-code': { models: [], efforts: [] }, codex: { models: [], efforts: [] } },
      }),
    )
    expect(optionsOf('Modelo do Construtor')).toEqual(['Padrão do agente'])
    expect(screen.getByText(/A lista de modelos de codex não está disponível aqui/)).toBeDefined()
  })

  it('copes with an agent the page has no list for', () => {
    mount('builder', settings({ engines: {} }))
    expect(optionsOf('Modelo do Construtor')).toEqual(['Padrão do agente'])
  })
})
