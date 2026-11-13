// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DoctorReport,
  RepositoriesView,
  RepositoryView,
  SetupReport,
} from '../../shared/panel'
import { CopyProvider, LANGUAGE_KEY } from '../lib/copy'
import { en } from '../lib/copy/en'
import { ptBR } from '../lib/copy/pt-BR'

import { Onboarding } from './Onboarding'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }))
vi.mock('../lib/api', () => ({
  ...api,
  ApiError: class extends Error {
    status = 0
  },
}))

const repo = (fullName: string, enabled = false) =>
  ({ fullName, private: true, defaultBranch: 'main', reachable: true, enabled }) as RepositoryView
const view = (...repositories: RepositoryView[]): RepositoriesView => ({
  repositories,
  agents: [],
  installUrl: null,
  installations: [],
  owner: null,
  error: null,
})
const setupReady: SetupReport = { ready: true, items: [] }
const setupNot: SetupReport = {
  ready: false,
  items: [
    {
      id: 'app',
      label: 'GitHub App',
      status: 'missing',
      detail: 'The App is not installed',
      link: { label: 'Install it', href: 'https://github.com/apps/x' },
    },
  ],
}
const doctor = (status: 'blocked' | 'unknown' | 'ok'): DoctorReport => ({
  fullName: 'me/app',
  at: '2026-11-13T12:00:00.000Z',
  publishMode: null,
  items: [{ id: 'label', status, cause: 'The label thing', repair: 'Fix', canRepair: false }],
})

function serve(opts: {
  setup: SetupReport
  repos: RepositoriesView
  doctor?: DoctorReport
  knowledge?: string | null
}) {
  api.get.mockImplementation((path: string) => {
    if (path === '/api/panel/setup') return Promise.resolve(opts.setup)
    if (path === '/api/panel/repositories') return Promise.resolve(opts.repos)
    if (path === '/api/panel/knowledge')
      return Promise.resolve({ repository: opts.knowledge ?? null })
    if (path.endsWith('/doctor')) return Promise.resolve(opts.doctor)
    return Promise.reject(new Error(`unexpected ${path}`))
  })
}

const mount = () =>
  render(
    <MemoryRouter>
      <CopyProvider>
        <Onboarding />
      </CopyProvider>
    </MemoryRouter>,
  )
const current = () => document.querySelector('[aria-current="step"]')?.textContent ?? ''

beforeEach(() => {
  api.get.mockReset()
  api.put.mockReset()
  window.localStorage.clear()
})
afterEach(cleanup)

describe('the onboarding', () => {
  it('starts on step 1 with the text and link of what is not ready', async () => {
    serve({ setup: setupNot, repos: view(repo('me/app')) })
    mount()
    expect(await screen.findByText('The App is not installed')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Install it' }).getAttribute('href')).toBe(
      'https://github.com/apps/x',
    )
    expect(current()).toContain(en.onboarding.steps.connect)
  })

  it('goes to step 2 when setup is ready, and enables the repository that is picked', async () => {
    serve({ setup: setupReady, repos: view(repo('me/app'), repo('me/other')) })
    api.put.mockResolvedValue({})
    mount()
    const input = await screen.findByRole('textbox', { name: en.onboarding.choose.search })
    expect(current()).toContain(en.onboarding.steps.choose)
    fireEvent.change(input, { target: { value: 'oth' } })
    expect(screen.queryByText('me/app')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.onboarding.choose.pick }))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/api/panel/repositories/me/other', { enabled: true }),
    )
  })

  it('does not offer the knowledge repository', async () => {
    serve({
      setup: setupReady,
      repos: view(repo('me/app'), repo('me/knowledge')),
      knowledge: 'me/knowledge',
    })
    mount()
    expect(await screen.findByText('me/app')).toBeTruthy()
    expect(screen.queryByText('me/knowledge')).toBeNull()
  })

  it('stays on step 3 without the first job while an item is blocked', async () => {
    serve({ setup: setupReady, repos: view(repo('me/app', true)), doctor: doctor('blocked') })
    mount()
    expect(await screen.findByText('The label thing')).toBeTruthy()
    expect(current()).toContain(en.onboarding.steps.enable)
    expect(screen.queryByRole('button', { name: en.onboarding.enable.firstJob })).toBeNull()
  })

  it('shows an item that could not be read as not read, and offers no first job', async () => {
    serve({ setup: setupReady, repos: view(repo('me/app', true)), doctor: doctor('unknown') })
    mount()
    expect(await screen.findByText(en.onboarding.enable.notRead)).toBeTruthy()
  })

  it('offers the first job when nothing is blocked, and lets a done step be read again', async () => {
    serve({ setup: setupReady, repos: view(repo('me/app', true)), doctor: doctor('ok') })
    mount()
    expect(await screen.findByRole('button', { name: en.onboarding.enable.firstJob })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.onboarding.steps.choose) }))
    expect(await screen.findByText(en.onboarding.choose.chosen('me/app'))).toBeTruthy()
  })

  it.each([
    ['en', en],
    ['pt-BR', ptBR],
  ] as const)('writes the step titles in %s', async (language, copy) => {
    window.localStorage.setItem(LANGUAGE_KEY, language)
    serve({ setup: setupNot, repos: view() })
    mount()
    await screen.findByText(copy.onboarding.connect.about)
    for (const title of Object.values(copy.onboarding.steps)) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0)
    }
  })
})
