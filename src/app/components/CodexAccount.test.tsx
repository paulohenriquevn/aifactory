// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexConnection } from '../../shared/panel'

import { CodexAccount } from './CodexAccount'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }))
vi.mock('../lib/api', () => api)

const connected: CodexConnection['account'] = {
  connected: true,
  email: 'owner@example.com',
  plan: 'pro',
}
const idle: CodexConnection = { account: connected, login: { status: 'idle' } }
const waiting: CodexConnection = {
  account: connected,
  login: {
    status: 'waiting',
    userCode: 'ABCD-1234',
    verificationUri: 'https://auth.openai.com/codex/device',
  },
}

beforeEach(() => {
  api.get.mockReset().mockResolvedValue(idle)
  api.post.mockReset()
  api.del.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const mount = () => {
  const onChanged = vi.fn()
  render(<CodexAccount onChanged={onChanged} />)
  return onChanged
}

describe('changing the Codex account from the panel', () => {
  it('names the account in use and offers to sign in with another', async () => {
    mount()
    expect(await screen.findByText(/Conectado como owner@example.com \(plano pro\)/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Entrar com outra conta' })).toBeTruthy()
  })

  it('offers to connect when there is no account', async () => {
    api.get.mockResolvedValue({ account: { connected: false }, login: { status: 'idle' } })
    mount()
    expect(await screen.findByRole('button', { name: 'Conectar o Codex' })).toBeTruthy()
  })

  it('says why a login on disk cannot be used', async () => {
    api.get.mockResolvedValue({
      account: { connected: false, problem: 'credential file mode is 644' },
      login: { status: 'idle' },
    })
    mount()
    expect(await screen.findByText(/não pode ser usado: credential file mode is 644/)).toBeTruthy()
  })

  it('shows the code to type and the address once the login starts', async () => {
    api.post.mockResolvedValueOnce(waiting)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Entrar com outra conta' }))
    expect(await screen.findByText('ABCD-1234')).toBeTruthy()
    expect(
      screen
        .getByRole('link', { name: 'https://auth.openai.com/codex/device' })
        .getAttribute('href'),
    ).toBe('https://auth.openai.com/codex/device')
  })

  it('notices on its own when the owner finished, and tells the page', async () => {
    api.get.mockResolvedValueOnce(waiting)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const onChanged = mount()
    await screen.findByText('ABCD-1234')
    api.get.mockResolvedValue({ account: connected, login: { status: 'done' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100)
    })
    expect(
      await screen.findByText(/a fábrica já usa a conta nova \(owner@example.com\)/),
    ).toBeTruthy()
    expect(onChanged).toHaveBeenCalled()
  })

  it('gives the login up when asked', async () => {
    api.get.mockResolvedValueOnce(waiting)
    api.del.mockResolvedValueOnce(idle)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }))
    expect(await screen.findByRole('button', { name: 'Entrar com outra conta' })).toBeTruthy()
    expect(api.del).toHaveBeenCalledWith('/api/panel/codex/login')
  })

  it('shows why the login failed and lets the owner try again', async () => {
    api.get.mockResolvedValueOnce({
      account: connected,
      login: { status: 'error', message: 'Essa conta não pode ser usada agora: limite de uso' },
    })
    mount()
    expect((await screen.findByRole('alert')).textContent).toMatch(/limite de uso/)
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy()
  })

  it('shows a request that failed as an error instead of hiding it', async () => {
    api.get.mockImplementationOnce(() => Promise.reject(new Error('HTTP 502')))
    mount()
    expect((await screen.findByRole('alert')).textContent).toBe('HTTP 502')
  })
})
