// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DoctorReport, RepositoryView } from '../../shared/panel'
import { CopyProvider, LANGUAGE_KEY } from '../lib/copy'

import { ProveChecks, RepositoryDoctor } from './RepositoryDoctor'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }))
vi.mock('../lib/api', () => ({
  ...api,
  ApiError: class extends Error {
    status = 0
  },
}))

const repo = {
  fullName: 'me/app',
  checks: [{ name: 'unit', command: 'pnpm test' }],
  unprovenChecks: ['unit'],
} as unknown as RepositoryView
const base = '/api/panel/repositories/me/app'

const blocked: DoctorReport = {
  fullName: 'me/app',
  at: '2026-11-13T12:00:00.000Z',
  publishMode: null,
  items: [
    {
      id: 'label',
      status: 'blocked',
      cause: 'The factory label is missing',
      repair: 'Create the label factory',
      link: 'https://github.com/me/app/labels',
      canRepair: true,
    },
    { id: 'branches', status: 'ok', cause: 'Branches exist', repair: '', canRepair: false },
  ],
}
const allOk: DoctorReport = {
  ...blocked,
  items: [blocked.items[1]!],
}

beforeEach(() => {
  api.get.mockReset()
  api.post.mockReset()
  window.localStorage.clear()
})
afterEach(cleanup)

const mount = (ui = <RepositoryDoctor repo={repo} />) => render(<CopyProvider>{ui}</CopyProvider>)

describe('the repository doctor', () => {
  it('shows the cause, the repair and the link of a blocked item', async () => {
    api.get.mockResolvedValue(blocked)
    mount()
    expect(await screen.findByText('The factory label is missing')).toBeTruthy()
    expect(screen.getByText(/Create the label factory/)).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Open' })
    expect(link.getAttribute('href')).toBe('https://github.com/me/app/labels')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.queryByText('Branches exist')).toBeNull()
    expect(api.get).toHaveBeenCalledWith(`${base}/doctor`)
  })

  it('repairs an item and shows the new report', async () => {
    api.get.mockResolvedValue(blocked)
    api.post.mockResolvedValue(allOk)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Fix it' }))
    expect(await screen.findByText(/This repository is ready/)).toBeTruthy()
    expect(api.post).toHaveBeenCalledWith(`${base}/doctor/repair`, { item: 'label' })
    expect(screen.queryByText('The factory label is missing')).toBeNull()
  })

  it('reads the report again on "Check again"', async () => {
    api.get.mockResolvedValue(blocked)
    mount()
    await screen.findByText('The factory label is missing')
    expect(api.get).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  })

  it('says the repository is ready when every item is ok', async () => {
    api.get.mockResolvedValue(allOk)
    mount()
    expect(await screen.findByText(/This repository is ready/)).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('never shows an unknown item as a pass', async () => {
    api.get.mockResolvedValue({
      ...blocked,
      items: [
        {
          id: 'app_events',
          status: 'unknown',
          cause: 'Tried to read events',
          repair: '',
          canRepair: false,
        },
      ],
    })
    mount()
    expect(await screen.findByText('Tried to read events')).toBeTruthy()
    expect(screen.getByText('Could not read')).toBeTruthy()
    expect(screen.queryByText(/is ready/)).toBeNull()
  })

  it('speaks English and Brazilian Portuguese', async () => {
    api.get.mockResolvedValue(blocked)
    mount()
    expect(await screen.findByRole('button', { name: 'Fix it' })).toBeTruthy()
    cleanup()
    window.localStorage.setItem(LANGUAGE_KEY, 'pt-BR')
    mount()
    expect(await screen.findByRole('button', { name: 'Corrigir' })).toBeTruthy()
    expect(screen.getByText('Bloqueado')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Verificar de novo' })).toBeTruthy()
  })
})

describe('proving the checks', () => {
  it('names the unproven checks and shows the result of the proof', async () => {
    api.post.mockResolvedValue({})
    api.get.mockResolvedValue({
      proof: {
        status: 'done',
        results: [
          {
            name: 'unit',
            command: 'pnpm test',
            status: 'too_slow',
            exitCode: 1,
            durationMs: 1500,
            output: 'tail of output',
          },
        ],
        error: null,
      },
    })
    mount(<ProveChecks repo={repo} />)
    expect(screen.getByText(/unit/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Prove these checks' }))
    expect(await screen.findByText('Too slow')).toBeTruthy()
    expect(screen.getByText('1.5s')).toBeTruthy()
    expect(screen.getByText('tail of output')).toBeTruthy()
    expect(api.post).toHaveBeenCalledWith(`${base}/checks/prove`, {
      checks: [{ name: 'unit', command: 'pnpm test' }],
    })
  })
})
