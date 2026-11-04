// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PlanView, RepositoriesView, SetupReport } from '../shared/panel'

import { NewJob } from './components/NewJob'
import PlansPage from './plans/page'
import PlanPage from './plans/[planId]/page'
import RepositoriesPage from './repositories/page'
import SetupPage from './setup/page'

type Call = { url: string; method: string; body?: unknown; csrf?: string }
type Reply = unknown | ((call: Call) => Response)

let calls: Call[] = []
function serve(routes: Record<string, Reply>) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      const call: Call = {
        url,
        method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        csrf: (init.headers as Record<string, string> | undefined)?.['x-theo-action'],
      }
      calls.push(call)
      const reply = routes[`${method} ${url}`]
      if (typeof reply === 'function') return (reply as (c: Call) => Response)(call)
      return new Response(JSON.stringify(reply ?? {}), { status: reply === undefined ? 404 : 200 })
    }),
  )
}
const refusal = (message: string) => () =>
  new Response(JSON.stringify({ error: 'refused', message }), { status: 409 })

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const repos = (over: Partial<RepositoriesView> = {}): RepositoriesView => ({
  repositories: [
    {
      fullName: 'paulo/app',
      private: true,
      defaultBranch: 'main',
      reachable: true,
      enabled: true,
      checks: [{ name: 'unit', command: 'pnpm test' }],
      egress: ['pypi.org'],
      harness: 'codex',
      reviewer: null,
      releaseMode: 'trial',
    },
    {
      fullName: 'paulo/other',
      private: false,
      defaultBranch: 'main',
      reachable: true,
      enabled: false,
      checks: null,
      egress: [],
      harness: null,
      reviewer: null,
      releaseMode: null,
    },
  ],
  agents: ['claude-code', 'codex'],
  installUrl: 'https://github.com/apps/x/installations/new',
  installations: [
    { account: 'paulo', selection: 'all', url: 'https://github.com/settings/installations/9' },
  ],
  owner: 'paulo',
  error: null,
  ...over,
})

describe('setup', () => {
  const report = (over: Partial<SetupReport> = {}): SetupReport => ({
    ready: false,
    items: [
      {
        id: 'github',
        label: 'GitHub App',
        status: 'missing',
        detail: 'The App is not installed on any repository yet.',
        link: {
          label: 'Install it and choose repositories',
          href: 'https://github.com/apps/x/installations/new',
        },
      },
      {
        id: 'sandbox',
        label: 'Sandbox',
        status: 'ok',
        detail: 'Vercel Sandbox credentials are set.',
      },
      {
        id: 'repositories',
        label: 'Repositories',
        status: 'missing',
        detail: 'No repository is enabled.',
        link: { label: 'Enable one', href: '/repositories' },
      },
    ],
    ...over,
  })

  it('shows each part with what to do, and links to GitHub or to the panel page that fixes it', async () => {
    serve({ 'GET /api/panel/setup': report() })
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Not ready yet')).toBeDefined())
    expect(screen.getAllByText('needed')).toHaveLength(2)
    expect(screen.getByText('ready')).toBeDefined()
    const github = screen.getByRole('link', { name: 'Install it and choose repositories' })
    expect(github.getAttribute('href')).toBe('https://github.com/apps/x/installations/new')
    expect(github.getAttribute('target')).toBe('_blank')
    const inside = screen.getByRole('link', { name: 'Enable one' })
    expect(inside.getAttribute('href')).toBe('/repositories')
    expect(inside.getAttribute('target')).toBeNull()
  })

  it('says it is ready when nothing is missing, and asks again on request', async () => {
    serve({
      'GET /api/panel/setup': report({
        ready: true,
        items: [{ id: 'sandbox', label: 'Sandbox', status: 'warn', detail: 'check this' }],
      }),
    })
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Ready to build')).toBeDefined())
    expect(screen.getByText('check')).toBeDefined()
    const before = calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(calls.length).toBeGreaterThan(before))
  })
})

