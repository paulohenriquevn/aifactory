// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  FindingView,
  HealthReport,
  InboxItem,
  MetricsReport,
  TaskCard,
  TaskDetail,
  WatchView,
} from '../shared/panel'

import { TaskActions } from './components/TaskActions'
import { TaskDetailView } from './components/TaskDetail'
import { Transcript } from './components/Transcript'
import { CopyProvider, LANGUAGE_KEY } from './lib/copy'
import { en } from './lib/copy/en'
import { ptBR } from './lib/copy/pt-BR'
import HealthPage from './health/page'
import InboxPage from './inbox/page'
import { describeEvent, shortSha } from './lib/format'
import LoginPage from './login/page'
import TaskPage from './tasks/[id]/page'
import { WatchPanel } from './components/WatchPanel'
import { Card } from './components/Board'

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
  integrated: false,
  waitingForChecks: false,
  resolved: false,
  retryable: null,
  retryAt: null,
  preRelease: {
    tag: 'pre/7-abcdef1',
    url: 'https://github.com/paulo/app/releases/tag/pre%2F7-abcdef1',
  },
  release: null,
  mainRed: false,
  releaseWait: null,
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
  plans: [],
  questions: [],
  decisions: [],
  deliveries: [],
  watches: [],
  runs: [],
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

  it('marks a failed task resolved another way only with a note saying where', async () => {
    const failed = detail({
      task: { ...base, stage: 'failed', column: 'attention', headSha: null },
    })
    const calls = serve({ 'POST /api/panel/tasks/5/resolve': { decisionId: 3, sha: 'h' } })
    render(<TaskActions detail={failed} onDone={noop} />)
    const mark = screen.getByRole('button', { name: 'Mark as resolved' }) as HTMLButtonElement
    expect(mark.disabled).toBe(true)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fixed by hand in #1389.' } })
    fireEvent.click(mark)

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({
      url: '/api/panel/tasks/5/resolve',
      body: { note: 'Fixed by hand in #1389.' },
    })
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

  it('offers to start again a done task whose pull request was never merged, and only that one', () => {
    render(<TaskActions detail={detail()} onDone={noop} />)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
    expect(screen.queryByText('Resolved another way')).toBeNull()
    for (const task of [
      { ...base, integrated: true },
      { ...base, resolved: true },
    ]) {
      cleanup()
      render(<TaskActions detail={detail({ task })} onDone={noop} />)
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    }
  })

  it('says GitHub merges a pull request that waits for the repository checks', () => {
    render(
      <TaskActions detail={detail({ task: { ...base, waitingForChecks: true } })} onDone={noop} />,
    )
    expect(
      screen.getByText(/merges this pull request once the repository's required checks pass/),
    ).toBeDefined()
    cleanup()
    render(<TaskActions detail={detail()} onDone={noop} />)
    expect(screen.queryByText(/required checks pass/)).toBeNull()
  })

  it('does not offer to ask for changes on work that is already integrated', () => {
    const integrated = detail({ task: { ...base, integrated: true } })
    render(<TaskActions detail={integrated} onDone={noop} />)
    expect(screen.queryByText('Ask for changes')).toBeNull()
    expect(screen.getByRole('button', { name: 'Release' })).toBeDefined()
    cleanup()
    render(<TaskActions detail={detail()} onDone={noop} />)
    expect(screen.getByText('Ask for changes')).toBeDefined()
  })

  it('says a release promotes the pre-release branch, not a pull request', async () => {
    serve({ 'POST /api/panel/tasks/5/release': { tag: 'v1.0.0' } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<TaskActions detail={detail()} onDone={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(confirm.mock.calls[0][0]).toContain('pre-release branch')
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

  it('says the release waits for the release branch checks, and offers no second release meanwhile', () => {
    const releaseWait = {
      status: 'waiting' as const,
      pullRequestUrl: 'https://github.com/paulo/app/pull/381',
      checks: ['CI', 'SonarCloud Code Analysis'],
      reason: null,
    }
    render(
      <TaskActions
        detail={detail({ task: { ...base, integrated: true, releaseWait } })}
        onDone={noop}
      />,
    )
    expect(
      screen.getByText(/waits for the required checks of the release branch: CI, SonarCloud/),
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull()
  })

  it('shows why the last release did not happen, and offers it again', () => {
    const releaseWait = {
      status: 'refused' as const,
      pullRequestUrl: 'https://github.com/paulo/app/pull/381',
      checks: ['CI'],
      reason: 'the required check of main failed on the release pull request: CI',
    }
    render(
      <TaskActions
        detail={detail({ task: { ...base, integrated: true, releaseWait } })}
        onDone={noop}
      />,
    )
    expect(
      screen.getByText(
        /The last release did not happen: the required check of main failed on the release pull request: CI/,
      ),
    ).toBeDefined()
    expect(screen.getByRole('button', { name: 'Release' })).toBeDefined()
  })

  it('says the release waits when the server answers that it does', async () => {
    serve({
      'POST /api/panel/tasks/5/release': {
        awaitingChecks: ['CI'],
        pullRequestUrl: 'https://github.com/paulo/app/pull/381',
      },
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<TaskActions detail={detail()} onDone={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'The release waits for the checks of the release branch (CI): GitHub merges it once they pass.',
      ),
    )
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

  it('shows the latest plan the builder wrote, with its files and what it left out', async () => {
    const plan = {
      id: 1,
      baseSha: 'base000111',
      harness: 'codex',
      files: [{ path: 'src/old.js', why: 'x' }],
      order: [],
      risks: [],
      proof: [],
      outOfScope: [],
      at: '2026-11-04T10:01:00Z',
    }
    serve({
      'GET /api/panel/tasks/5': detail({
        plans: [
          plan,
          {
            ...plan,
            id: 2,
            files: [{ path: 'src/truncate.js', why: 'the function' }],
            order: ['test first'],
            outOfScope: ['the CLI flag'],
          },
        ],
      }),
    })
    renderTask()
    const region = await waitFor(() => screen.getByRole('region', { name: 'Plan' }))
    expect(region.textContent).toContain('src/truncate.js: the function')
    expect(region.textContent).toContain('the CLI flag')
    expect(region.textContent).toContain('the latest of 2')
    expect(region.textContent).not.toContain('src/old.js')
  })

  it('says when a task has no plan', async () => {
    serve({ 'GET /api/panel/tasks/5': detail() })
    renderTask()
    const region = await waitFor(() => screen.getByRole('region', { name: 'Plan' }))
    expect(region.textContent).toContain('No plan was written')
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

const watchView = (over: Partial<WatchView> = {}): WatchView => ({
  id: 3,
  sha: 'merge0001abcd',
  tag: 'v0.1.0',
  status: 'red',
  revertUrl: 'https://github.com/paulo/app/pull/9',
  detail: 'failing: ci',
  startedAt: '2026-11-04T10:30:00Z',
  endedAt: '2026-11-04T10:35:00Z',
  acknowledged: false,
  ...over,
})

describe('the default branch after a release', () => {
  it('shows a red one with the revert pull request, and says it was dealt with when asked', async () => {
    const calls = serve({ 'POST /api/panel/watches/3/handled': { watchId: 3 } })
    const onDone = vi.fn()
    render(<WatchPanel watches={[watchView()]} onDone={onDone} />)

    expect(screen.getByText('the default branch went red')).toBeDefined()
    expect(screen.getByText('failing: ci')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Revert pull request' }).getAttribute('href')).toBe(
      'https://github.com/paulo/app/pull/9',
    )
    fireEvent.click(screen.getByRole('button', { name: 'I dealt with it' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(calls).toEqual([{ url: '/api/panel/watches/3/handled', method: 'POST', csrf: '1' }])
  })

  it('says plainly when no revert could be opened, and has no button once it was dealt with', () => {
    render(
      <WatchPanel
        watches={[watchView({ revertUrl: null, acknowledged: true })]}
        onDone={() => {}}
      />,
    )
    expect(screen.getByText('No revert pull request could be opened.')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'I dealt with it' })).toBeNull()
    expect(screen.getByText('dealt with')).toBeDefined()
  })

  it('shows a green or silent watch without actions, and nothing when there is none', () => {
    const { container, rerender } = render(<WatchPanel watches={[]} onDone={() => {}} />)
    expect(container.textContent).toBe('')
    rerender(
      <WatchPanel
        watches={[watchView({ status: 'green', revertUrl: null, detail: null })]}
        onDone={() => {}}
      />,
    )
    expect(screen.getByText('the default branch stayed green')).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
    rerender(
      <WatchPanel
        watches={[watchView({ status: 'silent', detail: 'no check reported' })]}
        onDone={() => {}}
      />,
    )
    expect(screen.getByText('no verdict: the checks never reported')).toBeDefined()
  })

  it('marks the card of a task whose release broke the default branch', () => {
    render(
      <MemoryRouter>
        <Card task={{ ...base, mainRed: true }} />
      </MemoryRouter>,
    )
    expect(screen.getByText('main is red after the release')).toBeDefined()
  })

  it('lists a red default branch in the inbox', async () => {
    serve({
      'GET /api/panel/inbox': {
        items: [
          {
            task: base,
            kind: 'main_red',
            summary: 'The default branch went red after v0.1.0.',
            at: '2026-11-04T10:35:00Z',
          },
        ],
      },
    })
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('The default branch is red')).toBeDefined())
  })
})

const report = (over: Partial<HealthReport> = {}): HealthReport => ({
  cost: {
    last24HoursUsd: 0.42,
    last7DaysUsd: 1.5,
    totalUsd: 3.2,
    tasks: 4,
    avgPerTaskUsd: 0.8,
    groups: [
      {
        harness: 'claude-code',
        role: 'builder',
        runs: 5,
        reportedRuns: 5,
        costUsd: 2.1,
        avgDurationMs: 31_000,
        failed: 1,
        quota: 0,
      },
      {
        harness: 'codex',
        role: 'reviewer',
        runs: 3,
        reportedRuns: 0,
        costUsd: 0,
        avgDurationMs: 12_000,
        failed: 0,
        quota: 2,
      },
    ],
  },
  findings: [],
  ...over,
})

const found = (over: Partial<FindingView>): FindingView => ({
  id: 1,
  kind: 'stalled',
  subject: 'run',
  taskId: 5,
  taskTitle: 'Add truncate',
  ref: null,
  detail: 'in build and silent for 50 minutes',
  firstSeenAt: '2026-11-04T10:00:00Z',
  lastSeenAt: '2026-11-04T10:50:00Z',
  ...over,
})

const metricsReport: MetricsReport = {
  rows: [
    {
      metric: 'cost_per_delivery',
      label: 'Cost per delivered run',
      unit: 'usd',
      worse: 'up',
      repository: '*',
      day: '2026-11-08',
      value: 5,
      samples: 3,
      mean: 1,
      sd: 0.1,
      band: 'act',
      rules: ['beyond_3_sigma'],
    },
    {
      metric: 'first_pass_checks',
      label: 'First-pass checks',
      unit: 'share',
      worse: 'down',
      repository: 'paulo/app',
      day: '2026-11-08',
      value: 0.75,
      samples: 4,
      mean: null,
      sd: null,
      band: 'no_baseline',
      rules: [],
    },
  ],
  byAgent: { approval: [], rework: [], reviewerRework: [], cost: [] },
  signals: [
    {
      metric: 'cost_per_delivery',
      label: 'Cost per delivered run',
      repository: '*',
      day: '2026-11-08',
      rule: 'beyond_3_sigma',
      tier: 'act',
      value: 5,
      mean: 1,
      sd: 0.1,
      issueUrl: 'https://github.com/paulohenriquevn/aifactory/issues/40',
      error: null,
    },
  ],
}

describe('health metrics', () => {
  it('shows each indicator against its band and links the issue a signal opened', async () => {
    serve({ 'GET /api/panel/health': report(), 'GET /api/panel/metrics': metricsReport })
    render(
      <MemoryRouter>
        <HealthPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('issue opened')).toBeDefined())
    expect(screen.getAllByText('Cost per delivered run')).toHaveLength(2)
    expect(screen.getAllByText('All repositories').length).toBeGreaterThan(0)
    expect(screen.getByText('$1.00 ± $0.10')).toBeDefined()
    expect(screen.getByText('75%')).toBeDefined()
    expect(screen.getByText('no baseline yet')).toBeDefined()
    expect(screen.getByRole('link', { name: 'issue' }).getAttribute('href')).toBe(
      'https://github.com/paulohenriquevn/aifactory/issues/40',
    )
  })

  it('says when there is nothing to measure yet', async () => {
    serve({
      'GET /api/panel/health': report(),
      'GET /api/panel/metrics': {
        rows: [],
        signals: [],
        byAgent: { approval: [], rework: [], reviewerRework: [], cost: [] },
      },
    })
    render(
      <MemoryRouter>
        <HealthPage />
      </MemoryRouter>,
    )

    await waitFor(() =>
      expect(screen.getByText('Not enough finished work to measure yet.')).toBeDefined(),
    )
  })
})

describe('health', () => {
  it('shows what the factory costs, per agent and role, and says when an agent reports no cost', async () => {
    serve({ 'GET /api/panel/health': report() })
    render(
      <MemoryRouter>
        <HealthPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('$0.42')).toBeDefined())
    expect(screen.getByText('$3.20')).toBeDefined()
    expect(screen.getByText('Per task (4)')).toBeDefined()
    expect(screen.getByText('claude-code')).toBeDefined()
    expect(screen.getByText('$2.10')).toBeDefined()
    expect(screen.getByText('31.0 s')).toBeDefined()
    expect(screen.getByText('not reported')).toBeDefined()
    expect(screen.getByText('Nothing is wrong with the factory right now.')).toBeDefined()
  })

  it('shows a finding with its task and detail, and resolves it with the action for its kind', async () => {
    const calls = serve({
      'GET /api/panel/health': report({ findings: [found({})] }),
      'POST /api/panel/findings/1/resolve': { findingId: 1 },
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <MemoryRouter>
        <HealthPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('A run stopped moving')).toBeDefined())
    expect(screen.getByText('in build and silent for 50 minutes')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Add truncate' }).getAttribute('href')).toBe('/tasks/5')
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/panel/findings/1/resolve',
      body: { action: 'retry' },
      csrf: '1',
    })
  })

  it('does not act when the person declines the confirmation', async () => {
    const calls = serve({
      'GET /api/panel/health': report({
        findings: [
          found({
            id: 2,
            kind: 'orphaned',
            subject: 'snapshot',
            taskId: null,
            taskTitle: null,
            ref: 'snap-1',
            detail: 'a snapshot of 823 MB',
          }),
        ],
      }),
    })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(
      <MemoryRouter>
        <HealthPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('A snapshot nothing needs')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Delete the snapshot' }))
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('offers each kind of finding its own action, and shows a refusal', async () => {
    serve({
      'GET /api/panel/health': report({
        findings: [
          found({
            id: 3,
            kind: 'orphaned',
            subject: 'answer_resume',
            ref: '4',
            detail: 'answered long ago',
          }),
          found({ id: 4, kind: 'orphaned', subject: 'revert', detail: 'never confirmed' }),
          found({ id: 5, kind: 'orphaned', subject: 'queued_run', detail: 'no job' }),
        ],
      }),
      'POST /api/panel/findings/3/resolve': () =>
        new Response(
          JSON.stringify({ error: 'refused', message: 'this question has nothing to resume' }),
          { status: 409 },
        ),
    })
    render(
      <MemoryRouter>
        <HealthPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume again' })).toBeDefined())
    expect(screen.getByRole('button', { name: 'Show it as red' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Start again' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Resume again' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('this question has nothing to resume'),
    )
  })

  it('shows the executions of a task, and a cost that was not reported as such', async () => {
    serve({
      'GET /api/panel/tasks/5': detail({
        runs: [
          {
            id: 1,
            role: 'builder',
            harness: 'claude-code',
            model: null,
            effort: null,
            tokensIn: null,
            tokensOut: null,
            attempt: 1,
            costUsd: 0.12,
            durationMs: 31_500,
            ok: true,
            quota: false,
            at: '2026-11-04T10:00:00Z',
          },
          {
            id: 2,
            role: 'reviewer',
            harness: 'codex',
            model: null,
            effort: null,
            tokensIn: null,
            tokensOut: null,
            attempt: 1,
            costUsd: null,
            durationMs: 9_000,
            ok: false,
            quota: true,
            at: '2026-11-04T10:01:00Z',
          },
        ],
      }),
    })
    renderTask()
    await waitFor(() => expect(screen.getByRole('region', { name: 'Executions' })).toBeDefined())
    expect(screen.getByText('$0.12')).toBeDefined()
    expect(screen.getByText('31.5 s')).toBeDefined()
    // The reviewer's cost, and the tokens of both passes.
    expect(screen.getAllByText('not reported')).toHaveLength(3)
    expect(screen.getByText('out of quota')).toBeDefined()
    expect(screen.getByText('finished')).toBeDefined()
  })

  it('shows which agent, model and effort built and reviewed, and the tokens each used', async () => {
    const run = {
      attempt: 1,
      costUsd: null,
      durationMs: 1000,
      ok: true,
      quota: false,
      at: '2026-11-04T10:00:00Z',
    }
    serve({
      'GET /api/panel/tasks/5': detail({
        reviews: [
          {
            id: 1,
            round: 1,
            sha: 'abcdef123456',
            reviewer: 'codex',
            verdict: 'approve',
            summary: 'fine',
            findings: [],
            at: '2026-11-04T10:04:00Z',
          },
        ],
        runs: [
          {
            ...run,
            id: 1,
            role: 'builder',
            harness: 'claude-code',
            model: 'opus',
            effort: 'high',
            tokensIn: 1200,
            tokensOut: 300,
          },
          {
            ...run,
            id: 2,
            role: 'reviewer',
            harness: 'codex',
            model: 'gpt-6.1-sol',
            effort: 'medium',
            tokensIn: null,
            tokensOut: null,
          },
        ],
      }),
    })
    renderTask()
    const runs = await screen.findByRole('region', { name: 'Executions' })
    const rows = within(runs).getAllByRole('row')
    expect(rows[1].textContent).toContain('claude-code')
    expect(rows[1].textContent).toContain('opus · high')
    expect(rows[1].textContent).toContain('1200 / 300')
    expect(rows[2].textContent).toContain('codex')
    expect(rows[2].textContent).toContain('gpt-6.1-sol · medium')
    const reviews = screen.getByRole('region', { name: 'Reviews' })
    expect(reviews.textContent).toContain('codex on abcdef1')
    expect(reviews.textContent).toContain('gpt-6.1-sol · medium')
  })

  it('says a pass from before the model was recorded is unknown, and one on the default is the default', async () => {
    const run = {
      role: 'builder' as const,
      harness: 'claude-code',
      tokensIn: null,
      tokensOut: null,
      attempt: 1,
      costUsd: null,
      durationMs: 1000,
      ok: true,
      quota: false,
      at: '2026-11-04T10:00:00Z',
    }
    serve({
      'GET /api/panel/tasks/5': detail({
        runs: [
          { ...run, id: 1, model: null, effort: null },
          { ...run, id: 2, model: 'default', effort: 'default' },
        ],
      }),
    })
    renderTask()
    const runs = await screen.findByRole('region', { name: 'Executions' })
    const rows = within(runs).getAllByRole('row')
    expect(rows[1].textContent).toContain('not recorded')
    expect(rows[1].textContent).not.toContain('default')
    expect(rows[2].textContent).toContain('default')
    expect(rows[2].textContent).not.toContain('not recorded')
  })

  it('gives each review the model of its own pass, also after a retry restarted the attempts', async () => {
    const run = {
      role: 'reviewer' as const,
      harness: 'codex',
      effort: null,
      tokensIn: null,
      tokensOut: null,
      attempt: 1,
      costUsd: null,
      durationMs: 1000,
      ok: true,
      quota: false,
    }
    const review = (id: number, at: string, sha: string) => ({
      id,
      round: 1,
      sha,
      reviewer: 'codex',
      verdict: 'approve' as const,
      summary: 'fine',
      findings: [],
      at,
    })
    serve({
      'GET /api/panel/tasks/5': detail({
        reviews: [
          review(1, '2026-11-04T10:04:00Z', 'aaaaaaa1111'),
          review(2, '2026-11-05T10:04:00Z', 'bbbbbbb2222'),
        ],
        runs: [
          { ...run, id: 1, model: 'gpt-6.1-terra', at: '2026-11-04T10:03:00Z' },
          { ...run, id: 2, model: 'gpt-6.1-sol', at: '2026-11-05T10:03:00Z' },
        ],
      }),
    })
    renderTask()
    const reviews = await screen.findByRole('region', { name: 'Reviews' })
    const [first, second] = within(reviews).getAllByRole('listitem')
    expect(first.textContent).toContain('gpt-6.1-terra')
    expect(first.textContent).not.toContain('gpt-6.1-sol')
    expect(second.textContent).toContain('gpt-6.1-sol')
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

describe('the task page in two languages', () => {
  const inLanguage = (language: 'en' | 'pt-BR', ui: React.ReactNode) => {
    window.localStorage.setItem(LANGUAGE_KEY, language)
    return render(
      <MemoryRouter>
        <CopyProvider>{ui}</CopyProvider>
      </MemoryRouter>,
    )
  }
  afterEach(() => window.localStorage.clear())

  for (const [language, t] of [
    ['en', en],
    ['pt-BR', ptBR],
  ] as const) {
    it(`shows the section headings of ${language}`, async () => {
      serve({
        'GET /api/panel/tasks/5': detail({ runs: [], deliveries: [] }),
        'GET /api/panel/tasks/5/transcript?after=0': { events: [], more: false },
      })
      inLanguage(language, <TaskDetailView id={5} />)
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: t.task.timeline })).toBeDefined(),
      )
      for (const name of [t.task.transcript, t.task.evidence, t.task.reviews]) {
        expect(screen.getByRole('heading', { name })).toBeDefined()
      }
      expect(screen.getByText(t.taskActions.approve)).toBeDefined()
    })

    it(`shows the empty transcript of ${language}`, async () => {
      serve({ 'GET /api/panel/tasks/5/transcript?after=0': { events: [], more: false } })
      inLanguage(language, <Transcript taskId={5} live={false} />)
      await waitFor(() => expect(screen.getByText(t.transcript.none)).toBeDefined())
      cleanup()
      inLanguage(language, <Transcript taskId={5} live />)
      await waitFor(() => expect(screen.getByText(t.transcript.waitingFirst)).toBeDefined())
    })
  }

  it('labels every action button of a handoff in Portuguese', () => {
    const handoff = detail({ task: { ...base, stage: 'handoff', column: 'attention' } })
    inLanguage('pt-BR', <TaskActions detail={handoff} onDone={() => {}} />)
    const t = ptBR.taskActions
    for (const name of [t.approve, t.retry, t.sendBack, t.markResolved]) {
      expect(screen.getByRole('button', { name })).toBeDefined()
    }
    expect(screen.getByText(t.heading)).toBeDefined()
  })
})
