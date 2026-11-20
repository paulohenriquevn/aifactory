// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { TaskCard } from '../shared/panel'

import { Board, Card } from './components/Board'
import { CopyProvider, LANGUAGE_KEY } from './lib/copy'
import { en } from './lib/copy/en'
import { ptBR } from './lib/copy/pt-BR'

const task = (over: Partial<TaskCard> = {}): TaskCard => ({
  id: 7,
  repository: 'paulo/app',
  issueNumber: 7,
  title: 'Task 7',
  stage: 'intake',
  column: 'queued',
  pullRequestUrl: null,
  headSha: null,
  costUsd: 0,
  attempts: 1,
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:05:00Z',
  leadTime: null,
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

const NOTE = 'The pull request conflicts with workspace, which moved after this work was approved.'

const show = (node: React.ReactNode) =>
  render(
    <MemoryRouter>
      <CopyProvider>{node}</CopyProvider>
    </MemoryRouter>,
  )

afterEach(() => {
  window.localStorage.clear()
  cleanup()
})

describe('a card that went back from Delivered', () => {
  const returned = {
    reason: 'base_conflict' as const,
    at: new Date(Date.now() - 12 * 60_000).toISOString(),
    note: NOTE,
  }

  it('says why it went back, with the note as its tooltip and when it happened', () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'en')
    show(<Card task={task({ returned })} />)

    const mark = screen.getByText(en.board.returned.base_conflict, { exact: false })
    expect(mark.closest('[data-returned]')?.getAttribute('data-returned')).toBe('base_conflict')
    expect(mark.closest('[title]')?.getAttribute('title')).toContain(NOTE)
    expect(mark.closest('[data-returned]')?.textContent).toContain(en.time.minutesAgo(12))
  })

  it('is one compact line in normal case, cut to fit, so the card keeps its height', () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'en')
    show(<Card task={task({ returned })} />)

    const mark = document.querySelector('[data-returned]') as HTMLElement
    const inside = [mark, ...mark.querySelectorAll('*')].map((e) => e.getAttribute('class') ?? '')
    expect(inside.join(' ')).not.toMatch(/\buppercase\b/)
    expect(mark.className).toMatch(/\btruncate\b/)
    expect(mark.textContent).toBe(`${en.board.returned.base_conflict} · ${en.time.minutesAgo(12)}`)
  })

  it('says it in Portuguese too', () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'pt-BR')
    show(<Card task={task({ returned, stage: 'build', column: 'working' })} />)

    expect(screen.getByText(ptBR.board.returned.base_conflict, { exact: false })).toBeTruthy()
    expect(ptBR.board.returned.base_conflict).not.toBe(en.board.returned.base_conflict)
  })

  it('has a label in both languages for every reason', () => {
    for (const reason of ['base_conflict', 'ci_red', 'base_fixed', 'review', 'other'] as const) {
      expect(en.board.returned[reason]).toBeTruthy()
      expect(ptBR.board.returned[reason]).toBeTruthy()
    }
  })

  it('shows no mark on a card that never went back', () => {
    show(<Card task={task()} />)

    expect(document.querySelector('[data-returned]')).toBeNull()
  })
})

describe('approved work on its way to the integration branch', () => {
  const approved = (id: number, over: Partial<TaskCard>) =>
    task({ id, title: `Approved ${id}`, stage: 'done', column: 'merge', ...over })

  it('labels a card integrated, waiting for CI, or approved and waiting for its merge', () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'en')
    show(
      <>
        <Card task={approved(1, { integrated: true, column: 'review' })} />
        <Card task={approved(2, { waitingForChecks: true })} />
        <Card task={approved(3, {})} />
      </>,
    )

    expect(screen.getByText(en.stages.integrated)).toBeTruthy()
    expect(screen.getByText(en.stages.waitingForChecks)).toBeTruthy()
    expect(screen.getByText(en.stages.awaitingMerge)).toBeTruthy()
  })

  it('counts the Merge column by what its cards wait for, and leaves Delivered with its count', () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'pt-BR')
    show(
      <Board
        tasks={[
          approved(1, { integrated: true, column: 'review' }),
          approved(2, { waitingForChecks: true }),
          approved(3, { waitingForChecks: true }),
          approved(4, {}),
          approved(5, { stage: 'pr' }),
          task({ id: 6 }),
        ]}
      />,
    )

    const merge = within(screen.getByRole('region', { name: ptBR.columns.merge }))
    expect(
      merge.getByText(
        [
          ptBR.board.merge.opening_pr(1),
          ptBR.board.merge.waiting_for_checks(2),
          ptBR.board.merge.awaiting_merge(1),
        ].join(' · '),
      ),
    ).toBeTruthy()
    const delivered = screen.getByRole('region', { name: ptBR.columns.review })
    expect(delivered.textContent).not.toContain(ptBR.board.merge.awaiting_merge(1))
    expect(within(delivered).getByText('Approved 1')).toBeTruthy()
  })
})
