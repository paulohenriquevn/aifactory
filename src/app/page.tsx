import type { TaskCard } from '../shared/panel'

import { Board } from './components/Board'
import { useResource } from './lib/live'

export default function Page() {
  const tasks = useResource<{ tasks: TaskCard[] }>('/api/panel/tasks')
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Board</h1>
      {tasks.error ? <p className="text-sm text-red-700">{tasks.error}</p> : null}
      {tasks.data ? (
        tasks.data.tasks.length === 0 ? (
          <p className="text-sm text-slate-500">
            No tasks yet. Put the <code>factory</code> label on an issue and it shows up here.
          </p>
        ) : (
          <Board tasks={tasks.data.tasks} />
        )
      ) : (
        <p className="text-sm text-slate-500">Loading…</p>
      )}
    </>
  )
}
