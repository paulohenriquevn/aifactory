// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
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

let agent: Agent
let paths: string[]

vi.mock('theokit/client', () => ({
  Metadata: () => null,
  useAgent: (path: string) => {
    paths.push(path)
    return agent
  },
}))

import { ChatsProvider } from '../../lib/chats'

import { ChatView } from './ChatView'

const fresh = (): Agent => ({
  thread: [],
  status: 'idle',
  error: undefined,
  pendingApprovals: [],
  send: vi.fn(),
  abort: vi.fn(),
  approve: vi.fn(async () => {}),
})

const text = (id: string, role: string, body: string) => ({
  id,
  role,
  parts: [{ type: 'text', text: body }],
})

type Call = { url: string; method: string; body?: unknown }
let calls: Call[]
let routes: Record<string, () => Response>

beforeEach(() => {
  agent = fresh()
  paths = []
  calls = []
  routes = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
      const make = routes[`${method} ${url}`]
      return make ? make() : new Response('{}', { status: 404 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const Where = () => <p aria-label="where">{useLocation().pathname}</p>
const json = (body: unknown) => () => new Response(JSON.stringify(body))

const tree = (chatId?: string) => (
  <MemoryRouter initialEntries={[chatId ? `/chat/${chatId}` : '/']}>
    <ChatsProvider enabled={false}>
      <Routes>
        <Route path="/" element={<ChatView />} />
        <Route path="/chat/:chatId" element={<ChatView chatId={chatId} />} />
      </Routes>
      <Where />
    </ChatsProvider>
  </MemoryRouter>
)

describe('the empty conversation', () => {
  it('greets, offers things to ask, and sends a suggestion as the first message', () => {
    render(tree())
    expect(screen.getByText('Pronto quando você quiser.')).toBeDefined()
    fireEvent.click(screen.getByText('Como está a fábrica agora?'))
    expect(agent.send).toHaveBeenCalledWith({ message: 'Como está a fábrica agora?' })
    expect(paths[0]).toBe('/api/agents/chat')
  })

  it('sends what is typed, and ignores a blank message', () => {
    render(tree())
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByLabelText('Mensagem'), { key: 'Enter' })
    expect(agent.send).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'oi' } })
    fireEvent.keyDown(screen.getByLabelText('Mensagem'), { key: 'Enter' })
    expect(agent.send).toHaveBeenCalledWith({ message: 'oi' })
  })

  it('does not send over an answer that is still coming', () => {
    agent.status = 'streaming'
    agent.thread = [text('u', 'user', 'oi')]
    render(tree())
    expect(screen.getByRole('button', { name: 'Parar' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }))
    expect(agent.abort).toHaveBeenCalled()
  })
})

