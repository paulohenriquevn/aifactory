import { Card as Surface, Table } from '@usetheo/ui'
import { Link } from 'react-router'

import { COLUMNS, type TaskCard } from '../../shared/panel'
import { ago, money } from '../lib/format'

import { StageBadge } from './Badges'

/** The board's address with a task open in the side panel. */
export const openTask = (id: number) => ({ pathname: '/work', search: `?task=${id}` })

/** Every card on the board is this tall and as wide as its column, so the columns read as even stacks. */
export function Card({ task }: { task: TaskCard }) {
  return (
    <Link to={openTask(task.id)} className="block">
      <Surface size="sm" className="flex h-[140px] flex-col p-3 hover:border-primary/60">
        <div className="truncate text-xs text-muted-foreground">
          {task.repository} #{task.issueNumber}
        </div>
        <div title={task.title} className="mt-1 line-clamp-2 text-sm font-medium text-foreground">
          {task.title}
        </div>
        {task.mainRed ? (
          <div className="mt-1 truncate text-xs font-medium text-destructive">
            main is red after the release
          </div>
        ) : null}
        {task.attempts > 1 ? (
          <div className="mt-1 truncate text-xs text-muted-foreground">
            attempt {task.attempts} of 3
          </div>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-2">
          <StageBadge stage={task.stage} integrated={task.integrated} retryable={task.retryable} />
          <span className="shrink-0 text-xs text-muted-foreground">
            {task.costUsd >= 0.005 ? `${money(task.costUsd)} · ` : ''}
            {ago(task.updatedAt)}
          </span>
        </div>
      </Surface>
    </Link>
  )
}

/** A column is this wide whatever it holds. */
const COLUMN_WIDTH = 'w-[264px] shrink-0'

function Column({ title, tasks }: { title: string; tasks: TaskCard[] }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="mb-2 truncate text-sm font-semibold text-foreground">
        {title} <span className="font-normal text-muted-foreground">{tasks.length}</span>
      </h2>
      <div className="space-y-2">
        {tasks.map((task) => (
          <Card key={task.id} task={task} />
        ))}
      </div>
    </section>
  )
}

/**
 * The board. Only the columns that have cards are drawn, all the same width, side by side; the ones with
 * nothing in them are named in one line above, so none is hidden and none takes the width of a column of
 * cards. When there are more columns than the screen holds, the board scrolls sideways.
 */
export function Board({ tasks }: { tasks: TaskCard[] }) {
  const columns = COLUMNS.map((column) => ({
    ...column,
    tasks: tasks.filter((t) => t.column === column.id),
  }))
  const full = columns.filter((c) => c.tasks.length > 0)
  const empty = columns.filter((c) => c.tasks.length === 0)
  return (
    <div>
      {empty.length > 0 ? (
        <p aria-label="Empty columns" className="mb-3 text-xs text-muted-foreground">
          Nothing in: {empty.map((c) => c.title).join(' · ')}
        </p>
      ) : null}
      <div className="flex items-start gap-4 overflow-x-auto pb-3">
        {full.map((c) => (
          <div key={c.id} className={COLUMN_WIDTH}>
            <Column title={c.title} tasks={c.tasks} />
          </div>
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
