import { Link } from 'react-router'

import type { InboxItem } from '../../shared/panel'
import { StageBadge } from '../components/Badges'
import { ago, money } from '../lib/format'
import { useResource } from '../lib/live'

const KIND: Record<InboxItem['kind'], string> = {
  question: 'Answer a question',
  review: 'Review the pull request',
  handoff: 'Needs a person',
  failed: 'Failed',
  main_red: 'The default branch is red',
}

export default function InboxPage() {
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  return (
    <>
      <h1 className="mb-4 text-xl font-semibold">Inbox</h1>
      {inbox.error ? <p className="text-sm text-destructive">{inbox.error}</p> : null}
      {inbox.data ? (
        inbox.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waits for you.</p>
        ) : (
          <ul className="space-y-2">
            {inbox.data.items.map(({ task, kind, summary, at }) => (
              <li key={task.id}>
                <Link
                  to={`/tasks/${task.id}`}
                  className="block rounded-lg border border-border bg-card p-4 shadow-sm hover:border-primary/60"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold">{KIND[kind]}</span>
                    <span className="text-xs text-muted-foreground">{ago(at)}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {task.repository} #{task.issueNumber} · {task.title}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{summary}</p>
                  <div className="mt-2 flex items-center gap-3">
                    <StageBadge
                      stage={task.stage}
                      integrated={task.integrated}
                      resolved={task.resolved}
                      retryable={task.retryable}
                    />
                    <span className="text-xs text-muted-foreground">{money(task.costUsd)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </>
  )
}
