// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClaudeLoginState } from '../../shared/panel'

import { ClaudeAccount } from './ClaudeAccount'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }))
vi.mock('../lib/api', () => api)

const LINK = 'https://claude.ai/oauth/authorize?x=1'
const waiting: ClaudeLoginState = {
  status: 'waiting',
  url: LINK,
  expiresAt: '2026-11-06T10:00:00Z',
}

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ status: 'idle' })
  api.post.mockReset()
  api.del.mockReset()
})
afterEach(cleanup)

const mount = () => {
  const onChanged = vi.fn()
  render(<ClaudeAccount onChanged={onChanged} />)
  return onChanged
}

describe('changing the Claude Code account from the panel', () => {
  it('offers to sign in with another account when nothing is going on', async () => {
    mount()
    expect(await screen.findByRole('button', { name: 'Entrar com outra conta' })).toBeTruthy()
  })

  it('shows the link to open once the login starts', async () => {
    api.post.mockResolvedValueOnce(waiting)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Entrar com outra conta' }))
    const link = await screen.findByRole('link', { name: 'Abrir a página de login' })
    expect(link.getAttribute('href')).toBe(LINK)
    expect(api.post).toHaveBeenCalledWith('/api/panel/claude/login')
  })

  it('picks up a login that was already waiting before the page was reloaded', async () => {
    api.get.mockResolvedValueOnce(waiting)
    mount()
    expect(await screen.findByRole('link', { name: 'Abrir a página de login' })).toBeTruthy()
  })

  it('sends the pasted code, clears the box and tells the page the account changed', async () => {
    api.get.mockResolvedValueOnce(waiting)
    api.post.mockResolvedValueOnce({ status: 'done' })
    const onChanged = mount()
    const box = await screen.findByRole('textbox', { name: 'Código da página de login' })
    fireEvent.change(box, { target: { value: 'abc123#xyz' } })
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }))
    expect(await screen.findByText(/a fábrica já usa a conta nova/)).toBeTruthy()
    expect(api.post).toHaveBeenCalledWith('/api/panel/claude/login/code', { code: 'abc123#xyz' })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('cannot send an empty code', async () => {
    api.get.mockResolvedValueOnce(waiting)
    mount()
    const send = await screen.findByRole('button', { name: 'Conectar' })
    expect((send as HTMLButtonElement).disabled).toBe(true)
  })

  it('gives the login up on cancel', async () => {
    api.get.mockResolvedValueOnce(waiting)
    api.del.mockResolvedValueOnce({ status: 'idle' })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }))
    expect(await screen.findByRole('button', { name: 'Entrar com outra conta' })).toBeTruthy()
    expect(api.del).toHaveBeenCalledWith('/api/panel/claude/login')
  })

  it('shows the reason a login failed, and offers to try again', async () => {
    api.get.mockResolvedValueOnce({ status: 'error', message: 'O link expirou. Comece de novo.' })
    mount()
    expect((await screen.findByRole('alert')).textContent).toBe('O link expirou. Comece de novo.')
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy()
  })

  it('shows a request that failed as an error, not as silence', async () => {
    api.post.mockRejectedValueOnce(new Error('panel session expired'))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Entrar com outra conta' }))
    expect((await screen.findByRole('alert')).textContent).toBe('panel session expired')
  })

  it('says while the account is being checked', async () => {
    api.get.mockResolvedValueOnce({ status: 'checking' })
    mount()
    expect((await screen.findByRole('status')).textContent).toMatch(/Conferindo a conta/)
  })
})

describe('starting again the tasks that waited for the account', () => {
  const done = async (answer: () => Promise<unknown>) => {
    api.get.mockResolvedValueOnce({ status: 'done' })
    api.post.mockImplementationOnce(answer)
    mount()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Refazer as tarefas que esperavam a conta' }),
    )
  }

  it('says how many tasks started', async () => {
    await done(() => Promise.resolve({ started: 3, skipped: 0 }))
    expect(await screen.findByText('3 tarefas começaram de novo.')).toBeTruthy()
    expect(api.post).toHaveBeenCalledWith('/api/panel/retry-waiting')
  })

  it('says it in the singular for one task', async () => {
    await done(() => Promise.resolve({ started: 1, skipped: 0 }))
    expect(await screen.findByText('1 tarefa começou de novo.')).toBeTruthy()
  })

  it('says so when no task was waiting', async () => {
    await done(() => Promise.resolve({ started: 0, skipped: 0 }))
    expect(await screen.findByText('Nenhuma tarefa estava esperando.')).toBeTruthy()
  })

  it('shows why starting them failed', async () => {
    await done(() => Promise.reject(new Error('GitHub answered 401')))
    expect(await screen.findByText('GitHub answered 401')).toBeTruthy()
  })
})
