// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentEntry, AgentsView } from '../../shared/panel'

vi.mock('theokit/client', () => ({ Metadata: () => null }))

import Page from './page'

const entry = (over: Partial<AgentEntry>): AgentEntry => ({
  id: 'x',
  group: 'panel',
  name: 'X',
  role: 'Faz x',
  runsIn: 'server',
  engine: { value: 'modelo-x', change: 'FACTORY_X' },
  when: 'Quando x',
  tools: [{ name: 'list_tasks', description: 'Lists tasks.', effect: 'reads' }],
  prompts: [
    {
      id: 'system',
      title: 'Instruções do sistema',
      when: 'Sempre',
      text: 'Be useful.',
      template: false,
    },
  ],
  shared: [],
  source: ['src/x.ts'],
  ...over,
})

const view: AgentsView = {
  settings: {
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
  },
  shared: [
    {
      id: 'theo',
      title: 'Contexto da fábrica',
      when: 'Junto de toda mensagem',
      text: 'What the factory is.',
      template: false,
    },
  ],
  agents: [
    entry({
      id: 'builder',
      group: 'factory',
      name: 'Construtor',
      role: 'Escreve o código',
      runsIn: 'sandbox',
      engine: { value: 'codex', change: 'FACTORY_HARNESS' },
      tools: [{ name: 'sandbox', description: 'Acts inside.', effect: 'sandbox' }],
      prompts: [
        {
          id: 'build',
          title: 'Primeira tentativa',
          when: 'No começo',
          text: 'Work on ‹repositório› and ‹branch›.',
          template: true,
        },
        {
          id: 'rework',
          title: 'Retrabalho',
          when: 'Depois do revisor',
          text: 'Fix what follows.',
          template: true,
        },
      ],
    }),
    entry({
      id: 'reviewer',
      group: 'factory',
      name: 'Revisor',
      role: 'Lê a mudança',
      runsIn: 'sandbox',
    }),
    entry({
      id: 'chat',
      group: 'panel',
      name: 'Assistente do chat',
      role: 'Conversa',
      shared: ['theo'],
      tools: [
        { name: 'list_tasks', description: 'Lists tasks.', effect: 'reads' },
        { name: 'retry_task', description: 'Starts again.', effect: 'asks' },
      ],
      prompts: [
        {
          id: 'system',
          title: 'Instruções do sistema',
          when: 'Em toda conversa',
          text: 'You are the assistant. Answer in Portuguese.',
          template: false,
        },
      ],
    }),
  ],
}

const Where = () => <p aria-label="where">{useLocation().search}</p>

function show(
  start = '/agents',
  answer: Response | undefined = new Response(JSON.stringify(view)),
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => answer),
  )
  render(
    <MemoryRouter initialEntries={[start]}>
      <Page />
      <Where />
    </MemoryRouter>,
  )
}