describe('repositories', () => {
  const mount = () =>
    render(
      <MemoryRouter>
        <RepositoriesPage />
      </MemoryRouter>,
    )

  it('lists the repositories with their state and a link to give the App more access', async () => {
    serve({ 'GET /api/panel/repositories': repos() })
    mount()
    await waitFor(() => expect(screen.getByText('paulo/app')).toBeDefined())
    expect(screen.getByText('paulo/other')).toBeDefined()
    expect(screen.getByText('enabled')).toBeDefined()
    expect(screen.getByText('public')).toBeDefined()
    const manage = screen.getByRole('link', {
      name: 'Restrict which repositories the App reaches (paulo)',
    })
    expect(manage.getAttribute('href')).toBe('https://github.com/settings/installations/9')
    expect(screen.queryByRole('link', { name: 'Install the App' })).toBeNull()
    expect(screen.getByText(/already reaches every repository of paulo/)).toBeDefined()
    expect(screen.getByText(/signed in as any other account, GitHub answers 404/)).toBeDefined()
  })

  it('offers to choose repositories, and says nothing about "already reaches", when the App was given only some', async () => {
    serve({
      'GET /api/panel/repositories': repos({
        installations: [
          {
            account: 'acme',
            selection: 'selected',
            url: 'https://github.com/organizations/acme/settings/installations/2',
          },
        ],
      }),
    })
    mount()
    await waitFor(() => expect(screen.getByText('paulo/app')).toBeDefined())
    expect(
      screen
        .getByRole('link', { name: 'Choose which repositories the App reaches (acme)' })
        .getAttribute('href'),
    ).toBe('https://github.com/organizations/acme/settings/installations/2')
    expect(screen.queryByText(/already reaches every repository/)).toBeNull()
  })

  it('enables a repository through the API, with the header the server asks for', async () => {
    serve({
      'GET /api/panel/repositories': repos(),
      'PUT /api/panel/repositories/paulo/other': { fullName: 'paulo/other' },
    })
    mount()
    await waitFor(() => expect(screen.getByText('paulo/other')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/api/panel/repositories/paulo/other',
      body: { enabled: true },
      csrf: '1',
    })
  })

  it('shows the reason when an enable is refused', async () => {
    serve({
      'GET /api/panel/repositories': repos(),
      'PUT /api/panel/repositories/paulo/other': refusal(
        'paulo/other is not one of the repositories the GitHub App can reach',
      ),
    })
    mount()
    await waitFor(() => expect(screen.getByText('paulo/other')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('can reach'))
  })

  it('shows the settings of an enabled repository and saves them as the API expects', async () => {
    serve({
      'GET /api/panel/repositories': repos(),
      'PUT /api/panel/repositories/paulo/app': { fullName: 'paulo/app' },
    })
    mount()
    await waitFor(() => expect(screen.getByText('Save settings')).toBeDefined())
    expect((screen.getByLabelText(/Checks, one per line/) as HTMLTextAreaElement).value).toBe(
      'unit: pnpm test',
    )
    expect((screen.getByLabelText(/Extra domains/) as HTMLTextAreaElement).value).toBe('pypi.org')
    expect((screen.getByLabelText('Builder') as HTMLSelectElement).value).toBe('codex')

    fireEvent.change(screen.getByLabelText(/Checks, one per line/), {
      target: { value: 'unit: pnpm test\ntypes: pnpm typecheck' },
    })
    fireEvent.change(screen.getByLabelText(/Extra domains/), {
      target: { value: 'pypi.org, crates.io' },
    })
    fireEvent.change(screen.getByLabelText('Reviewer'), { target: { value: 'claude-code' } })
    fireEvent.change(screen.getByLabelText('Release'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      checks: [
        { name: 'unit', command: 'pnpm test' },
        { name: 'types', command: 'pnpm typecheck' },
      ],
      egress: ['pypi.org', 'crates.io'],
      harness: 'codex',
      reviewer: 'claude-code',
      releaseMode: null,
    })
  })

  it('sends null for checks when the box is emptied, so the default applies again', async () => {
    serve({
      'GET /api/panel/repositories': repos(),
      'PUT /api/panel/repositories/paulo/app': {},
    })
    mount()
    await waitFor(() => expect(screen.getByText('Save settings')).toBeDefined())
    fireEvent.change(screen.getByLabelText(/Checks, one per line/), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true))
    expect((calls.find((c) => c.method === 'PUT')?.body as { checks: unknown }).checks).toBeNull()
  })

  it('shows a refused save, and tells the owner to install the App when it reaches nothing', async () => {
    serve({
      'GET /api/panel/repositories': repos(),
      'PUT /api/panel/repositories/paulo/app': refusal('"x y" is not a domain name'),
    })
    mount()
    await waitFor(() => expect(screen.getByText('Save settings')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('"x y" is not a domain name'),
    )
    cleanup()

    serve({ 'GET /api/panel/repositories': repos({ repositories: [] }) })
    mount()
    await waitFor(() => expect(screen.getByText('The App reaches no repository yet')).toBeDefined())
    expect(screen.getByRole('link', { name: 'Install the App' })).toBeDefined()
  })

  it('says when GitHub could not be asked and marks a repository the App no longer reaches', async () => {
    const view = repos({ error: 'GitHub answered 502 listing repositories' })
    view.repositories[0].reachable = false
    serve({ 'GET /api/panel/repositories': view })
    mount()
    await waitFor(() => expect(screen.getByText('GitHub could not be asked')).toBeDefined())
    expect(screen.getByText('GitHub answered 502 listing repositories')).toBeDefined()
    expect(screen.getByText('App has no access')).toBeDefined()
  })
})

const plan = (over: Partial<PlanView> = {}): PlanView => ({
  id: 3,
  repository: 'paulo/app',
  goal: 'Add a command line',
  status: 'ready',
  summary: 'Two steps.',
  error: null,
  costUsd: 0.07,
  milestoneNumber: null,
  createdAt: '2026-11-04T10:00:00Z',
  items: [
    {
      id: 11,
      position: 0,
      title: 'Parse arguments',
      body: 'Read argv',
      selected: true,
      issueNumber: null,
      issueUrl: null,
      started: false,
    },
    {
      id: 12,
      position: 1,
      title: 'Print help',
      body: 'Usage',
      selected: true,
      issueNumber: null,
      issueUrl: null,
      started: false,
    },
  ],
  ...over,
})

function Where() {
  const location = useLocation()
  return <output aria-label="where">{location.pathname}</output>
}

describe('plans', () => {
  const mountList = () =>
    render(
      <MemoryRouter>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <PlansPage />
                <Where />
              </>
            }
          />
          <Route path="/plans/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )

  it('sends the owner to enable a repository when none is enabled', async () => {
    serve({
      'GET /api/panel/repositories': repos({ repositories: [] }),
      'GET /api/panel/plans': { plans: [] },
    })
    mountList()
    await waitFor(() => expect(screen.getByText('Enable a repository first')).toBeDefined())
    expect(screen.getByText('No plan yet.')).toBeDefined()
    expect(screen.queryByText('Make a plan')).toBeNull()
  })

  it('makes a plan from a goal for an enabled repository and opens it', async () => {
    serve({
      'GET /api/panel/repositories': repos(),
      'GET /api/panel/plans': {
        plans: [plan({ id: 2, status: 'created', goal: 'An older goal' })],
      },
      'POST /api/panel/plans': { planId: 9 },
    })
    mountList()
    await waitFor(() => expect(screen.getByLabelText('Repository')).toBeDefined())
    expect(
      within(screen.getByLabelText('Repository'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['paulo/app'])
    expect(screen.getByText('An older goal')).toBeDefined()
    expect(screen.getByText('issues created')).toBeDefined()

    const button = screen.getByRole('button', { name: 'Make a plan' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Goal'), {
      target: { value: 'Add a command line with a help screen' },
    })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByLabelText('where').textContent).toBe('/plans/9'))
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/panel/plans',
      body: { repository: 'paulo/app', goal: 'Add a command line with a help screen' },
      csrf: '1',
    })
  })

  it('shows why a plan was refused, and stays on the page', async () => {
    serve({
      'GET /api/panel/repositories': repos(),
      'GET /api/panel/plans': { plans: [] },
      'POST /api/panel/plans': refusal(
        'paulo/app is not enabled: enable it under Repositories first',
      ),
    })
    mountList()
    await waitFor(() => expect(screen.getByLabelText('Goal')).toBeDefined())
    fireEvent.change(screen.getByLabelText('Goal'), {
      target: { value: 'Add a command line with a help screen' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Make a plan' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('is not enabled'))
    expect(screen.getByLabelText('where').textContent).toBe('/')
  })
})

describe('a plan', () => {
  const mount = (id = 3) =>
    render(
      <MemoryRouter initialEntries={[`/plans/${id}`]}>
        <Routes>
          <Route path="/plans/:planId" element={<PlanPage />} />
        </Routes>
      </MemoryRouter>,
    )

  it('says an agent is reading the repository while it plans, with no buttons yet', async () => {
    serve({ 'GET /api/panel/plans/3': plan({ status: 'planning', summary: '', items: [] }) })
    mount()
    await waitFor(() =>
      expect(screen.getByText('An agent is reading the repository')).toBeDefined(),
    )
    expect(screen.queryByRole('button', { name: 'Create issues' })).toBeNull()
  })

  it('shows why a plan failed', async () => {
    serve({
      'GET /api/panel/plans/3': plan({
        status: 'failed',
        error: 'the agent did not end with a usable plan',
        items: [],
      }),
    })
    mount()
    await waitFor(() => expect(screen.getByText('The plan did not come out')).toBeDefined())
    expect(screen.getByText('the agent did not end with a usable plan')).toBeDefined()
  })

  it('shows the draft to edit, and creates the issues after saving the edits', async () => {
    serve({
      'GET /api/panel/plans/3': plan(),
      'PUT /api/panel/plans/3/items': { ok: true },
      'POST /api/panel/plans/3/issues': { created: [101, 102], failure: null },
    })
    mount()
    await waitFor(() => expect(screen.getByLabelText('Title of issue 1')).toBeDefined())
    expect(screen.getByText('Two steps.')).toBeDefined()
    expect(screen.getByText('2 issues to create')).toBeDefined()

    fireEvent.change(screen.getByLabelText('Title of issue 2'), {
      target: { value: 'Print usage' },
    })
    fireEvent.click(screen.getByLabelText('Include issue 1'))
    expect(screen.getByText('1 issue to create')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Create issues and start' }))

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Created 2 issues and started them.'),
    )
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.body).toEqual({
      items: [
        { id: 11, title: 'Parse arguments', body: 'Read argv', selected: false },
        { id: 12, title: 'Print usage', body: 'Usage', selected: true },
      ],
    })
    expect(calls.find((c) => c.url.endsWith('/issues'))?.body).toEqual({ start: true })
    expect(
      calls.map((c) => c.method + ' ' + c.url).indexOf('PUT /api/panel/plans/3/items'),
    ).toBeLessThan(calls.map((c) => c.url).indexOf('/api/panel/plans/3/issues'))
  })

  it('creates the issues without starting them when asked to wait', async () => {
    serve({
      'GET /api/panel/plans/3': plan(),
      'POST /api/panel/plans/3/issues': { created: [101], failure: null },
    })
    mount()
    await waitFor(() => expect(screen.getByLabelText('Title of issue 1')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Create issues' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Created 1 issue.'))
    expect(calls.find((c) => c.url.endsWith('/issues'))?.body).toEqual({ start: false })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('says how far it got when GitHub refuses part of the way', async () => {
    serve({
      'GET /api/panel/plans/3': plan(),
      'POST /api/panel/plans/3/issues': {
        created: [101],
        failure: 'GitHub answered 502 creating an issue',
      },
    })
    mount()
    await waitFor(() => expect(screen.getByLabelText('Title of issue 1')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Create issues' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Created 1, then GitHub refused: GitHub answered 502 creating an issue',
      ),
    )
  })

  it('reorders and removes items before they are sent', async () => {
    serve({ 'GET /api/panel/plans/3': plan(), 'PUT /api/panel/plans/3/items': { ok: true } })
    mount()
    await waitFor(() => expect(screen.getByLabelText('Title of issue 1')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Move issue 1 down'))
    expect((screen.getByLabelText('Title of issue 1') as HTMLInputElement).value).toBe('Print help')
    expect((screen.getByLabelText('Move issue 1 up') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Remove issue 2'))
    expect(screen.queryByLabelText('Title of issue 2')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(
      (calls.find((c) => c.method === 'PUT')?.body as { items: { id: number }[] }).items.map(
        (i) => i.id,
      ),
    ).toEqual([12])
  })

  it('locks an item that is already an issue, links it, and starts it on request', async () => {
    const created = plan({
      status: 'created',
      items: [
        {
          id: 11,
          position: 0,
          title: 'Parse arguments',
          body: 'Read argv',
          selected: true,
          issueNumber: 101,
          issueUrl: 'https://github.com/paulo/app/issues/101',
          started: false,
        },
        {
          id: 12,
          position: 1,
          title: 'Print help',
          body: 'Usage',
          selected: true,
          issueNumber: 102,
          issueUrl: 'https://github.com/paulo/app/issues/102',
          started: true,
        },
      ],
    })
    serve({
      'GET /api/panel/plans/3': created,
      'POST /api/panel/plans/3/items/11/start': { ok: true },
    })
    mount()
    await waitFor(() => expect(screen.getByRole('link', { name: 'Issue #101' })).toBeDefined())
    expect((screen.getByLabelText('Title of issue 1') as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByLabelText('Remove issue 1')).toBeNull()
    expect(screen.getByText('started')).toBeDefined()
    expect(
      (screen.getByRole('button', { name: 'Create issues' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Start this one' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Started issue #101.'))
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/panel/plans/3/items/11/start',
      csrf: '1',
    })
  })

  it('shows an error when the plan cannot be loaded', async () => {
    serve({
      'GET /api/panel/plans/3': () =>
        new Response(JSON.stringify({ message: 'boom' }), { status: 500 }),
    })
    mount()
    await waitFor(() => expect(screen.getByText('boom')).toBeDefined())
  })
})

describe('a new job', () => {
  const open = async () => {
    render(<NewJob onCreated={created} />)
    fireEvent.click(screen.getByRole('button', { name: 'New job' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined())
  }
  const created = vi.fn()
  beforeEach(() => created.mockClear())

  it('asks for the repositories when it opens, and offers only the enabled ones', async () => {
    serve({ 'GET /api/panel/repositories': repos() })
    await open()
    await waitFor(() => expect(screen.getByLabelText('Repository')).toBeDefined())
    expect(
      within(screen.getByLabelText('Repository'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['paulo/app'])
    expect(calls.map((c) => c.url)).toEqual(['/api/panel/repositories'])
  })

  it('does not ask GitHub for anything until the dialog is opened', () => {
    serve({})
    render(<NewJob onCreated={created} />)
    expect(calls).toEqual([])
  })

  it('opens the issue and reports it, starting it unless the owner unchecks the box', async () => {
    serve({
      'GET /api/panel/repositories': repos(),
      'POST /api/panel/jobs': {
        repository: 'paulo/app',
        number: 14,
        url: 'https://github.com/paulo/app/issues/14',
        started: true,
      },
    })
    await open()
    await waitFor(() => expect(screen.getByLabelText('Repository')).toBeDefined())
    const button = screen.getByRole('button', { name: 'Create job' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Add truncate' } })
    fireEvent.change(screen.getByLabelText(/What should it do/), { target: { value: 'Write it.' } })
    fireEvent.click(button)

    await waitFor(() => expect(created).toHaveBeenCalledOnce())
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/panel/jobs',
      body: { repository: 'paulo/app', title: 'Add truncate', body: 'Write it.', start: true },
      csrf: '1',
    })
    expect(created.mock.calls[0][0]).toMatchObject({ number: 14, started: true })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('can leave the issue waiting, and shows a refusal inside the dialog', async () => {
    serve({
      'GET /api/panel/repositories': repos(),
      'POST /api/panel/jobs': refusal(
        'paulo/app is not enabled: enable it under Repositories first',
      ),
    })
    await open()
    await waitFor(() => expect(screen.getByLabelText('Repository')).toBeDefined())
    fireEvent.click(screen.getByLabelText('Start now'))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Later' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create job' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('is not enabled'))
    expect((calls.find((c) => c.method === 'POST')?.body as { start: boolean }).start).toBe(false)
    expect(screen.getByRole('dialog')).toBeDefined()
    expect(created).not.toHaveBeenCalled()
  })

  it('tells the owner to enable a repository when there is none', async () => {
    serve({ 'GET /api/panel/repositories': repos({ repositories: [] }) })
    await open()
    await waitFor(() =>
      expect(screen.getByText(/Enable a repository under Repositories first/)).toBeDefined(),
    )
    expect(
      screen.queryByRole('button', { name: 'Create job' }) as HTMLButtonElement | null,
    ).toMatchObject({ disabled: true })
  })
})
