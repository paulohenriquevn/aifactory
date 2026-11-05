// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TaskCard } from '../../shared/panel'

import Page from './page'

const card = (over: Partial<TaskCard>): TaskCard => ({
  id: 1,
  repository: 'paulo/app',
  issueNumber: 7,
  title: 'Add truncate',
  stage: 'build',
  column: 'working',
  pullRequestUrl: null,
  headSha: null,
  costUsd: 0.12,
  attempts: 1,
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:05:00Z',
  approved: false,
  integrated: false,
  retryable: null,
  preRelease: null,
  release: null,
  mainRed: false,
  ...over,
})

function serve(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('board', () => {
  it('puts each task in the column of its stage', async () => {
    serve({
      tasks: [
        card({ id: 1, title: 'Building one' }),
        card({ id: 2, title: 'Asking one', stage: 'waiting', column: 'waiting' }),
        card({ id: 3, title: 'Done one', stage: 'done', column: 'review', costUsd: 0.31 }),
        card({ id: 4, title: 'Broken one', stage: 'failed', column: 'attention' }),
      ],
    })

    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Building one')).toBeDefined())
    const inColumn = (name: string) => within(screen.getByRole('region', { name }))
    expect(inColumn('Working').getByText('Building one')).toBeDefined()
    expect(inColumn('Waiting for you').getByText('Asking one')).toBeDefined()
    expect(inColumn('Delivered').getByText('Done one')).toBeDefined()
    expect(inColumn('Needs a person').getByText('Broken one')).toBeDefined()
    expect(inColumn('Queued').getByText('Nothing here.')).toBeDefined()
    expect(screen.getByText(/\$0\.31/)).toBeDefined()
  })

  it('keeps a failure that passes by itself out of "Needs a person", and says an integrated task is integrated', async () => {
    serve({
      tasks: [
        card({
          id: 1,
          title: 'Out of quota',
          stage: 'failed',
          column: 'retrying',
          retryable: 'quota',
        }),
        card({
          id: 2,
          title: 'Network blip',
          stage: 'failed',
          column: 'retrying',
          retryable: 'environment',
        }),
        card({ id: 3, title: 'Merged one', stage: 'done', column: 'review', integrated: true }),
        card({ id: 4, title: 'Real failure', stage: 'failed', column: 'attention' }),
      ],
    })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Out of quota')).toBeDefined())
    const inColumn = (name: string) => within(screen.getByRole('region', { name }))
    expect(inColumn('Will retry itself').getByText('Out of quota')).toBeDefined()
    expect(inColumn('Will retry itself').getByText('waiting for the limit')).toBeDefined()
    expect(inColumn('Will retry itself').getByText('will retry')).toBeDefined()
    expect(inColumn('Delivered').getByText('integrated')).toBeDefined()
    expect(inColumn('Needs a person').getByText('Real failure')).toBeDefined()
    expect(inColumn('Needs a person').queryByText('Out of quota')).toBeNull()
  })

  it('says how to start when there are no tasks, and shows an error as one', async () => {
    serve({ tasks: [] })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText(/No tasks yet/)).toBeDefined())
  })

  it('shows the attempt a task is on once it is past the first', async () => {
    serve({ tasks: [card({ attempts: 2 })] })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('attempt 2 of 3')).toBeDefined())
  })
})
