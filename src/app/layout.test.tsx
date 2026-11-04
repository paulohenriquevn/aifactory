// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import RootLayout from './layout'

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
  'GET /api/panel/me': { owner: true },
  'GET /api/panel/inbox': { items: [{}, {}] },
  'GET /api/panel/health': { cost: {}, findings: [{}, {}, {}] },
  'POST /api/panel/logout': { ok: true },
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<RootLayout />}>
          <Route path="/" element={<p>the board</p>} />
          <Route path="/login" element={<p>the login</p>} />
          <Route path="/inbox" element={<p>the inbox</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the layout', () => {
  it('shows the nav, with what waits in the inbox and what is wrong in health, to the owner', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the board')).toBeDefined())
    expect(screen.getByRole('link', { name: 'Board' })).toBeDefined()
    await waitFor(() => expect(screen.getByRole('link', { name: 'Inbox (2)' })).toBeDefined())
    expect(screen.getByRole('link', { name: 'Health (3)' })).toBeDefined()
    for (const name of ['Plans', 'Repositories', 'Setup']) {
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(`/${name.toLowerCase()}`)
    }
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined()
  })

  it('shows no count when nothing waits and nothing is wrong', async () => {
    serve({
      ...signedIn,
      'GET /api/panel/inbox': { items: [] },
      'GET /api/panel/health': { cost: {}, findings: [] },
    })
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('link', { name: 'Inbox' })).toBeDefined())
    expect(screen.getByRole('link', { name: 'Health' })).toBeDefined()
  })

  it('sends someone who is not signed in to the login, and shows no nav', async () => {
    serve({
      'GET /api/panel/me': { owner: false },
      'GET /api/panel/inbox': { items: [] },
      'GET /api/panel/health': { findings: [] },
    })
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the login')).toBeDefined())
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
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
    expect(screen.getByText('Loading…')).toBeDefined()
  })

  it('signs out through the server, with the header it asks for, and goes to the login', async () => {
    const calls = serve(signedIn)
    renderAt('/inbox')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(calls.some((c) => c.url === '/api/panel/logout')).toBe(true))
    expect(calls.find((c) => c.url === '/api/panel/logout')).toMatchObject({
      method: 'POST',
      csrf: '1',
    })
    await waitFor(() => expect(screen.getByText('the login')).toBeDefined())
  })
})
