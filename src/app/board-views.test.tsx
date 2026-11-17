// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskCard, TaskDetail } from '../shared/panel'

import { en } from './lib/copy/en'
import Page from './work/page'

const card = (id: number, over: Partial<TaskCard> = {}): TaskCard => ({
  id,
  repository: 'paulo/app',
  issueNumber: id,
  title: `Task ${id}`,
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
  waitingForChecks: false,
  resolved: false,
  retryable: null,
  retryAt: null,
  preRelease: null,
  release: null,
  mainRed: false,
  releaseWait: null,
  ...over,
})

const detailOf = (id: number): TaskDetail => ({
  task: card(id, { title: `Detail of ${id}` }),
  timeline: [],
  evidence: [],
  reviews: [],
  plans: [],
  questions: [],
  decisions: [],
  deliveries: [],
  watches: [],
  runs: [],
})

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const one = /\/api\/panel\/tasks\/(\d+)$/.exec(url)
      const body = one
        ? detailOf(Number(one[1]))
        : {
            tasks: [
              card(1),
              card(2, { stage: 'done', column: 'review', title: 'Finished work', costUsd: 0.31 }),
            ],
          }
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Where() {
  const location = useLocation()
  return <output aria-label="where">{`${location.pathname}${location.search}`}</output>
}

const at = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Page />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )

const where = () => screen.getByLabelText('where').textContent

describe('board and list', () => {
  it('shows the same tasks as a table when the list is chosen', async () => {
    at('/work')
    await waitFor(() => expect(screen.getByText('Finished work')).toBeDefined())
    expect(screen.getAllByRole('region').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: en.work.list }))

    const table = screen.getByRole('table', { name: en.board.tasks })
    expect(within(table).getByText('Task 1')).toBeDefined()
    expect(within(table).getByText('Finished work')).toBeDefined()
    expect(within(table).getByText('$0.31')).toBeDefined()
    expect(screen.queryAllByRole('region')).toEqual([])
    expect(screen.getByRole('button', { name: en.work.list }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('remembers the choice after the page is loaded again', async () => {
    const first = at('/work')
    await waitFor(() => expect(screen.getByText('Task 1')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: en.work.list }))
    first.unmount()

    at('/work')
    await waitFor(() => expect(screen.getByRole('table', { name: en.board.tasks })).toBeDefined())
  })

  it('goes back to the board when that is chosen again', async () => {
    localStorage.setItem('aifactory.view', 'list')
    at('/work')
    await waitFor(() => expect(screen.getByRole('table', { name: en.board.tasks })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: en.work.board }))
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('region', { name: en.columns.review })).toBeDefined()
  })

  it('still switches when the browser refuses to store the choice', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    at('/work')
    await waitFor(() => expect(screen.getByText('Task 1')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: en.work.list }))
    expect(screen.getByRole('table', { name: en.board.tasks })).toBeDefined()
    vi.restoreAllMocks()
  })
})

describe('a task beside the board', () => {
  it('opens in a side panel when a card is chosen, and the board stays', async () => {
    at('/work')
    await waitFor(() => expect(screen.getByText('Task 1')).toBeDefined())

    fireEvent.click(screen.getByRole('link', { name: /Task 1/ }))

    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined())
    expect(where()).toBe('/work?task=1')
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByText('Detail of 1')).toBeDefined(),
    )
    expect(screen.getByText('Finished work')).toBeDefined()
  })

  it('opens from a task address, and closing it clears the address', async () => {
    at('/work?task=2')
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByText('Detail of 2')).toBeDefined(),
    )

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(where()).toBe('/work')
  })

  it('offers the whole page for the task, and has no side panel there', async () => {
    at('/work?task=2')
    await waitFor(() =>
      expect(screen.getByRole('link', { name: en.work.openInFull })).toBeDefined(),
    )
    fireEvent.click(screen.getByRole('link', { name: en.work.openInFull }))

    await waitFor(() => expect(screen.getByText('Detail of 2')).toBeDefined())
    expect(where()).toBe('/work?task=2&full=1')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('region', { name: en.columns.working })).toBeNull()
  })
})

describe('a task in full', () => {
  it('shows the task alone from ?full=1, and Escape goes back to the board', async () => {
    at('/work?task=1&full=1')
    await waitFor(() => expect(screen.getByText('Detail of 1')).toBeDefined())
    expect(screen.queryByText('Finished work')).toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(screen.getByText('Finished work')).toBeDefined())
    expect(where()).toBe('/work')
  })

  it('does not take Escape away from a field the person is typing in', async () => {
    at('/work?task=1&full=1')
    await waitFor(() => expect(screen.getByText('Detail of 1')).toBeDefined())
    const field = document.createElement('textarea')
    document.body.appendChild(field)

    fireEvent.keyDown(field, { key: 'Escape' })

    expect(where()).toBe('/work?task=1&full=1')
    field.remove()
  })

  it('has a link back to the board', async () => {
    at('/work?task=1&full=1')
    await waitFor(() =>
      expect(screen.getByRole('link', { name: en.work.backToBoard })).toBeDefined(),
    )
    fireEvent.click(screen.getByRole('link', { name: en.work.backToBoard }))
    await waitFor(() => expect(where()).toBe('/work'))
  })

  it('ignores a task address that is not a number', async () => {
    at('/work?task=abc')
    await waitFor(() => expect(screen.getByText('Task 1')).toBeDefined())
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
