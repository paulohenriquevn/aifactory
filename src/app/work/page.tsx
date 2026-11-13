import { Button, EmptyState, Sheet } from '@usetheo/ui'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import type { TaskCard } from '../../shared/panel'

import { Board, TaskList } from '../components/Board'
import { NewJob, type CreatedJob } from '../components/NewJob'
import { TaskDetailView } from '../components/TaskDetail'
import { useCopy } from '../lib/copy'
import { useEscape } from '../lib/keys'
import { useResource } from '../lib/live'
import { useView } from '../lib/view'

/**
 * The board, or the list of the same tasks. A task opens beside them (`?task=7`), and `full=1` gives it
 * the whole page. Escape leaves the full view for the board, and the side panel closes on its own.
 */
export default function Page() {
  const { t } = useCopy()
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
            {t.work.backToBoard}
          </Link>
        }
      />
    )
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t.work.board}</h1>
        <div className="flex items-center gap-2">
          <NewJob onCreated={setOpened} />
          <div className="flex gap-1" role="group" aria-label={t.work.viewGroup}>
            {(['board', 'list'] as const).map((v) => (
              <Button
                key={v}
                size="sm"
                variant={view === v ? 'primary' : 'secondary'}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {v === 'board' ? t.work.board : t.work.list}
              </Button>
            ))}
          </div>
        </div>
      </div>
      {opened ? (
        <p role="status" className="mb-3 text-sm text-foreground">
          {t.work.opened}{' '}
          <a
            href={opened.url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            {t.work.issue(opened.number)}
          </a>
          {opened.started ? t.work.startedNote : t.work.waitsNote}
        </p>
      ) : null}
      {tasks.error ? <p className="text-sm text-destructive">{tasks.error}</p> : null}
      {tasks.data ? (
        tasks.data.tasks.length === 0 ? (
          <EmptyState
            title={t.work.emptyTitle}
            description={
              <>
                {t.work.emptyPut} <code>factory</code> {t.work.emptyAfter}{' '}
                <Link to="/setup" className="underline underline-offset-2">
                  {t.work.checkSetup}
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
        <p className="text-sm text-muted-foreground">{t.layout.loading}</p>
      )}
      <Sheet open={open !== undefined} onOpenChange={(next) => !next && close()}>
        <Sheet.Content side="right" className="w-full max-w-2xl overflow-y-auto">
          <Sheet.Header>
            <Sheet.Title className="sr-only">{t.work.sheetTitle}</Sheet.Title>
            <Sheet.Description className="sr-only">{t.work.sheetDescription}</Sheet.Description>
            {open ? (
              <Link
                to={{ pathname: '/work', search: `?task=${open}&full=1` }}
                className="text-sm text-foreground underline underline-offset-2"
              >
                {t.work.openInFull}
              </Link>
            ) : null}
          </Sheet.Header>
          <Sheet.Body>{open ? <TaskDetailView id={open} /> : null}</Sheet.Body>
        </Sheet.Content>
      </Sheet>
    </>
  )
}