beforeEach(() =>
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } }),
)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the agents page', () => {
  it('lists the agents in two groups and opens the first one', async () => {
    show()
    expect(screen.getByText('Carregando…')).toBeDefined()
    await screen.findByRole('article', { name: 'Construtor' })
    const groups = screen
      .getAllByRole('region')
      .filter((r) =>
        ['Constroem o código', 'Conversam com você'].includes(r.getAttribute('aria-label') ?? ''),
      )
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Constroem o código',
      'Conversam com você',
    ])
    expect(
      within(groups[0])
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Construtor2', 'Revisor'])
    expect(within(groups[1]).getByRole('button', { name: 'Assistente do chat' })).toBeDefined()
    expect(screen.getByRole('button', { name: /Construtor/ }).getAttribute('aria-current')).toBe(
      'true',
    )
  })

  it('says what the agent is, where it runs, what runs it and where its instructions are written', async () => {
    show()
    const article = await screen.findByRole('article', { name: 'Construtor' })
    expect(within(article).getByText('Roda no sandbox')).toBeDefined()
    expect(within(article).getByText('Escreve o código')).toBeDefined()
    expect(within(article).getByText('codex', { selector: 'span.font-mono' })).toBeDefined()
    expect(within(article).getByText(/Como mudar: FACTORY_HARNESS/)).toBeDefined()
    expect(within(article).getByText('age só dentro do sandbox')).toBeDefined()
    expect(within(article).getByText('src/x.ts')).toBeDefined()
    expect(within(article).getByText(/As instruções só se leem aqui/)).toBeDefined()
  })

  it('opens the agent named in the address, and changes the address when another is chosen', async () => {
    show('/agents?agent=chat')
    await screen.findByRole('article', { name: 'Assistente do chat' })
    fireEvent.click(screen.getByRole('button', { name: 'Revisor' }))
    await screen.findByRole('article', { name: 'Revisor' })
    expect(screen.getByLabelText('where').textContent).toBe('?agent=reviewer')
  })

  it('falls back to the first agent when the address names one that does not exist', async () => {
    show('/agents?agent=ghost')
    await screen.findByRole('article', { name: 'Construtor' })
  })

  it('tells the tools that only read from the ones that ask for approval', async () => {
    show('/agents?agent=chat')
    const article = await screen.findByRole('article', { name: 'Assistente do chat' })
    const rows = within(article)
      .getAllByRole('listitem')
      .filter(
        (li) => li.textContent?.includes('Lists tasks') || li.textContent?.includes('Starts again'),
      )
    expect(rows[0].textContent).toContain('só lê')
    expect(rows[1].textContent).toContain('muda algo, pede seu OK')
  })

  it('shows the instructions whole, with the places a task fills in marked, and one tab for each variant', async () => {
    show()
    const article = await screen.findByRole('article', { name: 'Construtor' })
    const first = within(article).getByRole('region', { name: 'Primeira tentativa' })
    expect(first.textContent).toContain('Work on ‹repositório› and ‹branch›.')
    expect(first.querySelectorAll('pre span.bg-sky-400\\/15')).toHaveLength(2)
    expect(first.textContent).toContain('(2 lugares)')
    expect(
      within(article)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Primeira tentativa', 'Retrabalho'])
    expect(
      within(article)
        .getByRole('tab', { name: 'Primeira tentativa' })
        .getAttribute('aria-selected'),
    ).toBe('true')

    fireEvent.click(within(article).getByRole('tab', { name: 'Retrabalho' }))
    expect(within(article).getByRole('region', { name: 'Retrabalho' }).textContent).toContain(
      'Fix what follows.',
    )
    expect(within(article).queryByRole('region', { name: 'Primeira tentativa' })).toBeNull()
  })

  it('has no tabs for an agent with one set of instructions, and no note about marks', async () => {
    show('/agents?agent=chat')
    const article = await screen.findByRole('article', { name: 'Assistente do chat' })
    expect(within(article).queryAllByRole('tab')).toHaveLength(0)
    expect(within(article).getByText(/Answer in Portuguese/)).toBeDefined()
    expect(article.textContent).not.toContain('muda a cada tarefa')
  })

  it('copies the instructions as they are written', async () => {
    show('/agents?agent=chat')
    await screen.findByRole('article', { name: 'Assistente do chat' })
    fireEvent.click(screen.getByRole('button', { name: 'Copiar: Instruções do sistema' }))
    await waitFor(() => expect(screen.getByText('Copiado')).toBeDefined())
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'You are the assistant. Answer in Portuguese.',
    )
  })

  it('leaves the text there to select by hand when the browser refuses the clipboard', async () => {
    show('/agents?agent=chat')
    await screen.findByRole('article', { name: 'Assistente do chat' })
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getByRole('button', { name: 'Copiar: Instruções do sistema' }))
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByText('Copiado')).toBeNull()
    expect(screen.getByText(/Answer in Portuguese/)).toBeDefined()
  })

  it('shows the context every panel agent also gets, folded, and none for an agent that builds', async () => {
    show('/agents?agent=chat')
    const article = await screen.findByRole('article', { name: 'Assistente do chat' })
    expect(within(article).getByText(/Também recebe: Contexto da fábrica/)).toBeDefined()
    expect(article.querySelector('details')?.hasAttribute('open')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /^Construtor/ }))
    const builder = await screen.findByRole('article', { name: 'Construtor' })
    expect(within(builder).queryByText(/Também recebe/)).toBeNull()
  })

  it('filters by what is typed, in the instructions too, and marks where it was found', async () => {
    show()
    await screen.findByRole('article', { name: 'Construtor' })
    fireEvent.change(screen.getByLabelText('Buscar agente ou texto de uma instrução'), {
      target: { value: 'portuguese' },
    })
    const article = await screen.findByRole('article', { name: 'Assistente do chat' })
    expect(screen.queryByRole('button', { name: 'Revisor' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Constroem o código' })).toBeNull()
    expect(article.querySelector('span.bg-yellow-300\\/30')?.textContent).toBe('Portuguese')
  })

  it('says so when nothing matches', async () => {
    show()
    await screen.findByRole('article', { name: 'Construtor' })
    fireEvent.change(screen.getByLabelText('Buscar agente ou texto de uma instrução'), {
      target: { value: 'zzzz' },
    })
    expect((await screen.findByRole('status')).textContent).toContain('Nenhum agente tem “zzzz”')
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('says it could not load them, and why', async () => {
    show(
      '/agents',
      new Response(JSON.stringify({ error: 'boom', message: 'o servidor caiu' }), { status: 500 }),
    )
    expect(await screen.findByText('Não consegui carregar os agentes')).toBeDefined()
  })
})
