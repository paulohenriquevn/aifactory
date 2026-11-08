import { Button, EmptyState, Sheet } from '@usetheo/ui'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import type { TaskCard } from '../../shared/panel'

import { Board, TaskList } from '../components/Board'
import { NewJob, type CreatedJob } from '../components/NewJob'
import { TaskDetailView } from '../components/TaskDetail'
import { useEscape } from '../lib/keys'
import { useResource } from '../lib/live'
import { useView } from '../lib/view'

/**
 * The board, or the list of the same tasks. A task opens beside them (`?task=7`), and `full=1` gives it
 * the whole page. Escape leaves the full view for the board, and the side panel closes on its own.
 */
export default function Page() {
  const tasks = useResource<{ tasks: TaskCard[] }>('/api/panel/tasks')
  const [view, setView] = useView()
  const [opened, setOpened] = useState<CreatedJob>()
  const [params, setParams] = useSearchParams()
  const open = Number(params.get('task')) || undefined
  const full = params.get('full') === '1'
  const close = () => setParams({})
  useEscape(() => {
    if (open && full) close()
  })

  if (open && full) {
    return (
      <TaskDetailView
        id={open}
        above={
          <Link to="/work" className="text-sm text-muted-foreground hover:text-foreground">
            ← Board
          </Link>
        }
      />
    )
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Board</h1>
        <div className="flex items-center gap-2">
          <NewJob onCreated={setOpened} />
          <div className="flex gap-1" role="group" aria-label="View">
            {(['board', 'list'] as const).map((v) => (
              <Button
                key={v}
                size="sm"
                variant={view === v ? 'primary' : 'secondary'}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {v === 'board' ? 'Board' : 'List'}
              </Button>
            ))}
          </div>
        </div>
      </div>
      {opened ? (
        <p role="status" className="mb-3 text-sm text-foreground">
          Opened{' '}
          <a
            href={opened.url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            issue #{opened.number}
          </a>
          {opened.started
            ? '. The factory picks it up in a moment.'
            : '. It waits until you start it.'}
        </p>
      ) : null}
      {tasks.error ? <p className="text-sm text-destructive">{tasks.error}</p> : null}
      {tasks.data ? (
        tasks.data.tasks.length === 0 ? (
          <EmptyState
            title="No tasks yet"
            description={
              <>
                Put the <code>factory</code> label on an issue and it shows up here. New here?{' '}
                <Link to="/setup" className="underline underline-offset-2">
                  Check the setup
                </Link>
                .
              </>
            }
          />
        ) : view === 'board' ? (
          <Board tasks={tasks.data.tasks} />
        ) : (
          <TaskList tasks={tasks.data.tasks} />
        )
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      <Sheet open={open !== undefined} onOpenChange={(next) => !next && close()}>
        <Sheet.Content side="right" className="w-full max-w-2xl overflow-y-auto">
          <Sheet.Header>
            <Sheet.Title className="sr-only">Task</Sheet.Title>
            <Sheet.Description className="sr-only">Details of the selected task</Sheet.Description>
            {open ? (
              <Link
                to={{ pathname: '/work', search: `?task=${open}&full=1` }}
                className="text-sm text-foreground underline underline-offset-2"
              >
                Open in full
              </Link>
            ) : null}
          </Sheet.Header>
          <Sheet.Body>{open ? <TaskDetailView id={open} /> : null}</Sheet.Body>
        </Sheet.Content>
      </Sheet>
    </>
  )
}
