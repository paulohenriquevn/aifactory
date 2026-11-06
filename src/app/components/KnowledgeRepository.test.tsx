// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KnowledgeStatus } from '../../shared/knowledge'

import { KnowledgeRepository } from './KnowledgeRepository'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }))
vi.mock('../lib/api', () => api)

const none: KnowledgeStatus = {
  repository: null,
  branch: null,
  readBranch: null,
  memoryBranch: 'factory-memory',
  knowledgeSha: null,
  memorySha: null,
  formatProblem: null,
  syncedAt: null,
  error: null,
  errorAt: null,
  pendingNotes: 0,
  writtenNotes: 0,
}
const chosen: KnowledgeStatus = {
  ...none,
  repository: 'me/kb',
  readBranch: 'main',
  knowledgeSha: 'abcdef1234567890abcdef1234567890abcdef12',
  syncedAt: '2026-11-06T12:00:00.000Z',
}

function serve(status: KnowledgeStatus) {
  api.get.mockImplementation(async (path: string) =>
    path === '/api/panel/repositories'
      ? {
          repositories: [
            { fullName: 'me/kb', reachable: true },
            { fullName: 'me/gone', reachable: false },
          ],
        }
      : status,
  )
}

beforeEach(() => {
  api.get.mockReset()
  api.post.mockReset()
  api.put.mockReset()
})
afterEach(cleanup)

const mount = () => {
  const onChanged = vi.fn()
  render(<KnowledgeRepository onChanged={onChanged} />)
  return onChanged
}

describe('choosing the knowledge base in the panel', () => {
  it('offers the repositories the App reaches, and saves the one chosen with the default branch', async () => {
    serve(none)
    api.put.mockResolvedValueOnce(chosen)
    const onChanged = mount()
    const select = await screen.findByRole('combobox', {
      name: 'Repositório da base de conhecimento',
    })
    await screen.findByRole('option', { name: 'me/kb' })
    expect(screen.queryByRole('option', { name: 'me/gone' })).toBeNull()

    fireEvent.change(select, { target: { value: 'me/kb' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))

    expect(await screen.findByText('main @ abcdef1')).toBeTruthy()
    expect(api.put).toHaveBeenCalledWith('/api/panel/knowledge', {
      repository: 'me/kb',
      branch: null,
    })
    expect(onChanged).toHaveBeenCalled()
  })

  it('says why the factory refused the repository', async () => {
    serve(none)
    api.put.mockRejectedValueOnce(new Error('me/kb has no branch rules'))
    mount()
    await screen.findByRole('option', { name: 'me/kb' })
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Repositório da base de conhecimento' }),
      {
        target: { value: 'me/kb' },
      },
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch das regras' }), {
      target: { value: 'rules' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))

    expect((await screen.findByRole('alert')).textContent).toBe('me/kb has no branch rules')
    expect(api.put).toHaveBeenCalledWith('/api/panel/knowledge', {
      repository: 'me/kb',
      branch: 'rules',
    })
  })

  it('offers to propose the structure when the agents do not read the repository yet', async () => {
    serve({ ...chosen, formatProblem: 'MEMORY.md is missing' })
    api.post.mockResolvedValueOnce({ url: 'https://github.com/me/kb/pull/3' })
    mount()

    fireEvent.click(await screen.findByRole('button', { name: 'Propor a estrutura' }))

    const link = await screen.findByRole('link', { name: 'https://github.com/me/kb/pull/3' })
    expect(link.getAttribute('href')).toBe('https://github.com/me/kb/pull/3')
    expect(api.post).toHaveBeenCalledWith('/api/panel/knowledge/template')
  })

  it('shows a failed sync and that the agents keep the last good commit', async () => {
    serve({ ...chosen, error: 'GitHub answered 401', errorAt: '2026-11-06T12:01:00.000Z' })
    mount()
    expect((await screen.findByText(/GitHub answered 401/)).textContent).toMatch(
      /Os agentes seguem lendo o último commit bom/,
    )
  })
})
