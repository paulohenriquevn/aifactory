// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepositoriesView } from '../../shared/panel'
import { en } from '../lib/copy/en'

import { NewJob } from './NewJob'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../lib/api', () => api)
vi.mock('theokit/client', () => ({
  useAgent: () => ({ thread: [], status: 'idle', error: undefined, send: vi.fn(), reset: vi.fn() }),
}))

const none: RepositoriesView = {
  repositories: [],
  agents: [],
  installUrl: null,
  installations: [],
  owner: null,
  error: null,
}

beforeEach(() => {
  api.get.mockReset()
})
afterEach(cleanup)

const open = () => {
  render(<NewJob onCreated={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: en.newJob.open }))
}

describe('the new job dialog while it reads the repositories', () => {
  it('says it is loading, and does not tell the owner to enable a repository', () => {
    api.get.mockReturnValue(new Promise(() => {}))
    open()
    expect(screen.getByText(en.newJob.loading)).toBeTruthy()
    expect(screen.queryByText(en.newJob.enableFirst)).toBeNull()
  })

  it('tells the owner to enable a repository once the list came back with none enabled', async () => {
    api.get.mockResolvedValue(none)
    open()
    expect(await screen.findByText(en.newJob.enableFirst)).toBeTruthy()
    expect(screen.queryByText(en.newJob.loading)).toBeNull()
  })

  it('shows the error and not the loading text when the list cannot be read', async () => {
    api.get.mockRejectedValue(new Error('GitHub is down'))
    open()
    expect(await screen.findByText('GitHub is down')).toBeTruthy()
    expect(screen.queryByText(en.newJob.loading)).toBeNull()
  })
})
