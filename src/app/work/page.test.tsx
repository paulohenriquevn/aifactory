// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StreamEvent, TaskCard } from '../../shared/panel'

import { CopyProvider } from '../lib/copy'
import { en } from '../lib/copy/en'
import { ptBR } from '../lib/copy/pt-BR'

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
  leadTime: { minutes: 5, status: 'on_track', running: true },
  approved: false,
  integrated: false,
  waitingForChecks: false,
  waitingOnBase: null,
  returned: null,
  queue: null,
  resolved: false,
  retryable: null,
  retryAt: null,
  preRelease: null,
  release: null,
  mainRed: false,
  releaseWait: null,
  working: null,
  lastAgent: null,
  ...over,
})

function serve(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  )
}

afterEach(() => {
  window.localStorage.clear()
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
    expect(inColumn(en.columns.working).getByText('Building one')).toBeDefined()
    expect(inColumn(en.columns.waiting).getByText('Asking one')).toBeDefined()
    expect(inColumn(en.columns.review).getByText('Done one')).toBeDefined()
    expect(inColumn(en.columns.attention).getByText('Broken one')).toBeDefined()
    expect(inColumn(en.columns.queued).getByText(en.board.nothingHere)).toBeDefined()
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
          retryAt: new Date(Date.now() + 2 * 3600_000 + 60_000).toISOString(),
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
    expect(inColumn(en.columns.retrying).getByText('Out of quota')).toBeDefined()
    expect(inColumn(en.columns.retrying).getByText(en.stages.waitingForLimit)).toBeDefined()
    expect(inColumn(en.columns.retrying).getByText(en.time.runsInHours(2))).toBeDefined()
    expect(inColumn(en.columns.retrying).getByText(en.stages.willRetry)).toBeDefined()
    expect(inColumn(en.columns.review).getByText(en.stages.integrated)).toBeDefined()
    expect(inColumn(en.columns.attention).getByText('Real failure')).toBeDefined()
    expect(inColumn(en.columns.attention).queryByText('Out of quota')).toBeNull()
  })

  it('always draws all eight columns, in the same order and the same width, with cards in them or not', async () => {
    serve({
      tasks: [
        card({ id: 1, title: 'Building one' }),
        card({ id: 4, title: 'Broken one', stage: 'failed', column: 'attention' }),
      ],
    })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Building one')).toBeDefined())
    const regions = screen.getAllByRole('region')
    expect(regions.map((r) => r.getAttribute('aria-label'))).toEqual([
      en.columns.queued,
      en.columns.working,
      en.columns.waiting,
      en.columns.retrying,
      en.columns.merge,
      en.columns.review,
      en.columns.released,
      en.columns.resolved,
      en.columns.attention,
    ])
    const grid = regions[0].parentElement as HTMLElement
    expect(grid.style.gridTemplateColumns).toBe('repeat(9, minmax(176px, 1fr))')
    for (const name of [
      en.columns.queued,
      en.columns.waiting,
      en.columns.retrying,
      en.columns.merge,
      en.columns.review,
      en.columns.released,
    ]) {
      expect(
        within(screen.getByRole('region', { name })).getByText(en.board.nothingHere),
        name,
      ).toBeDefined()
    }
    expect(
      within(screen.getByRole('region', { name: en.columns.attention })).queryByText(
        en.board.nothingHere,
      ),
    ).toBeNull()
    expect(screen.queryByLabelText('Empty columns')).toBeNull()
  })

  it('keeps every column title in view while the cards scroll, empty columns too, in a frame of its own', async () => {
    serve({ tasks: [card({ id: 1, title: 'Building one' })] })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Building one')).toBeDefined())
    const title = screen
      .getByRole('region', { name: en.columns.working })
      .querySelector('h2') as HTMLElement
    expect(title.className).toContain('sticky')
    const frame = screen.getByRole('region', { name: en.columns.working }).parentElement
      ?.parentElement as HTMLElement
    expect(frame.className).toContain('overflow-auto')
    expect(frame.className).toContain('max-h-')
    // A title sticks only inside its own column, so every column must be as tall as the tallest. With
    // `items-start` an empty one is short and its title scrolled away while the others stayed.
    const grid = screen.getByRole('region', { name: en.columns.working })
      .parentElement as HTMLElement
    expect(grid.className).not.toContain('items-start')
    for (const section of screen.getAllByRole('region')) {
      expect((section.querySelector('h2') as HTMLElement).className).toContain('sticky')
    }
  })

  it('starts every card at the same height and lets a long one grow, whatever its title', async () => {
    serve({
      tasks: [
        card({ id: 1, title: 'Short' }),
        card({ id: 2, title: 'A very long title '.repeat(20), attempts: 2 }),
      ],
    })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Short')).toBeDefined())
    const cards = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href')?.includes('?task='))
    expect(cards).toHaveLength(2)
    // Every card starts at the same height and grows with what it says, so nothing on it is cut.
    for (const c of cards) expect(c.querySelector('[class*="min-h-[168px]"]')).not.toBeNull()
    for (const c of cards) expect(c.querySelector('[class*=" h-["]')).toBeNull()
    expect(screen.getByText(/A very long title/).className).toContain('line-clamp-3')
    expect(screen.queryAllByText('paulo/app #7').length).toBe(0)
    expect(screen.getAllByText('app #7').length).toBe(2)
    expect(screen.getByText(/A very long title/).getAttribute('title')).toContain(
      'A very long title',
    )
  })

  it('says how to start when there are no tasks, and shows an error as one', async () => {
    serve({ tasks: [] })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText(en.work.emptyTitle)).toBeDefined())
  })

  it('shows the attempt a task is on once it is past the first', async () => {
    serve({ tasks: [card({ attempts: 2 })] })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText(en.board.attempt(2))).toBeDefined())
  })

  it('shows the queue in the order the worker serves it, the first ten ranked and the rest after them', async () => {
    const queued = (id: number, position: number | null) =>
      card({
        id,
        title: `Queued ${id}`,
        stage: 'intake',
        column: 'queued',
        queue: { position, reasons: null, readiness: null },
      })
    // Eleven in the line, given to the board out of order, and one held.
    const places = [11, 3, 1, 10, 2, 4, 5, 6, 7, 8, 9]
    serve({ tasks: [queued(100, null), ...places.map((p) => queued(p, p))] })
    render(
      <MemoryRouter>
        <CopyProvider>
          <Page />
        </CopyProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Queued 1')).toBeDefined())
    const column = within(screen.getByRole('region', { name: en.columns.queued }))
    const titles = column.getAllByText(/^Queued \d+$/).map((element) => element.textContent)
    expect(titles).toEqual([
      ...Array.from({ length: 11 }, (_, i) => `Queued ${i + 1}`),
      'Queued 100',
    ])
    expect(column.getByLabelText(en.board.topRank(1))).toBeDefined()
    expect(column.getByLabelText(en.board.topRank(10))).toBeDefined()
    expect(column.queryByLabelText(en.board.topRank(11))).toBeNull()
    expect(column.getByText(en.board.restOfQueue)).toBeDefined()
  })

  it('marks the priority of a queued task with a badge of its own', async () => {
    serve({
      tasks: [
        card({
          id: 1,
          title: 'Urgent one',
          stage: 'intake',
          column: 'queued',
          queue: { position: 1, reasons: { priority: 1, bug: true, unblocks: 0 }, readiness: null },
        }),
        card({
          id: 2,
          title: 'Unlabelled one',
          stage: 'intake',
          column: 'queued',
          queue: {
            position: 2,
            reasons: { priority: null, bug: false, unblocks: 0 },
            readiness: null,
          },
        }),
      ],
    })
    render(
      <MemoryRouter>
        <CopyProvider>
          <Page />
        </CopyProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Urgent one')).toBeDefined())
    const badge = screen.getByLabelText(en.board.priority(1))
    expect(badge.textContent).toBe(en.board.priorityBadge(1))
    expect(screen.getAllByText(/^P\d$/)).toHaveLength(1)
  })

  it('draws no line under the first ten when the queue is no longer than that', async () => {
    serve({
      tasks: [
        card({
          id: 1,
          title: 'Only one',
          stage: 'intake',
          column: 'queued',
          queue: { position: 1, reasons: null, readiness: null },
        }),
      ],
    })
    render(
      <MemoryRouter>
        <CopyProvider>
          <Page />
        </CopyProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Only one')).toBeDefined())
    expect(screen.queryByText(en.board.restOfQueue)).toBeNull()
  })

  it('writes the nine column titles in Portuguese, in the same order', async () => {
    window.localStorage.setItem('aifactory.language', 'pt-BR')
    serve({ tasks: [card({ id: 1, title: 'Building one' })] })
    render(
      <MemoryRouter>
        <CopyProvider>
          <Page />
        </CopyProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Building one')).toBeDefined())
    const order = [
      'queued',
      'working',
      'waiting',
      'retrying',
      'merge',
      'review',
      'released',
      'resolved',
      'attention',
    ] as const
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(
      order.map((id) => ptBR.columns[id]),
    )
    expect(ptBR.columns.merge).toBe('Merge')
    expect(screen.getByText(ptBR.stages.build)).toBeDefined()
  })

  it('shows approved work that is being merged in the Merge column, as merging', async () => {
    serve({ tasks: [card({ id: 1, title: 'Merging one', stage: 'merge', column: 'merge' })] })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Merging one')).toBeDefined())
    const column = within(screen.getByRole('region', { name: en.columns.merge }))
    expect(column.getByText('Merging one')).toBeDefined()
    expect(column.getByText(en.stages.merge)).toBeDefined()
  })
})

/** An `EventSource` the test speaks through, as the server's event stream would. */
class FakeStream {
  static last: FakeStream | undefined
  onmessage: ((message: { data: string }) => void) | null = null
  constructor() {
    FakeStream.last = this
  }
  close() {}
  send(event: StreamEvent) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

describe('the agent on a card', () => {
  it('names the agent, its model and its step on a running card', async () => {
    serve({
      tasks: [
        card({
          id: 1,
          stage: 'review',
          working: { step: 'reviewing', agent: 'codex', model: 'gpt-6.1-terra', attempt: 2 },
          lastAgent: { agent: 'codex', model: 'gpt-6.1-terra' },
        }),
      ],
    })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    const panel = await screen.findByLabelText('Codex · gpt-6.1-terra · reviewing · round 2')
    expect(panel.className).toContain('bg-info/10')
    expect(panel.querySelector('.bg-info.animate-pulse')).not.toBeNull()
    expect(screen.getByText('gpt-6.1-terra')).toBeDefined()
    expect(screen.getByText('reviewing · round 2')).toBeDefined()
    expect(screen.queryByLabelText(/^last:/)).toBeNull()
  })

  it('names the checks, and no agent, while the factory verifies', async () => {
    serve({
      tasks: [
        card({
          stage: 'verify',
          working: { step: 'checks', checks: ['tests'] },
          lastAgent: { agent: 'claude-code', model: 'opus' },
        }),
      ],
    })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    await screen.findByLabelText('checks · tests')
    expect(screen.queryByText(/Claude Code/)).toBeNull()
  })

  it('shows who worked last, more quietly, on a card that is not running', async () => {
    serve({
      tasks: [
        card({
          stage: 'done',
          column: 'review',
          lastAgent: { agent: 'claude-code', model: 'opus' },
        }),
      ],
    })
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    const last = await screen.findByLabelText('last: Claude Code · opus')
    // The agent keeps its color, so the harness reads at a glance, but the panel is not lit as a running one.
    expect(last.querySelector('.bg-primary')).not.toBeNull()
    expect(last.querySelector('.animate-pulse')).toBeNull()
    expect(last.className).not.toContain('bg-primary/10')
    expect(screen.getByText('last on it')).toBeDefined()
  })

  it('moves to the next agent by itself when the stream says the task changed stage', async () => {
    vi.stubGlobal('EventSource', FakeStream)
    const planning = card({
      stage: 'plan',
      working: { step: 'planning', agent: 'codex', model: 'gpt-6.1-terra', attempt: 1 },
    })
    const building = card({
      stage: 'build',
      working: { step: 'building', agent: 'claude-code', model: 'opus', attempt: 2 },
    })
    let served = planning
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ tasks: [served] }), { status: 200 })),
    )
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
    await screen.findByLabelText('Codex · gpt-6.1-terra · planning')

    served = building
    act(() =>
      FakeStream.last!.send({
        type: 'stage',
        taskId: 1,
        stage: 'build',
        at: new Date().toISOString(),
      }),
    )

    await screen.findByLabelText('Claude Code · opus · building · attempt 2')
  })

  it('writes the step in Portuguese', async () => {
    window.localStorage.setItem('aifactory.language', 'pt-BR')
    serve({
      tasks: [
        card({
          working: { step: 'fixing', agent: 'claude-code', model: 'opus', attempt: 2 },
        }),
      ],
    })
    render(
      <MemoryRouter>
        <CopyProvider>
          <Page />
        </CopyProvider>
      </MemoryRouter>,
    )
    await screen.findByLabelText('Claude Code · opus · corrigindo achados · tentativa 2')
  })
})
