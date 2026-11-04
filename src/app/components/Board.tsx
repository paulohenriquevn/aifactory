import { Link } from 'react-router'

import { COLUMNS, type TaskCard } from '../../shared/panel'
import { ago, money } from '../lib/format'

import { StageBadge } from './Badges'

export function Card({ task }: { task: TaskCard }) {
  return (
    <Link
      to={`/tasks/${task.id}`}
      className="block rounded-lg border border-slate-200 bg-white p-3 shadow-sm hover:border-slate-400"
    >
      <div className="text-xs text-slate-500">
        {task.repository} #{task.issueNumber}
      </div>
      <div className="mt-1 text-sm font-medium text-slate-900">{task.title}</div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <StageBadge stage={task.stage} />
        <span className="text-xs text-slate-500">
          {money(task.costUsd)} · {ago(task.updatedAt)}
        </span>
      </div>
      {task.mainRed ? (
        <div className="mt-1 text-xs font-medium text-red-700">main is red after the release</div>
      ) : null}
      {task.attempts > 1 ? (
        <div className="mt-1 text-xs text-slate-500">attempt {task.attempts} of 3</div>
      ) : null}
    </Link>
  )
}

export function Board({ tasks }: { tasks: TaskCard[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-6">
      {COLUMNS.map((column) => {
        const inColumn = tasks.filter((t) => t.column === column.id)
        return (
          <section key={column.id} aria-label={column.title} className="min-w-0">
            <h2 className="mb-2 text-sm font-semibold text-slate-700">
              {column.title} <span className="font-normal text-slate-400">{inColumn.length}</span>
            </h2>
            <div className="space-y-2">
              {inColumn.map((task) => (
                <Card key={task.id} task={task} />
              ))}
              {inColumn.length === 0 ? (
                <p className="text-xs text-slate-400">Nothing here.</p>
              ) : null}
            </div>
          </section>
        )
      })}
    </div>
  )
}
