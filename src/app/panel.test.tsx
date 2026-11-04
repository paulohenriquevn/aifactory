// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InboxItem, TaskCard, TaskDetail } from '../shared/panel'

import { TaskActions } from './components/TaskActions'
import InboxPage from './inbox/page'
import { describeEvent, shortSha } from './lib/format'
import LoginPage from './login/page'
import TaskPage from './tasks/[id]/page'

const base: TaskCard = {
  id: 5,
  repository: 'paulo/app',
  issueNumber: 7,
  title: 'Add truncate',
  stage: 'done',
  column: 'review',
  pullRequestUrl: 'https://github.com/paulo/app/pull/9',
  headSha: 'abcdef123456',
  costUsd: 0.2,
  attempts: 2,
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:05:00Z',
  approved: false,
  preRelease: {
    tag: 'pre/7-abcdef1',
    url: 'https://github.com/paulo/app/releases/tag/pre%2F7-abcdef1',
  },
  release: null,
}

const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  task: base,
  timeline: [
    {
      id: 1,
      stage: 'build',
      at: '2026-11-04T10:00:00Z',
      detail: { harness: 'claude-code', attempt: 1 },
    },
    {
      id: 2,
      stage: 'done',
      at: '2026-11-04T10:05:00Z',
      detail: { pullRequestUrl: base.pullRequestUrl },
    },
  ],
  evidence: [
    {
      id: 1,
      name: 'test',
      command: 'npm test',
      sha: 'abcdef123456',
      passed: true,
      exitCode: 0,
      timedOut: false,
      durationMs: 1500,
      output: '# pass 6',
      at: '2026-11-04T10:03:00Z',
    },
  ],
  reviews: [
    {
      id: 1,
      round: 1,
      sha: 'abcdef123456',
      reviewer: 'claude-code',
      verdict: 'changes',
      summary: 'max=0 slips through',
      findings: [{ severity: 'major', file: 'src/t.js', issue: 'reject max below 1' }],
      at: '2026-11-04T10:04:00Z',
    },
  ],
  questions: [],
  decisions: [],
  deliveries: [],
  ...over,
})

