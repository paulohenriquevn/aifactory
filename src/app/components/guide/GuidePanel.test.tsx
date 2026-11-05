// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Agent = {
  thread: { id: string; role: string; parts: unknown[] }[]
  status: 'idle' | 'streaming' | 'done' | 'error'
  error: Error | undefined
  pendingApprovals: { approvalId: string; toolName?: string; input?: unknown }[]
  send: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  approve: ReturnType<typeof vi.fn>
}

const agents = new Map<string, Agent>()
const changed = vi.fn()

vi.mock('theokit/client', () => ({
  useAgent: (path: string) => {
    if (!agents.has(path)) agents.set(path, fresh())
    return agents.get(path)
  },
}))
vi.mock('../../lib/live', async (original) => ({
  ...(await original<typeof import('../../lib/live')>()),
  announceChange: () => changed(),
}))

import { GuideProvider, useGuideState } from '../../lib/guide-state'

import { GuidePanel } from './GuidePanel'

const fresh = (): Agent => ({
  thread: [],
  status: 'idle',
  error: undefined,
  pendingApprovals: [],
  send: vi.fn(),
  abort: vi.fn(),
  approve: vi.fn(async () => {}),
})

beforeEach(() => {
  agents.clear()
  changed.mockClear()
  window.localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404 })),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const Open = () => {
  const { open, setOpen } = useGuideState()
  return (
    <button type="button" onClick={() => setOpen(!open)}>
      toggle
    </button>
  )
}
const Go = ({ to }: { to: string }) => {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => void navigate(to)}>
      go {to}
    </button>
  )
}

const tree = (start = '/work') => (
  <MemoryRouter initialEntries={[start]}>
    <GuideProvider>
      <Open />
      <Go to="/inbox" />
      <Go to="/work?task=9" />
      <Go to="/" />
      <Routes>
        <Route path="*" element={<GuidePanel />} />
      </Routes>
    </GuideProvider>
  </MemoryRouter>
)

const openIt = () => fireEvent.click(screen.getByText('toggle'))
const panel = () => screen.queryByRole('complementary', { name: /^Guia/ })

describe('the guide beside the page', () => {
  it('is not there until it is opened, and shows what the page is for when it is', () => {
    render(tree())
    expect(panel()).toBeNull()
    openIt()
    expect(panel()?.getAttribute('aria-label')).toBe('Guia do Quadro')
    expect(screen.getByText(/acompanha cada tarefa/)).toBeDefined()
    expect(screen.getByText('Entender')).toBeDefined()
    expect(screen.getByText('Fazer')).toBeDefined()
    expect(screen.getByText(/Eu só mudo algo depois do seu OK/)).toBeDefined()
  })

  it('closes from its button and from Escape', () => {
    render(tree())
    openIt()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar o guia' }))
    expect(panel()).toBeNull()
    openIt()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(panel()).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(panel()).toBeNull()
  })

  it('has no guide on the chat, which is the general assistant', () => {
    render(tree('/'))
    openIt()
    expect(panel()).toBeNull()
  })

  it("follows the owner to another page, with that page's guide", () => {
    render(tree())
    openIt()
    fireEvent.click(screen.getByText('go /inbox'))
    expect(panel()?.getAttribute('aria-label')).toBe('Guia da Caixa de entrada')
    fireEvent.click(screen.getByText('go /'))
    expect(panel()).toBeNull()
  })

  it('sends a question with where the owner is, and keeps what was said when the owner comes back', async () => {
    render(tree())
    openIt()
    fireEvent.click(screen.getByText('O que significa cada coluna?'))
    const board = agents.get('/api/agents/guide-board')!
    expect(board.send).toHaveBeenCalledTimes(1)
    const message = board.send.mock.calls[0][0].message as string
    expect(message).toContain('Onde o dono está: página "Quadro" (/work).')
    expect(message.endsWith('Nova mensagem do dono:\nO que significa cada coluna?')).toBe(true)

    board.thread = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: message }] },
      { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'São sete colunas.' }] },
    ]
    fireEvent.click(screen.getByText('go /inbox'))
    expect(screen.queryByText('São sete colunas.')).toBeNull()
    fireEvent.click(screen.getByText('go /work?task=9'))
    expect(await screen.findByText(/São sete colunas/)).toBeDefined()
    expect(screen.getAllByText('O que significa cada coluna?').length).toBe(1)
    expect(screen.queryByText(/Onde o dono está/)).toBeNull()
  })

  it('knows which task is open, and asks about it first', () => {
    render(tree('/work?task=9'))
    openIt()
    fireEvent.click(screen.getByText('Explique a tarefa 9'))
    const message = agents.get('/api/agents/guide-board')!.send.mock.calls[0][0].message as string
    expect(message).toContain('Está com a tarefa 9 aberta.')
  })

  it("puts a suggestion that needs the owner's words in the box instead of sending it", () => {
    render(tree())
    openIt()
    fireEvent.click(screen.getByText('Quero abrir um job para'))
    expect((screen.getByLabelText('Mensagem') as HTMLTextAreaElement).value).toBe(
      'Quero abrir um job para ',
    )
    expect(agents.get('/api/agents/guide-board')!.send).not.toHaveBeenCalled()
  })

  it('shows the page behind it the change it made, once, when a change finishes', async () => {
    render(tree())
    openIt()
    const board = agents.get('/api/agents/guide-board')!
    const call = {
      type: 'dynamic-tool',
      toolName: 'retry_task',
      toolCallId: 'c1',
      state: 'output-available',
    }
    board.thread = [{ id: 'a', role: 'assistant', parts: [call, { type: 'text', text: 'Feito.' }] }]
    fireEvent.click(screen.getByText('go /work?task=9'))
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByText('go /inbox'))
    fireEvent.click(screen.getByText('go /work?task=9'))
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('keeps a pending approval and an error where the owner can reach them', () => {
    render(tree('/inbox'))
    openIt()
    const inbox = agents.get('/api/agents/guide-inbox')!
    inbox.pendingApprovals = [{ approvalId: 'p1', toolName: 'approve_task', input: { id: 4 } }]
    inbox.status = 'error'
    inbox.error = new Error('sem chave')
    act(() => fireEvent.click(screen.getByText('go /work?task=9')))
    fireEvent.click(screen.getByText('go /inbox'))
    expect(screen.getByText('Aprovar o pull request')).toBeDefined()
    expect(screen.getByText('sem chave')).toBeDefined()
  })

  it('warns, on the page of keys, not to paste one', () => {
    render(tree('/setup'))
    openIt()
    expect(screen.getByText('Nunca cole chaves ou senhas aqui.')).toBeDefined()
  })

  it('changes the model, keeps what was said, and asks to connect the ChatGPT when it is not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ connected: false, login: { status: 'idle' } })),
      ),
    )
    render(tree())
    openIt()
    const first = agents.get('/api/agents/guide-board')!
    first.thread = [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Antes.' }] }]
    fireEvent.click(screen.getByText('go /work?task=9'))
    expect(await screen.findByText(/Antes/)).toBeDefined()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Modelo' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /ChatGPT/ }))

    await waitFor(() => expect(agents.has('/api/agents/guide-board-codex')).toBe(true))
    expect(screen.getByText(/Antes/)).toBeDefined()
    expect(await screen.findByLabelText('Conectar o ChatGPT')).toBeDefined()
    expect(window.localStorage.getItem('aifactory.guide.model')).toBe('codex')
  })
})
