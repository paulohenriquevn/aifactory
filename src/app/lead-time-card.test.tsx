// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { LeadTime, TaskCard } from '../shared/panel'

import { Card } from './components/Board'

const task = (leadTime: LeadTime | null, over: Partial<TaskCard> = {}): TaskCard => ({
  id: 7,
  repository: 'paulo/app',
  issueNumber: 7,
  title: 'Task 7',
  stage: 'build',
  column: 'working',
  pullRequestUrl: null,
  headSha: null,
  costUsd: 0,
  attempts: 1,
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:05:00Z',
  leadTime,
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

const show = (card: TaskCard) =>
  render(
    <MemoryRouter>
      <Card task={card} />
    </MemoryRouter>,
  )

const border = (container: HTMLElement) =>
  container.querySelector('[data-lead-border]')?.getAttribute('data-lead-border') ?? null

afterEach(cleanup)

describe('the lead time on a card', () => {
  it('leaves the border alone while the task is on track', () => {
    const { container } = show(task({ minutes: 45, status: 'on_track', running: true }))

    expect(screen.getByText('Lead time 45m · On track')).toBeTruthy()
    expect(border(container)).toBe('on_track')
    expect(container.innerHTML).not.toMatch(/border-warning|border-destructive/)
  })

  it('turns the border amber while the task is at risk', () => {
    const { container } = show(task({ minutes: 190, status: 'at_risk', running: true }))

    expect(screen.getByText('Lead time 3h 10m · At risk')).toBeTruthy()
    expect(container.innerHTML).toMatch(/border-warning/)
  })

  it('turns the border red while the task is overdue', () => {
    const { container } = show(task({ minutes: 600, status: 'overdue', running: true }))

    expect(screen.getByText('Lead time 10h · Overdue')).toBeTruthy()
    expect(container.innerHTML).toMatch(/border-destructive/)
  })

  it('keeps the time it was delivered in, with no colored border, once the clock stopped', () => {
    const { container } = show(
      task(
        { minutes: 600, status: 'overdue', running: false },
        { stage: 'done', column: 'review' },
      ),
    )

    expect(screen.getByText('Delivered in 10h · Overdue')).toBeTruthy()
    expect(border(container)).toBeNull()
    expect(container.innerHTML).not.toMatch(/border-destructive|border-warning/)
  })

  it('shows no lead time for a cancelled task', () => {
    show(task(null, { stage: 'cancelled' }))

    expect(screen.queryByText(/Lead time|Delivered in/)).toBeNull()
  })
})
