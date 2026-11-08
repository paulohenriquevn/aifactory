// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RecipeView } from '../../shared/panel'

import { RecipeCard } from './RecipeCard'

const URL = '/api/panel/repositories/paulo/app/recipe'
const view = (over: Partial<RecipeView> = {}): RecipeView => ({
  fullName: 'paulo/app',
  recipe: {
    install: 'pip install -e .',
    checks: [{ name: 'test', command: 'pytest' }],
    egress: ['pypi.org', 'files.pythonhosted.org'],
  },
  pending: ['files.pythonhosted.org'],
  approved: [],
  problem: null,
  ...over,
})

function serve(answers: { get: RecipeView[]; post?: Response }) {
  const posted: unknown[] = []
  let gets = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      expect(url).toBe(URL)
      if (init.method === 'POST') {
        posted.push({
          body: JSON.parse(String(init.body)),
          csrf: (init.headers as Record<string, string>)['x-theo-action'],
        })
        return answers.post ?? new Response('{}', { status: 200 })
      }
      const answer = answers.get[Math.min(gets, answers.get.length - 1)]
      gets += 1
      return new Response(JSON.stringify(answer), { status: 200 })
    }),
  )
  return posted
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('RecipeCard', () => {
  it('shows what the recipe asks for, and which domain waits for the owner', async () => {
    serve({ get: [view()] })
    render(<RecipeCard fullName="paulo/app" />)

    expect(await screen.findByText('pip install -e .')).toBeTruthy()
    expect(screen.getByText('test: pytest')).toBeTruthy()
    expect(screen.getByText('pypi.org open')).toBeTruthy()
    expect(screen.getByText('files.pythonhosted.org waits for you')).toBeTruthy()
    expect(screen.getByText('The next run would also reach files.pythonhosted.org.')).toBeTruthy()
  })

  it('approves what waits, with the header the server wants, and reads the recipe again', async () => {
    const posted = serve({
      get: [view(), view({ pending: [], approved: ['files.pythonhosted.org'] })],
    })
    render(<RecipeCard fullName="paulo/app" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Approve this domain' }))

    await waitFor(() => expect(screen.queryByRole('button')).toBeNull())
    expect(posted).toEqual([{ body: { approve: ['files.pythonhosted.org'] }, csrf: '1' }])
    expect(screen.getByText('files.pythonhosted.org open')).toBeTruthy()
  })

  it('counts the domains on the button when more than one waits', async () => {
    serve({ get: [view({ pending: ['pypi.org', 'files.pythonhosted.org'] })] })
    render(<RecipeCard fullName="paulo/app" />)
    expect(await screen.findByRole('button', { name: 'Approve these 2 domains' })).toBeTruthy()
  })

  it('says why the server refused the approval', async () => {
    serve({
      get: [view()],
      post: new Response(JSON.stringify({ message: 'the recipe does not ask for it' }), {
        status: 409,
      }),
    })
    render(<RecipeCard fullName="paulo/app" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve this domain' }))
    expect((await screen.findByRole('alert')).textContent).toBe('the recipe does not ask for it')
  })

  it('says when there is no recipe, and why one cannot be used', async () => {
    serve({ get: [view({ recipe: null, pending: [] })] })
    render(<RecipeCard fullName="paulo/app" />)
    expect(
      await screen.findByText(/on the default branch, so the settings above are all a run uses/),
    ).toBeTruthy()
    cleanup()
    vi.unstubAllGlobals()

    serve({ get: [view({ recipe: null, pending: [], problem: 'egress.0 is not a hostname' })] })
    render(<RecipeCard fullName="paulo/app" />)
    expect(await screen.findByText('egress.0 is not a hostname')).toBeTruthy()
  })

  it('shows a recipe with only domains, none of them waiting, without a button', async () => {
    serve({ get: [view({ recipe: { egress: ['pypi.org'] }, pending: [] })] })
    render(<RecipeCard fullName="paulo/app" />)
    expect(await screen.findByText('pypi.org open')).toBeTruthy()
    expect(screen.queryByText(/Install:/)).toBeNull()
    expect(screen.queryByText(/Checks/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
