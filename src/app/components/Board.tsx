import { Card as Surface, Table } from '@usetheo/ui'
import { Link } from 'react-router'

import { COLUMNS, type TaskCard } from '../../shared/panel'
import { ago, money } from '../lib/format'

import { StageBadge } from './Badges'

/** The board's address with a task open in the side panel. */
export const openTask = (id: number) => ({ pathname: '/work', search: `?task=${id}` })

export function Card({ task }: { task: TaskCard }) {
  return (
    <Link to={openTask(task.id)} className="block">
      <Surface size="sm" className="p-3 hover:border-primary/60">
        <div className="text-xs text-muted-foreground">
          {task.repository} #{task.issueNumber}
        </div>
        <div className="mt-1 text-sm font-medium text-foreground">{task.title}</div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <StageBadge stage={task.stage} integrated={task.integrated} retryable={task.retryable} />
          <span className="text-xs text-muted-foreground">
            {money(task.costUsd)} · {ago(task.updatedAt)}
          </span>
        </div>
        {task.mainRed ? (
          <div className="mt-1 text-xs font-medium text-destructive">
            main is red after the release
          </div>
        ) : null}
        {task.attempts > 1 ? (
          <div className="mt-1 text-xs text-muted-foreground">attempt {task.attempts} of 3</div>
        ) : null}
      </Surface>
    </Link>
  )
}

export function Board({ tasks }: { tasks: TaskCard[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-7">
      {COLUMNS.map((column) => {
        const inColumn = tasks.filter((t) => t.column === column.id)
        return (
          <section key={column.id} aria-label={column.title} className="min-w-0">
            <h2 className="mb-2 text-sm font-semibold text-foreground">
              {column.title}{' '}
              <span className="font-normal text-muted-foreground">{inColumn.length}</span>
            </h2>
            <div className="space-y-2">
              {inColumn.map((task) => (
                <Card key={task.id} task={task} />
              ))}
              {inColumn.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing here.</p>
              ) : null}
            </div>
          </section>
        )
      })}
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
