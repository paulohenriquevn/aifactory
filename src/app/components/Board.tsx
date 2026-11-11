import { Card as Surface, Table } from '@usetheo/ui'
import { Link } from 'react-router'

import { COLUMNS, type TaskCard } from '../../shared/panel'
import { ago, money, runsAgain } from '../lib/format'

import { StageBadge } from './Badges'

/** The board's address with a task open in the side panel. */
export const openTask = (id: number) => ({ pathname: '/work', search: `?task=${id}` })

/** Every card on the board is this tall and as wide as its column, so the columns read as even stacks. */
export function Card({ task }: { task: TaskCard }) {
  return (
    <Link to={openTask(task.id)} className="block">
      <Surface size="sm" className="flex h-[152px] flex-col p-3 hover:border-primary/60">
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span
            className="min-w-0 flex-1 truncate"
            title={`${task.repository} #${task.issueNumber}`}
          >
            {task.repository.split('/').pop()} #{task.issueNumber}
          </span>
          <span className="shrink-0">
            {task.costUsd >= 0.005 ? `${money(task.costUsd)} · ` : ''}
            {ago(task.updatedAt)}
          </span>
        </div>
        <div title={task.title} className="mt-1 line-clamp-2 text-sm font-medium text-foreground">
          {task.title}
        </div>
        {task.mainRed ? (
          <div className="mt-1 truncate text-xs font-medium text-destructive">
            main is red after the release
          </div>
        ) : null}
        {task.retryAt ? (
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {runsAgain(task.retryAt)}
          </div>
        ) : null}
        {task.attempts > 1 ? (
          <div className="mt-1 truncate text-xs text-muted-foreground">
            attempt {task.attempts} of 3
          </div>
        ) : null}
        <div className="mt-auto">
          <StageBadge
            stage={task.stage}
            integrated={task.integrated}
            waitingForChecks={task.waitingForChecks}
            resolved={task.resolved}
            retryable={task.retryable}
            wrap
          />
        </div>
      </Surface>
    </Link>
  )
}

/**
 * Every column is the same width, full or empty, and they share the room equally, so the board looks the
 * same however many tasks there are. None goes below this: under it the board scrolls instead.
 */
const COLUMN = 'minmax(150px, 1fr)'

function Column({ title, tasks }: { title: string; tasks: TaskCard[] }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="sticky top-0 z-10 mb-2 truncate bg-background pb-1 text-sm font-semibold text-foreground">
        {title} <span className="font-normal text-muted-foreground">{tasks.length}</span>
      </h2>
      <div className="space-y-2">
        {tasks.map((task) => (
          <Card key={task.id} task={task} />
        ))}
        {tasks.length === 0 ? <p className="text-xs text-muted-foreground">Nothing here.</p> : null}
      </div>
    </section>
  )
}

/**
 * The board: every column, always, side by side, with cards in them or not. It scrolls inside its own
 * frame when the screen is narrower than the columns need, so the sideways scrollbar stays at the bottom
 * of the screen where it can be found, and the column titles stay at the top.
 */
export function Board({ tasks }: { tasks: TaskCard[] }) {
  return (
    <div className="max-h-[calc(100vh-170px)] overflow-auto pb-2">
      {/* The columns are as tall as the tallest: a title sticks only inside its own column, so a short one would let it go. */}
      <div
        className="grid gap-2.5"
        style={{ gridTemplateColumns: `repeat(${COLUMNS.length}, ${COLUMN})` }}
      >
        {COLUMNS.map((column) => (
          <Column
            key={column.id}
            title={column.title}
            tasks={tasks.filter((t) => t.column === column.id)}
          />
        ))}
      </div>
    </div>
  )
}

/** The same tasks as a table, for when the columns are too many to scan. */
export function TaskList({ tasks }: { tasks: TaskCard[] }) {
  return (
    <Table aria-label="Tasks">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>Task</Table.HeaderCell>
          <Table.HeaderCell>Repository</Table.HeaderCell>
          <Table.HeaderCell>Stage</Table.HeaderCell>
          <Table.HeaderCell align="right">Cost</Table.HeaderCell>
          <Table.HeaderCell align="right">Updated</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {tasks.map((task) => (
          <Table.Row key={task.id}>
            <Table.Cell>
              <Link to={openTask(task.id)} className="font-medium text-foreground hover:underline">
                {task.title}
              </Link>
              {task.mainRed ? (
                <span className="ml-2 text-xs font-medium text-destructive">main is red</span>
              ) : null}
            </Table.Cell>
            <Table.Cell>
              {task.repository} #{task.issueNumber}
            </Table.Cell>
            <Table.Cell>
              <StageBadge
                stage={task.stage}
                integrated={task.integrated}
                waitingForChecks={task.waitingForChecks}
                resolved={task.resolved}
                retryable={task.retryable}
              />
            </Table.Cell>
            <Table.Cell align="right" numeric>
              {money(task.costUsd)}
            </Table.Cell>
            <Table.Cell align="right">{ago(task.updatedAt)}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  )
}
