// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Pending, type Conversation } from './Pending'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  status: 'idle',
  pendingApprovals: [],
  approve: vi.fn(async () => {}),
  ...over,
})

describe('what waits for the owner', () => {
  it('shows a change in words, with the buttons in Portuguese, and passes the decision on', () => {
    const c = conversation({
      pendingApprovals: [{ approvalId: 'a1', toolName: 'retry_task', input: { id: 49 } }],
    })
    render(<Pending conversation={c} />)
    expect(screen.getByText('Repetir uma tarefa')).toBeDefined()
    expect(screen.queryByText('Approve')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }))
    expect(c.approve).toHaveBeenCalledWith('a1', { approved: true })
    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }))
    expect(c.approve).toHaveBeenCalledWith('a1', { approved: false })
  })

  it('shows what a repository change replaces, from the settings it reads when asked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              repositories: [{ fullName: 'o/r', releaseBranch: 'main', askQuestions: true }],
            }),
          ),
      ),
    )
    const c = conversation({
      pendingApprovals: [
        {
          approvalId: 'a2',
          toolName: 'update_repository',
          input: { repository: 'O/R', releaseBranch: 'release', askQuestions: false },
        },
      ],
    })
    render(<Pending conversation={c} />)
    await waitFor(() => expect(screen.getByText(/Branch de release: main → release/)).toBeDefined())
    expect(screen.getByText(/O agente pode perguntar na issue: sim → não/)).toBeDefined()
  })

  it('still shows a repository change while the settings are not known yet', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    )
    const c = conversation({
      pendingApprovals: [
        {
          approvalId: 'a3',
          toolName: 'update_repository',
          input: { repository: 'o/r', releaseBranch: 'x' },
        },
      ],
    })
    render(<Pending conversation={c} />)
    expect(screen.getByText(/Branch de release: x/)).toBeDefined()
  })

  it('says what usually causes a failure when the server only says an error occurred', () => {
    render(
      <Pending
        conversation={conversation({ status: 'error', error: new Error('An error occurred.') })}
      />,
    )
    expect(screen.getByText(/sem crédito/)).toBeDefined()
  })

  it('shows a reason the server did give, and a fallback when there is no error at all', () => {
    render(
      <Pending conversation={conversation({ status: 'error', error: new Error('sem chave') })} />,
    )
    expect(screen.getByText('sem chave')).toBeDefined()
    cleanup()
    render(<Pending conversation={conversation({ status: 'error' })} />)
    expect(screen.getByText(/sem crédito/)).toBeDefined()
  })

  it('shows nothing when nothing waits', () => {
    const { container } = render(<Pending conversation={conversation()} />)
    expect(container.textContent).toBe('')
  })
})