type Call = { url: string; method: string; body?: unknown; csrf?: string }
function serve(routes: Record<string, unknown | (() => Response)>) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      calls.push({
        url,
        method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        csrf: (init.headers as Record<string, string> | undefined)?.['x-theo-action'],
      })
      const answer = routes[`${method} ${url}`]
      if (answer === undefined)
        return new Response(JSON.stringify({ message: 'no route' }), { status: 404 })
      return typeof answer === 'function'
        ? (answer as () => Response)()
        : new Response(JSON.stringify(answer), { status: 200 })
    }),
  )
  return calls
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderTask(id = 5) {
  render(
    <MemoryRouter initialEntries={[`/tasks/${id}`]}>
      <Routes>
        <Route path="/tasks/:id" element={<TaskPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('task page', () => {
  it('shows the timeline, the evidence with its output, and the review with its findings', async () => {
    serve({ 'GET /api/panel/tasks/5': detail() })
    renderTask()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Add truncate' })).toBeDefined())
    expect(screen.getByText('claude-code, attempt 1')).toBeDefined()
    expect(screen.getByText('npm test')).toBeDefined()
    expect(screen.getByText('passed')).toBeDefined()
    expect(screen.getByText('# pass 6')).toBeDefined()
    expect(screen.getByText('Attempt 1: changes')).toBeDefined()
    expect(screen.getByText(/reject max below 1/)).toBeDefined()
    expect(screen.getByText('abcdef1')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe(
      base.pullRequestUrl,
    )
  })

  it('shows a question and what to do about it, then the answer when there is one', async () => {
    serve({
      'GET /api/panel/tasks/5': detail({
        task: { ...base, stage: 'waiting', column: 'waiting', headSha: null },
        questions: [
          {
            id: 1,
            body: 'A or B?',
            askedAt: '2026-11-04T10:00:00Z',
            answer: null,
            answeredBy: null,
            answeredAt: null,
          },
          {
            id: 2,
            body: 'And C?',
            askedAt: '2026-11-04T10:10:00Z',
            answer: 'Yes',
            answeredBy: 'paulo',
            answeredAt: '2026-11-04T10:11:00Z',
          },
        ],
      }),
    })
    renderTask()
    await waitFor(() => expect(screen.getByText('A or B?')).toBeDefined())
    expect(screen.getByText(/Reply in a comment on the issue/)).toBeDefined()
    expect(screen.getByText('paulo answered: Yes')).toBeDefined()
  })

  it('says it could not load a task that is not there', async () => {
    serve({})
    renderTask(99)
    await waitFor(() => expect(screen.getByText('no route')).toBeDefined())
  })
})

describe('task actions', () => {
  const noop = () => {}

  it('approves the commit, with the header the server asks for', async () => {
    const calls = serve({ 'POST /api/panel/tasks/5/approve': { sha: 'abc' } })
    const onDone = vi.fn()
    render(<TaskActions detail={detail()} onDone={onDone} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve this commit' }))

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Approved at this commit.'),
    )
    expect(calls).toEqual([{ url: '/api/panel/tasks/5/approve', method: 'POST', csrf: '1' }])
    expect(onDone).toHaveBeenCalled()
  })

  it('shows an approved commit as approved and does not offer it again', () => {
    render(<TaskActions detail={detail({ task: { ...base, approved: true } })} onDone={noop} />)
    expect((screen.getByRole('button', { name: 'Approved' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('sends changes back only with a note', async () => {
    const calls = serve({ 'POST /api/panel/tasks/5/changes': { decisionId: 1 } })
    render(<TaskActions detail={detail()} onDone={noop} />)
    const send = screen.getByRole('button', { name: 'Send back' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Rename the helper.' } })
    expect(send.disabled).toBe(false)
    fireEvent.click(send)

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({
      url: '/api/panel/tasks/5/changes',
      body: { note: 'Rename the helper.' },
    })
  })

  it('shows the reason when the server refuses', async () => {
    serve({
      'POST /api/panel/tasks/5/approve': () =>
        new Response(
          JSON.stringify({
            error: 'refused',
            message: 'only a task with a pull request can be approved',
          }),
          { status: 409 },
        ),
    })
    render(<TaskActions detail={detail()} onDone={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve this commit' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/only a task with a pull request/),
    )
  })

  it('offers a retry for a failed task, asks first, and has nothing for a running one', async () => {
    const failed = detail({
      task: { ...base, stage: 'failed', column: 'attention', headSha: null },
    })
    const calls = serve({ 'POST /api/panel/tasks/5/retry': { decisionId: 2 } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<TaskActions detail={failed} onDone={noop} />)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Approve this commit' })).toBeNull()

    cleanup()
    const running = detail({ task: { ...base, stage: 'build', column: 'working', headSha: null } })
    const { container } = render(<TaskActions detail={running} onDone={noop} />)
    expect(container.textContent).toBe('')
  })
})

describe('releasing from the panel', () => {
  const noop = () => {}

  it('offers a release for a delivered commit, asks first, and sends the version to bump', async () => {
    const calls = serve({ 'POST /api/panel/tasks/5/release': { tag: 'v1.3.0' } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<TaskActions detail={detail()} onDone={noop} />)

    fireEvent.change(screen.getByLabelText('Version bump'), { target: { value: 'minor' } })
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({
      url: '/api/panel/tasks/5/release',
      body: { bump: 'minor' },
      csrf: '1',
    })
    expect(confirm).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Released.'))
  })

  it('does not offer a release without a pre-release, or once released', () => {
    const none = detail({ task: { ...base, preRelease: null } })
    render(<TaskActions detail={none} onDone={noop} />)
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull()
    cleanup()
    const released = detail({
      task: {
        ...base,
        stage: 'released',
        column: 'released',
        release: { tag: 'v0.1.0', url: 'u' },
      },
    })
    const { container } = render(<TaskActions detail={released} onDone={noop} />)
    expect(container.textContent).toBe('')
  })

  it('shows the refusal when GitHub or the checks do not allow it', async () => {
    serve({
      'POST /api/panel/tasks/5/release': () =>
        new Response(
          JSON.stringify({
            error: 'refused',
            message: 'the pull request is a draft: mark it ready first',
          }),
          { status: 409 },
        ),
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<TaskActions detail={detail()} onDone={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/is a draft/))
  })

  it('shows the pre-release and the release on the task page, with who made each', async () => {
    serve({
      'GET /api/panel/tasks/5': detail({
        task: {
          ...base,
          release: { tag: 'v0.1.0', url: 'https://github.com/paulo/app/releases/tag/v0.1.0' },
        },
        deliveries: [
          {
            id: 1,
            kind: 'prerelease',
            tag: 'pre/7-abcdef1',
            url: 'https://x/pre',
            sha: 'abcdef123456',
            actor: 'factory',
            at: '2026-11-04T10:05:00Z',
          },
          {
            id: 2,
            kind: 'release',
            tag: 'v0.1.0',
            url: 'https://x/rel',
            sha: 'merge0001',
            actor: 'human',
            at: '2026-11-04T10:30:00Z',
          },
        ],
      }),
    })
    renderTask()
    await waitFor(() => expect(screen.getByRole('region', { name: 'Deliveries' })).toBeDefined())
    expect(screen.getByRole('link', { name: 'Release v0.1.0' })).toBeDefined()
    expect(screen.getByRole('link', { name: /Pre-release pre\/7-abcdef1/ })).toBeDefined()
    expect(screen.getByText(/by human/)).toBeDefined()
    expect(screen.getByText(/by factory/)).toBeDefined()
  })
})

describe('inbox', () => {
  it('lists what waits for a person with why, and says so when nothing does', async () => {
    const items: InboxItem[] = [
      {
        task: { ...base, id: 1, stage: 'waiting' },
        kind: 'question',
        summary: 'Should max count the ellipsis?',
        at: '2026-11-04T10:00:00Z',
      },
      {
        task: { ...base, id: 2, stage: 'failed' },
        kind: 'failed',
        summary: 'Out of quota. resets tomorrow',
        at: '2026-11-04T10:01:00Z',
      },
    ]
    serve({ 'GET /api/panel/inbox': { items } })
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Answer a question')).toBeDefined())
    expect(screen.getByText('Should max count the ellipsis?')).toBeDefined()
    expect(screen.getByText('Failed')).toBeDefined()

    cleanup()
    serve({ 'GET /api/panel/inbox': { items: [] } })
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Nothing waits for you.')).toBeDefined())
  })
})

describe('login', () => {
  it('sends the token and shows a wrong one as an error', async () => {
    const calls = serve({
      'POST /api/panel/login': () =>
        new Response(JSON.stringify({ error: 'login_refused', message: 'wrong token' }), {
          status: 401,
        }),
    })
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    )
    const button = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Panel token'), { target: { value: 'guess' } })
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('wrong token'))
    expect(calls[0]).toMatchObject({ url: '/api/panel/login', body: { token: 'guess' }, csrf: '1' })
  })
})

describe('describing events', () => {
  it('turns what the factory recorded into one line', () => {
    const at = '2026-11-04T10:00:00Z'
    const line = (stage: never, detail: Record<string, unknown> | null) =>
      describeEvent({ id: 1, stage, at, detail })
    expect(line('failed' as never, { quota: true, resetsAt: 'Nov 5th' })).toBe(
      'out of quota, resets Nov 5th',
    )
    expect(line('failed' as never, { failedAt: 'verify', error: 'no pull request' })).toBe(
      'verify: no pull request',
    )
    expect(line('verify' as never, { sha: 'abcdef123456', attempt: 2 })).toBe('abcdef1, attempt 2')
    expect(line('build' as never, { harness: 'codex', attempt: 2, rework: true })).toBe(
      'codex, attempt 2, rework',
    )
    expect(line('intake' as never, { decision: 'request_changes', note: 'rename it' })).toBe(
      'a person request changes: rename it',
    )
    expect(line('push' as never, null)).toBe('')
    expect(line('released' as never, { tag: 'v0.1.0', actor: 'human' })).toBe('v0.1.0 by human')
    expect(line('released' as never, { actor: 'human', releaseError: 'boom' })).toContain(
      'merged by human, but the release could not be created: boom',
    )
    expect(line('done' as never, { pullRequestUrl: 'u', preRelease: 'pre/7-abcdef1' })).toBe(
      'u\npre-release pre/7-abcdef1',
    )
    expect(shortSha(null)).toBe('')
  })
})
