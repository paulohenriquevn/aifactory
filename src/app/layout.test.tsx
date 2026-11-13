// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import RootLayout from './layout'
import { en } from './lib/copy/en'
import { ptBR } from './lib/copy/pt-BR'

// The expected text comes from the dictionary of the language the test runs in.
let t = ptBR

type Calls = { url: string; method: string; csrf?: string }[]

function serve(routes: Record<string, unknown>) {
  const calls: Calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      calls.push({
        url,
        method,
        csrf: (init.headers as Record<string, string> | undefined)?.['x-theo-action'],
      })
      const body = routes[`${method} ${url}`]
      return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 })
    }),
  )
  return calls
}

const signedIn = {
  'GET /api/panel/me': { owner: true, name: 'paulo' },
  'GET /api/panel/inbox': { items: [{}, {}] },
  'GET /api/panel/health': { cost: {}, findings: [{}, {}, {}] },
  'GET /api/panel/chats': {
    chats: [
      {
        id: 'a',
        title: 'Fixa',
        pinned: true,
        model: 'openrouter',
        updatedAt: '2026-11-05T10:00:00Z',
      },
      { id: 'b', title: 'Outra', pinned: false, model: 'codex', updatedAt: '2026-11-05T09:00:00Z' },
    ],
  },
  'POST /api/panel/logout': { ok: true },
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<RootLayout />}>
          <Route path="/" element={<p>the chat</p>} />
          <Route path="/work" element={<p>the board</p>} />
          <Route path="/tasks/:id" element={<p>a task</p>} />
          <Route path="/chat/:chatId" element={<p>a chat</p>} />
          <Route path="/login" element={<p>the login</p>} />
          <Route path="/inbox" element={<p>the inbox</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('aifactory.language', 'pt-BR')
  t = ptBR
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the layout', () => {
  it('shows the menu to the owner, with each place of the factory and what waits', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    expect(screen.getByRole('link', { name: t.menu.newChat })).toBeDefined()
    expect(screen.getByRole('link', { name: t.places.board }).getAttribute('href')).toBe('/work')
    for (const [name, href] of [
      [t.places.plans, '/plans'],
      [t.places.repositories, '/repositories'],
      [t.places.agents, '/agents'],
      [t.places.setup, '/setup'],
    ]) {
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(href)
    }
    await waitFor(() =>
      expect(screen.getByRole('link', { name: `${t.places.inbox} 2` })).toBeDefined(),
    )
    expect(screen.getByRole('link', { name: `${t.places.health} 3` })).toBeDefined()
  })

  it('marks the item of the menu the owner is in, and "Novo chat" only on the empty conversation', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    const current = () =>
      screen
        .getAllByRole('link')
        .filter((l) => l.getAttribute('aria-current') === 'page')
        .map((l) => l.textContent?.replace(/\d+$/, '').trim())
    expect(current()).toEqual([t.menu.newChat])
    fireEvent.click(screen.getByRole('link', { name: t.places.board }))
    await waitFor(() => expect(screen.getByText('the board')).toBeDefined())
    expect(current()).toEqual([t.places.board])
    fireEvent.click(screen.getByRole('link', { name: new RegExp(t.places.inbox) }))
    await waitFor(() => expect(screen.getByText('the inbox')).toBeDefined())
    expect(current()).toEqual([t.places.inbox])
  })

  it('keeps a page inside a place under it: a task is still on the board, a conversation is no place', async () => {
    serve(signedIn)
    renderAt('/tasks/7')
    await waitFor(() => expect(screen.getByText('a task')).toBeDefined())
    expect(screen.getByRole('link', { name: t.places.board }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(
      screen.getByRole('link', { name: t.menu.newChat }).getAttribute('aria-current'),
    ).toBeNull()
    cleanup()
    renderAt('/chat/b')
    await waitFor(() => expect(screen.getByText('a chat')).toBeDefined())
    expect(
      screen.getByRole('link', { name: t.places.board }).getAttribute('aria-current'),
    ).toBeNull()
    expect(
      screen.getByRole('link', { name: t.menu.newChat }).getAttribute('aria-current'),
    ).toBeNull()
    const row = await screen.findByRole('link', { name: 'Outra' })
    expect(row.getAttribute('aria-current')).toBe('page')
    expect(row.parentElement?.className).toContain('font-medium')
  })

  it('lists the conversations, the pinned ones apart, and links each to its address', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('link', { name: 'Fixa' })).toBeDefined())
    expect(screen.getByText(t.menu.pinned)).toBeDefined()
    expect(screen.getByText(t.menu.recent)).toBeDefined()
    expect(screen.getByRole('link', { name: 'Outra' }).getAttribute('href')).toBe('/chat/b')
  })

  it('filters the conversations from the search box', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('link', { name: 'Outra' })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: t.menu.searchChats }))
    fireEvent.change(screen.getByLabelText(t.menu.searchInChats), { target: { value: 'out' } })
    expect(screen.queryByRole('link', { name: 'Fixa' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Outra' })).toBeDefined()
    fireEvent.change(screen.getByLabelText(t.menu.searchInChats), { target: { value: 'zzz' } })
    expect(screen.getByText(t.menu.noneFound)).toBeDefined()
  })

  it('folds the menu into a strip of icons, remembers it, and brings the menu back', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('link', { name: t.places.board })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: t.menu.hide }))
    expect(screen.queryByRole('complementary', { name: t.menu.label })).toBeNull()
    expect(screen.getByRole('complementary', { name: t.menu.folded })).toBeDefined()
    expect(screen.queryByText(t.menu.recent)).toBeNull()
    expect(window.localStorage.getItem('aifactory.menu.hidden')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: t.menu.show }))
    expect(screen.getByRole('complementary', { name: t.menu.label })).toBeDefined()
    expect(screen.getByText(t.menu.recent)).toBeDefined()
    expect(window.localStorage.getItem('aifactory.menu.hidden')).toBe('0')
  })

  it("opens the menu with the search box showing when the strip's search is pressed", async () => {
    window.localStorage.setItem('aifactory.menu.hidden', '1')
    serve(signedIn)
    renderAt('/')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: t.menu.searchChats })).toBeDefined(),
    )
    fireEvent.click(screen.getByRole('button', { name: t.menu.searchChats }))
    expect(screen.getByLabelText(t.menu.searchInChats)).toBeDefined()
  })

  it('starts as a strip when the owner left the menu folded, and a plain return of the menu has no search box', async () => {
    window.localStorage.setItem('aifactory.menu.hidden', '1')
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    expect(screen.getByRole('complementary', { name: t.menu.folded })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: t.menu.show }))
    expect(screen.queryByLabelText(t.menu.searchInChats)).toBeNull()
  })

  it('has two tabs, and the second one is selected on the pages of the factory', async () => {
    serve(signedIn)
    renderAt('/inbox')
    await waitFor(() => expect(screen.getByText('the inbox')).toBeDefined())
    expect(screen.getByRole('tab', { name: t.topBar.work }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByRole('tab', { name: t.topBar.chat }).getAttribute('aria-selected')).toBe(
      'false',
    )
  })

  it('sends someone who is not signed in to the login, and shows no menu', async () => {
    serve({
      'GET /api/panel/me': { owner: false },
      'GET /api/panel/inbox': { items: [] },
      'GET /api/panel/health': { findings: [] },
    })
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the login')).toBeDefined())
    expect(screen.queryByRole('link', { name: t.places.board })).toBeNull()
    expect(screen.queryByRole('button', { name: t.menu.account })).toBeNull()
  })

  it('shows the login itself without bouncing, and shows loading until it knows who is there', async () => {
    serve({ 'GET /api/panel/me': { owner: false } })
    renderAt('/login')
    await waitFor(() => expect(screen.getByText('the login')).toBeDefined())
    cleanup()

    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    )
    renderAt('/')
    expect(screen.getByText(t.layout.loading)).toBeDefined()
  })

  it('signs out through the server, with the header it asks for, and goes to the login', async () => {
    const calls = serve(signedIn)
    renderAt('/inbox')
    await waitFor(() => expect(screen.getByRole('button', { name: t.menu.account })).toBeDefined())

    fireEvent.keyDown(screen.getByRole('button', { name: t.menu.account }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: t.menu.signOut }))

    await waitFor(() => expect(calls.some((c) => c.url === '/api/panel/logout')).toBe(true))
    expect(calls.find((c) => c.url === '/api/panel/logout')).toMatchObject({
      method: 'POST',
      csrf: '1',
    })
    await waitFor(() => expect(screen.getByText('the login')).toBeDefined())
  })

  it('shows the menu in English and in pt-BR, with the items of each', async () => {
    for (const [language, copy] of [
      ['en', en],
      ['pt-BR', ptBR],
    ] as const) {
      window.localStorage.setItem('aifactory.language', language)
      serve(signedIn)
      renderAt('/')
      await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
      for (const name of Object.values(copy.places))
        expect(screen.getByRole('link', { name: new RegExp(name) })).toBeDefined()
      expect(screen.getByRole('link', { name: copy.menu.newChat })).toBeDefined()
      cleanup()
    }
  })

  it('switches the language from the top bar, and the menu changes with it', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('link', { name: ptBR.places.board })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: ptBR.topBar.switchLanguage }))
    expect(screen.getByRole('link', { name: en.places.board })).toBeDefined()
    expect(screen.queryByRole('link', { name: ptBR.places.board })).toBeNull()
    expect(window.localStorage.getItem('aifactory.language')).toBe('en')
  })
})
