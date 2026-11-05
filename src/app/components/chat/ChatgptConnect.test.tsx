// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatgptConnect } from './ChatgptConnect'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('connecting the ChatGPT subscription', () => {
  it('asks for a code and shows the address and the code to type', async () => {
    const fetchMock = vi.fn(async () =>
      reply({
        status: 'waiting',
        userCode: 'ABCD-1234',
        verificationUri: 'https://auth.openai.com/codex/device',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<ChatgptConnect onConnected={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Conectar o ChatGPT' }))

    await waitFor(() => expect(screen.getByText('ABCD-1234')).toBeDefined())
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      'https://auth.openai.com/codex/device',
    )
    expect(screen.queryByRole('button', { name: 'Conectar o ChatGPT' })).toBeNull()
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/panel/chat/connection',
      expect.objectContaining({ method: 'POST' }),
    ])
  })

  it('says why it failed, and lets the owner try again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ status: 'error', message: 'o código expirou' })),
    )
    render(<ChatgptConnect onConnected={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Conectar o ChatGPT' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('o código expirou'))
    expect(screen.getByRole('button', { name: 'Conectar o ChatGPT' })).toBeDefined()
  })

  it('shows a request that failed as a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ error: 'falhou' }, 500)),
    )
    render(<ChatgptConnect onConnected={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Conectar o ChatGPT' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())
  })

  it('notices by itself when the owner has finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const onConnected = vi.fn()
    let polls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return reply({ status: 'waiting', userCode: 'X-1', verificationUri: 'https://x' })
        }
        polls += 1
        return polls < 2
          ? reply({
              connected: false,
              login: { status: 'waiting', userCode: 'X-1', verificationUri: 'https://x' },
            })
          : reply({ connected: true, login: { status: 'idle' } })
      }),
    )
    render(<ChatgptConnect onConnected={onConnected} />)
    fireEvent.click(screen.getByRole('button', { name: 'Conectar o ChatGPT' }))
    await waitFor(() => expect(screen.getByText('X-1')).toBeDefined())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100)
    })
    expect(onConnected).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100)
    })
    expect(onConnected).toHaveBeenCalledTimes(1)
  })
})