describe('a conversation that was kept', () => {
  const id = '11111111-1111-4111-8111-111111111111'

  it('comes back from the database, with the history that rode along hidden from the owner', async () => {
    routes[`GET /api/panel/chats/${id}`] = json({
      chat: {
        id,
        title: 'T',
        pinned: false,
        model: 'openrouter',
        updatedAt: '2026-11-05T10:00:00Z',
      },
      messages: [
        text(
          'a',
          'user',
          'Conversa até aqui, a mais antiga primeiro:\n[dono]: x\n\nNova mensagem do dono:\nolá',
        ),
        text('b', 'assistant', 'Oi, dono.'),
      ],
    })
    render(tree(id))
    expect(screen.getByText('Carregando…')).toBeDefined()
    await waitFor(() => expect(screen.getByText('Oi, dono.')).toBeDefined())
    expect(screen.getByText('olá')).toBeDefined()
    expect(screen.queryByText(/Conversa até aqui/)).toBeNull()
  })

  it('says so when the conversation does not exist', async () => {
    render(tree(id))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Não encontrei'))
  })

  it('opens on the model the conversation was kept with', async () => {
    routes[`GET /api/panel/chats/${id}`] = json({
      chat: { id, title: 'T', pinned: false, model: 'codex', updatedAt: '2026-11-05T10:00:00Z' },
      messages: [text('a', 'user', 'oi')],
    })
    routes['GET /api/panel/chat/connection'] = json({ connected: true, login: { status: 'idle' } })
    render(tree(id))
    await waitFor(() => expect(paths).toContain('/api/agents/chat-codex'))
  })

  it('keeps the whole conversation after an answer, under the same address', async () => {
    routes[`GET /api/panel/chats/${id}`] = json({
      chat: {
        id,
        title: 'T',
        pinned: false,
        model: 'openrouter',
        updatedAt: '2026-11-05T10:00:00Z',
      },
      messages: [text('a', 'user', 'oi')],
    })
    routes[`PUT /api/panel/chats/${id}/messages`] = json({ id })
    const view = render(tree(id))
    await waitFor(() => expect(screen.getByText('oi')).toBeDefined())

    agent.status = 'streaming'
    view.rerender(tree(id))
    agent.status = 'done'
    agent.thread = [text('c', 'assistant', 'Pronto.')]
    view.rerender(tree(id))

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    const saved = calls.find((c) => c.method === 'PUT')?.body as { messages: { id: string }[] }
    expect(saved.messages.map((m) => m.id)).toEqual(['a', 'c'])
    expect(screen.getByLabelText('where').textContent).toBe(`/chat/${id}`)
  })
})

describe('a new conversation', () => {
  it('is created when the first answer is finished, and the owner is taken to its address', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    routes['POST /api/panel/chats'] = json({ id, title: '', pinned: false, model: 'openrouter' })
    routes[`PUT /api/panel/chats/${id}/messages`] = json({ id })
    agent.thread = [text('u', 'user', 'oi')]
    agent.status = 'streaming'
    const view = render(tree())
    agent.status = 'done'
    agent.thread = [text('u', 'user', 'oi'), text('r', 'assistant', 'Olá!')]
    view.rerender(tree())

    await waitFor(() => expect(screen.getByLabelText('where').textContent).toBe(`/chat/${id}`))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ model: 'openrouter' })
  })
})

describe('what the assistant asks the owner', () => {
  it('shows an approval in words, and passes the decision on', () => {
    agent.thread = [text('u', 'user', 'reabra')]
    agent.pendingApprovals = [{ approvalId: 'ap1', toolName: 'retry_task', input: { id: 49 } }]
    render(tree())
    expect(screen.getByText('Repetir uma tarefa')).toBeDefined()
    expect(screen.getByText(/tarefa 49/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /approve|aprovar/i }))
    expect(agent.approve).toHaveBeenCalledWith('ap1', { approved: true })
  })

  it('shows an error as a card, with the reason', () => {
    agent.thread = [text('u', 'user', 'oi')]
    agent.status = 'error'
    agent.error = new Error('sem chave')
    render(tree())
    expect(screen.getByText('Não consegui responder')).toBeDefined()
    expect(screen.getByText(/sem chave/)).toBeDefined()
  })
})

describe('choosing the ChatGPT subscription', () => {
  it('asks the owner to connect it when it is not, and talks to the other agent', async () => {
    routes['GET /api/panel/chat/connection'] = json({ connected: false, login: { status: 'idle' } })
    render(tree())
    fireEvent.keyDown(screen.getByRole('button', { name: 'Modelo' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /ChatGPT/ }))
    await waitFor(() => expect(screen.getByLabelText('Conectar o ChatGPT')).toBeDefined())
    expect(paths.at(-1)).toBe('/api/agents/chat-codex')
  })

  it('shows no connection card when it is connected', async () => {
    routes['GET /api/panel/chat/connection'] = json({ connected: true, login: { status: 'idle' } })
    render(tree())
    fireEvent.keyDown(screen.getByRole('button', { name: 'Modelo' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: /ChatGPT/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/panel/chat/connection')).toBe(true),
    )
    expect(screen.queryByLabelText('Conectar o ChatGPT')).toBeNull()
  })
})
